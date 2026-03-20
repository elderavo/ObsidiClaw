import type { RunConfig, RunResult } from "./types.js";
import type { RunLogger } from "../logger/index.js";
import type { ContextEngine } from "../context_engine/index.js";
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
export declare class Orchestrator {
    private readonly logger;
    private readonly contextEngine?;
    constructor(logger: RunLogger, contextEngine?: ContextEngine | undefined);
    run(config: RunConfig): Promise<RunResult>;
    private transition;
    private emit;
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
    private createSession;
}
//# sourceMappingURL=orchestrator.d.ts.map