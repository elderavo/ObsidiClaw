/**
 * OrchestratorSession — long-lived wrapper around a single pi agent session.
 *
 * Lifecycle per session:
 *   construction → [first prompt] → pi_session_created
 *               → [all prompts]   → agent_prompt_sent → agent_done
 *
 * Context injection is handled by the ObsidiClaw ExtensionFactory wired into
 * the DefaultResourceLoader. The extension intercepts before_agent_start on
 * every turn, runs RAG, and injects formattedContext into the system prompt —
 * no manual inject logic here.
 *
 * Logging:
 *   Every interface boundary emits a RunEvent to the RunLogger:
 *     prompt_received → pi_session_created (first prompt only)
 *     → agent_prompt_sent → [agent_turn_start/end, tool_call/result]
 *     → agent_done → prompt_complete
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";

import { RunLogger } from "../logger/index.js";
import type { ContextEngine } from "../context_engine/index.js";
import { createContextEngineMcpServer } from "../context_engine/index.js";
import { createObsidiClawExtension } from "../extension/factory.js";
import { createPiAgentSession } from "../shared/pi-session-factory.js";
import { resolvePaths } from "../shared/config.js";
import { extractMessageText } from "../shared/text-utils.js";
import { mapPiEventToRunEvent } from "../shared/pi-event-mapper.js";
import { runSessionReview, type ReviewTrigger } from "../insight_engine/session_review.js";
import type { RunEvent, RunId, RunKind, RunStage, SessionConfig, SessionId } from "./types.js";

// ---------------------------------------------------------------------------
// OrchestratorSession
// ---------------------------------------------------------------------------

export class OrchestratorSession {
  readonly sessionId: SessionId;

  /** pi SDK session — null until first prompt is received. */
  private piSession: AgentSession | null = null;
  private piSessionReady: boolean = false;

  /**
   * Current run ID — updated at the start of each prompt() call.
   * Used by the pi event subscription (subscribed once, references this field).
   */
  private currentRunId: RunId = "";

  private readonly runKind: RunKind;
  private readonly parentRunId?: string;
  private readonly parentSessionId?: string;

  constructor(
    private readonly logger: RunLogger,
    private readonly contextEngine?: ContextEngine,
    private readonly config: SessionConfig = {},
  ) {
    this.sessionId = crypto.randomUUID();
    // runKind takes precedence; fall back to isSubagent for backward compat
    this.runKind = config.runKind ?? (config.isSubagent ? "subagent" : "core");
    this.parentRunId = config.parentRunId;
    this.parentSessionId = config.parentSessionId;
    this.emit({ type: "session_start", sessionId: this.sessionId, timestamp: Date.now() });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Send a prompt to the pi agent.
   *
   * First call: creates the pi session (extension handles context injection).
   * Subsequent calls: reuses existing session; agent retains full conversation history.
   * Context injection runs on every turn via the before_agent_start extension hook.
   */
  async prompt(text: string): Promise<void> {
    const runId = crypto.randomUUID();
    this.currentRunId = runId;
    const startTime = Date.now();

    this.emit({ type: "prompt_received", sessionId: this.sessionId, runId, timestamp: Date.now(), text, isSubagent: this.runKind !== "core", runKind: this.runKind, parentRunId: this.parentRunId, parentSessionId: this.parentSessionId });

    try {
      // ── First prompt: create pi session ───────────────────────────────────
      if (!this.piSessionReady) {
        this.piSession = await this.createPiSession();
        this.piSessionReady = true;

        // Subscribe ONCE — handler references this.currentRunId which is updated
        // before each prompt(), so events are always attributed to the right run.
        this.piSession.subscribe((event) => this.handlePiEvent(event));

        this.emit({
          type: "pi_session_created",
          sessionId: this.sessionId,
          runId,
          timestamp: Date.now(),
          contextInjected: this.contextEngine !== undefined,
        });
      }

      // ── Send prompt to agent ──────────────────────────────────────────────
      // The ObsidiClaw extension intercepts before_agent_start, runs RAG, and
      // injects context into the system prompt before the agent loop starts.
      this.emit({ type: "agent_prompt_sent", sessionId: this.sessionId, runId, timestamp: Date.now() });

      await this.piSession!.prompt(text);
      await this.piSession!.agent.waitForIdle();

      this.emit({
        type: "prompt_complete",
        sessionId: this.sessionId,
        runId,
        timestamp: Date.now(),
        durationMs: Date.now() - startTime,
      });

    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.emit({ type: "prompt_error", sessionId: this.sessionId, runId, timestamp: Date.now(), error });
      throw err;
    }
  }

  /** Full message history from the pi session (undefined if session not started). */
  get messages() {
    return this.piSession?.messages ?? [];
  }

  /** Run ID from the most recent prompt() call. Empty string if none yet. */
  get lastRunId(): RunId {
    return this.currentRunId;
  }

  /** Current stage of the last prompt round-trip (for single-shot compat). */
  getLastStage(): RunStage {
    return this.piSessionReady ? "done" : "prompt_received";
  }

  /**
   * Preferred teardown: runs review (if enabled) then disposes.
   * Falls back to dispose() if review is skipped.
   */
  async finalize(trigger: ReviewTrigger = "session_end"): Promise<void> {
    if (this.runKind !== "core") {
      this.dispose();
      return;
    }
    try {
      await this.runReviewHook(trigger);
    } catch (err) {
      this.emit({ type: "diagnostic", sessionId: this.sessionId, runId: this.currentRunId, timestamp: Date.now(), module: "insight_engine", level: "error", message: `session_review failed: ${err instanceof Error ? err.message : String(err)}` } as RunEvent);
    } finally {
      this.dispose();
    }
  }

  dispose(): void {
    if (this.piSession) {
      this.piSession.dispose();
    }
    this.emit({ type: "session_end", sessionId: this.sessionId, timestamp: Date.now() });
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private emit(event: RunEvent): void {
    this.logger.logEvent(event);
  }

  /**
   * Handler for all pi session events — subscribed once at pi session creation.
   * References this.currentRunId which is updated per-prompt, so events from
   * any prompt in this session are attributed to the correct run.
   */
  private handlePiEvent(event: { type: string; [key: string]: unknown }): void {
    const runId = this.currentRunId;

    // Shared mapper handles agent_start, agent_end, turn_end, tool_execution_start/end
    const mapped = mapPiEventToRunEvent(event, this.sessionId, runId);
    if (mapped) {
      this.emit(mapped);
    }

    // Events that need session-specific handling beyond the shared mapper:
    switch (event.type) {
      case "message_update": {
        const assistantEvent = event["assistantMessageEvent"] as { type: string; delta?: string } | undefined;
        if (assistantEvent?.type === "text_delta" && this.config.onOutput) {
          this.config.onOutput(assistantEvent.delta ?? "");
        }
        break;
      }

      case "compaction": {
        void this.runReviewHook("pre_compaction", event);
        break;
      }

      default:
        break;
    }
  }

  /**
   * Run the review subagent for the given trigger. No-ops if contextEngine
   * is unavailable or if this session is already a subagent.
   */
  private async runReviewHook(trigger: ReviewTrigger, compactionMeta?: unknown): Promise<void> {
    if (this.runKind !== "core") return;
    if (!this.contextEngine) return;

    await runSessionReview({
      trigger,
      sessionId: this.sessionId,
      messages: this.messages ?? [],
      compactionMeta,
      contextEngine: this.contextEngine,
      rootDir: resolvePaths().rootDir,
      onEvent: (event) => this.emit(event),
      createChildSession: async (systemPrompt: string) => {
        const childLogger = new RunLogger({ dbPath: resolvePaths().dbPath });
        const childSession = new OrchestratorSession(childLogger, this.contextEngine, {
          systemPrompt,
          runKind: "reviewer",
          parentRunId: this.currentRunId,
          parentSessionId: this.sessionId,
        });

        return {
          runReview: async (userMessage: string) => {
            await childSession.prompt(userMessage);
            const msgs = (childSession.messages ?? []) as Array<{ role?: string; content?: unknown }>;
            const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
            return extractMessageText(lastAssistant?.content) || "";
          },
          dispose: () => {
            childSession.dispose();
            childLogger.close();
          },
        };
      },
    });
  }

  /**
   * Creates a pi agent session configured for Ollama, with the ObsidiClaw
   * context-injection extension wired in.
   *
   * Called ONCE per OrchestratorSession (lazy, on first prompt).
   */
  private async createPiSession() {
    // Build extension factories for context injection (when engine is available)
    const contextExtensions = this.contextEngine
      ? [createObsidiClawExtension({
          mcpServer: createContextEngineMcpServer({
            engine: this.contextEngine,
            onContextBuilt: (pkg) => this.emit({
              type: "context_retrieved",
              sessionId: this.sessionId,
              runId: this.currentRunId,
              timestamp: Date.now(),
              query: pkg.query,
              seedCount: pkg.seedNoteIds?.length ?? 0,
              expandedCount: pkg.expandedNoteIds?.length ?? 0,
              toolCount: pkg.suggestedTools.length,
              retrievalMs: pkg.retrievalMs,
              rawChars: pkg.rawChars,
              strippedChars: pkg.strippedChars,
              estimatedTokens: pkg.estimatedTokens,
              reviewMs: pkg.reviewResult?.reviewMs,
              reviewSkipped: pkg.reviewResult?.skipped,
              noteHits: pkg.retrievedNotes.map((n) => ({
                noteId: n.noteId,
                score: n.score,
                depth: n.depth ?? 0,
                source: n.retrievalSource,
              })),
            }),
            onSubagentPrepared: (pkg) => this.emit({
              type: "subagent_start",
              sessionId: this.sessionId,
              runId: this.currentRunId,
              timestamp: Date.now(),
              prompt: pkg.input.prompt,
              plan: pkg.input.plan,
              seedCount: pkg.contextPackage.seedNoteIds?.length ?? 0,
              expandedCount: pkg.contextPackage.expandedNoteIds?.length ?? 0,
              estimatedTokens: pkg.contextPackage.estimatedTokens,
            }),
          }),
        })]
      : [];

    return createPiAgentSession({
      ollama: this.config.model ? { model: this.config.model } : undefined,
      extensionFactories: contextExtensions,
      systemPrompt: this.config.systemPrompt,
    });
  }
}

