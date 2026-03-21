/**
 * Orchestrator — factory for OrchestratorSession, and single-shot runner.
 *
 * For interactive / multi-turn use: call createSession() to get an
 * OrchestratorSession, then call session.prompt() in a loop.
 *
 * For single-shot use (scripts, testing): call run(config) which internally
 * creates a session, sends one prompt, collects the result, and disposes.
 */
import { OrchestratorSession } from "./session.js";
export class Orchestrator {
    logger;
    contextEngine;
    constructor(logger, contextEngine) {
        this.logger = logger;
        this.contextEngine = contextEngine;
    }
    /**
     * Create a new long-lived session.
     * First prompt triggers context injection; subsequent prompts go straight to pi.
     */
    createSession(config = {}) {
        return new OrchestratorSession(this.logger, this.contextEngine, config);
    }
    /**
     * Single-shot: create a session, send one prompt, dispose, return result.
     * Useful for scripting and testing.
     */
    async run(config) {
        const startTime = Date.now();
        const session = this.createSession(config);
        try {
            await session.prompt(config.prompt);
            return {
                sessionId: session.sessionId,
                runId: crypto.randomUUID(),
                stage: "done",
                durationMs: Date.now() - startTime,
                messages: session.messages,
            };
        }
        catch (err) {
            return {
                sessionId: session.sessionId,
                runId: crypto.randomUUID(),
                stage: "error",
                durationMs: Date.now() - startTime,
                messages: session.messages,
                error: err instanceof Error ? err.message : String(err),
            };
        }
        finally {
            await session.finalize();
        }
    }
}
//# sourceMappingURL=orchestrator.js.map