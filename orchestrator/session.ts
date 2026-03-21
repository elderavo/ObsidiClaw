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

import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

import type { RunLogger } from "../logger/index.js";
import type { ContextEngine } from "../context_engine/index.js";
import { createContextEngineMcpServer } from "../context_engine/index.js";
import { createObsidiClawExtension } from "../extension/factory.js";
import type { RunEvent, RunId, RunStage, SessionConfig, SessionId } from "./types.js";

// ---------------------------------------------------------------------------
// Provider constants — TODO: Phase 1 move to shared/config.ts
// ---------------------------------------------------------------------------

const OLLAMA_BASE_URL = process.env["OLLAMA_BASE_URL"] ?? "http://10.0.132.100/v1";
const OLLAMA_MODEL    = process.env["OLLAMA_MODEL"]    ?? "llama3";

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

  private readonly isSubagent: boolean;

  constructor(
    private readonly logger: RunLogger,
    private readonly contextEngine?: ContextEngine,
    private readonly config: SessionConfig = {},
  ) {
    this.sessionId = crypto.randomUUID();
    this.isSubagent = Boolean(config.isSubagent);
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

    this.emit({ type: "prompt_received", sessionId: this.sessionId, runId, timestamp: Date.now(), text, isSubagent: this.isSubagent });

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

  /** Current stage of the last prompt round-trip (for single-shot compat). */
  getLastStage(): RunStage {
    return this.piSessionReady ? "done" : "prompt_received";
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

    switch (event.type) {
      case "agent_start":
        this.emit({ type: "agent_turn_start", sessionId: this.sessionId, runId, timestamp: Date.now() });
        break;

      case "agent_end":
        this.emit({
          type: "agent_done",
          sessionId: this.sessionId,
          runId,
          timestamp: Date.now(),
          messageCount: Array.isArray(event["messages"]) ? (event["messages"] as unknown[]).length : 0,
        });
        break;

      case "turn_end":
        this.emit({ type: "agent_turn_end", sessionId: this.sessionId, runId, timestamp: Date.now() });
        break;

      case "tool_execution_start":
        this.emit({
          type: "tool_call",
          sessionId: this.sessionId,
          runId,
          timestamp: Date.now(),
          toolName: String(event["toolName"] ?? "unknown"),
          toolCallId: typeof event["toolCallId"] === "string" ? String(event["toolCallId"]) : undefined,
          toolArgs: event["args"],
        });
        break;

      case "tool_execution_end":
        this.emit({
          type: "tool_result",
          sessionId: this.sessionId,
          runId,
          timestamp: Date.now(),
          toolName: String(event["toolName"] ?? "unknown"),
          toolCallId: typeof event["toolCallId"] === "string" ? String(event["toolCallId"]) : undefined,
          isError: Boolean(event["isError"]),
          toolResult: event["result"],
        });
        break;

      case "message_update": {
        const assistantEvent = event["assistantMessageEvent"] as { type: string; delta?: string } | undefined;
        if (assistantEvent?.type === "text_delta" && this.config.onOutput) {
          this.config.onOutput(assistantEvent.delta ?? "");
        }
        break;
      }

      default:
        break;
    }
  }

  /**
   * Creates a pi agent session configured for Ollama, with the ObsidiClaw
   * context-injection extension wired in.
   *
   * Called ONCE per OrchestratorSession (lazy, on first prompt).
   *
   * TODO: Phase 1 — pull Ollama config from shared/config.ts
   */
  private async createPiSession() {
    const model = this.config.model ?? OLLAMA_MODEL;

    const loader = new DefaultResourceLoader({
      extensionFactories: [
        // Register Ollama as the LLM provider
        (pi) => {
          pi.registerProvider("ollama", {
            baseUrl: OLLAMA_BASE_URL,
            apiKey: "ollama",
            api: "openai-completions",
            models: [
              {
                id: model,
                name: `Ollama / ${model}`,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32768,
                maxTokens: 4096,
                compat: {
                  supportsDeveloperRole: false,
                  maxTokensField: "max_tokens",
                },
              },
            ],
          });
        },

        // ObsidiClaw context injection via MCP.
        // The MCP server wraps the context engine; the onContextBuilt callback routes
        // full ContextPackage metrics to the orchestrator event log (context_retrieved).
        ...(this.contextEngine
          ? [createObsidiClawExtension({
              mcpServer: createContextEngineMcpServer(
                this.contextEngine,
                (pkg) => this.emit({
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
                }),
                (pkg) => this.emit({
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
              ),
            })]
          : []),
      ],

      ...(this.config.systemPrompt
        ? { systemPromptOverride: () => this.config.systemPrompt! }
        : {}),
    });

    await loader.reload();

    const { session } = await createAgentSession({
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    });

    return session;
  }
}
