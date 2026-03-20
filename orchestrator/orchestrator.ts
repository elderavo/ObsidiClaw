import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

import type { RunConfig, RunEvent, RunId, RunResult, LifecycleStage } from "./types.js";
import type { RunLogger } from "../logger/index.js";
import type { ContextEngine, ContextPackage } from "../context_engine/index.js";

// ---------------------------------------------------------------------------
// Provider constants
// TODO: Phase 1 — move to shared/config.ts OllamaConfig
// ---------------------------------------------------------------------------

/** Ollama OpenAI-compatible base URL. The pi SDK appends /chat/completions. */
const OLLAMA_BASE_URL = process.env["OLLAMA_BASE_URL"] ?? "http://10.0.132.100/v1";

/** Ollama model ID. Must match a model loaded on your Ollama instance. */
const OLLAMA_MODEL = process.env["OLLAMA_MODEL"] ?? "llama3";

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Orchestrator — manages the full lifecycle of a pi agent run.
 *
 * Lifecycle:
 *   init → context_inject → run → post_process → done
 *                                               ↘ error (on any throw)
 *
 * The context_inject stage intercepts the prompt before it reaches the agent:
 *   1. ContextEngine retrieves relevant md_db notes via LlamaIndex RAG
 *   2. Returned ContextPackage is injected into the pi session as system context
 *   3. Original prompt is sent to the agent (which now sees both prompt + context)
 *
 * Logger receives a RunEvent at every significant transition point.
 *
 * @param logger   Receives RunEvents (Phase 3: console stub; Phase 4: SQLite)
 * @param contextEngine  Optional — if omitted, context injection is skipped.
 *                       Must have initialize() called before passing here.
 */
export class Orchestrator {
  constructor(
    private readonly logger: RunLogger,
    private readonly contextEngine?: ContextEngine,
  ) {}

  async run(config: RunConfig): Promise<RunResult> {
    const runId: RunId = crypto.randomUUID();
    const startTime = Date.now();
    let stage: LifecycleStage = "init";

    this.emit({ type: "run_start", runId, timestamp: Date.now(), config });

    try {
      // ── STAGE: init ───────────────────────────────────────────────────────
      stage = this.transition(runId, stage, "init");
      // TODO: Phase 1 — validate config against shared RunConfig schema

      // ── STAGE: context_inject ─────────────────────────────────────────────
      stage = this.transition(runId, stage, "context_inject");

      let contextPackage: ContextPackage | undefined;

      if (this.contextEngine) {
        contextPackage = await this.contextEngine.build(config.prompt);
        this.emit({
          type: "context_built",
          runId,
          timestamp: Date.now(),
          noteCount: contextPackage.retrievedNotes.length,
          toolCount: contextPackage.suggestedTools.length,
          retrievalMs: contextPackage.retrievalMs,
        });
      }

      // TODO: Phase 6 — run tools from contextPackage.suggestedTools here,
      //   append their outputs to contextPackage.formattedContext before session creation

      // ── STAGE: run ────────────────────────────────────────────────────────
      stage = this.transition(runId, stage, "run");

      const session = await this.createSession(config, contextPackage);

      const unsubscribe = session.subscribe((event) => {
        switch (event.type) {
          case "tool_execution_start":
            this.emit({
              type: "tool_call",
              runId,
              timestamp: Date.now(),
              toolName: event.toolName,
            });
            break;
          case "tool_execution_end":
            this.emit({
              type: "tool_result",
              runId,
              timestamp: Date.now(),
              toolName: event.toolName,
              isError: event.isError,
            });
            break;
          default:
            break;
        }
      });

      await session.prompt(config.prompt);
      await session.agent.waitForIdle();
      unsubscribe();

      // ── STAGE: post_process ───────────────────────────────────────────────
      stage = this.transition(runId, stage, "post_process");
      // TODO: Phase 7 — comparison engine: compare this run against history
      // TODO: Phase 8 — insight engine: derive lessons, write back to md_db

      // ── STAGE: done ───────────────────────────────────────────────────────
      stage = this.transition(runId, stage, "done");

      const durationMs = Date.now() - startTime;
      this.emit({ type: "run_end", runId, timestamp: Date.now(), durationMs });

      return { runId, stage, durationMs, messages: session.messages };

    } catch (err) {
      stage = this.transition(runId, stage, "error");
      const error = err instanceof Error ? err.message : String(err);
      this.emit({ type: "run_error", runId, timestamp: Date.now(), error });
      return { runId, stage, durationMs: Date.now() - startTime, messages: [], error };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private transition(runId: RunId, from: LifecycleStage, to: LifecycleStage): LifecycleStage {
    this.emit({ type: "stage_change", runId, timestamp: Date.now(), from, to });
    return to;
  }

  private emit(event: RunEvent): void {
    this.logger.logEvent(event);
  }

  /**
   * Creates an in-memory pi agent session configured for Ollama.
   *
   * If a ContextPackage is provided, its formattedContext is injected into
   * the session via agentsFilesOverride — this is how ObsidiClaw injects
   * md_db knowledge as system-level context before the user prompt reaches
   * the agent.
   *
   * TODO: Phase 1 — pull Ollama config from shared/config.ts
   */
  private async createSession(config: RunConfig, contextPackage?: ContextPackage) {
    const model = config.model ?? OLLAMA_MODEL;

    const loader = new DefaultResourceLoader({
      extensionFactories: [
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
      ],

      // Inject md_db context as an AGENTS.md-equivalent — pi treats these
      // as additional system context, so the agent sees it before the prompt.
      ...(contextPackage
        ? {
            agentsFilesOverride: (current) => ({
              agentsFiles: [
                ...current.agentsFiles,
                {
                  path: "obsidi-claw://md_db-context",
                  content: contextPackage.formattedContext,
                },
              ],
            }),
          }
        : {}),

      ...(config.systemPrompt
        ? { systemPromptOverride: () => config.systemPrompt! }
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
