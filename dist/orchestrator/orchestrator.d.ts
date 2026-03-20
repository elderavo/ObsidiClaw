/**
 * Orchestrator — factory for OrchestratorSession, and single-shot runner.
 *
 * For interactive / multi-turn use: call createSession() to get an
 * OrchestratorSession, then call session.prompt() in a loop.
 *
 * For single-shot use (scripts, testing): call run(config) which internally
 * creates a session, sends one prompt, collects the result, and disposes.
 */
import type { RunLogger } from "../logger/index.js";
import type { ContextEngine } from "../context_engine/index.js";
import type { RunConfig, RunResult, SessionConfig } from "./types.js";
import { OrchestratorSession } from "./session.js";
export declare class Orchestrator {
    private readonly logger;
    private readonly contextEngine?;
    constructor(logger: RunLogger, contextEngine?: ContextEngine | undefined);
    /**
     * Create a new long-lived session.
     * First prompt triggers context injection; subsequent prompts go straight to pi.
     */
    createSession(config?: SessionConfig): OrchestratorSession;
    /**
     * Single-shot: create a session, send one prompt, dispose, return result.
     * Useful for scripting and testing.
     */
    run(config: RunConfig): Promise<RunResult>;
}
//# sourceMappingURL=orchestrator.d.ts.map