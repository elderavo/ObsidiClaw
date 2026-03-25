/**
 * Orchestrator — factory for OrchestratorSession, and single-shot runner.
 *
 * For interactive / multi-turn use: call createSession() to get an
 * OrchestratorSession, then call session.prompt() in a loop.
 *
 * For single-shot use (scripts, testing): call run(config) which internally
 * creates a session, sends one prompt, collects the result, and disposes.
 */

import type { RunLogger } from "../../logger/index.js";
import type { NoteMetricsLogger } from "../../logger/note-metrics.js";
import type { ContextEngine } from "../../knowledge/engine/index.js";
import type { WorkspaceRegistry } from "../../automation/workspaces/workspace-registry.js";
import type { RunConfig, RunResult, SessionConfig } from "./types.js";
import { OrchestratorSession } from "./session.js";

export class Orchestrator {
  constructor(
    private readonly logger: RunLogger,
    private readonly contextEngine?: ContextEngine,
    private readonly noteMetrics?: NoteMetricsLogger,
    private readonly workspaceRegistry?: WorkspaceRegistry,
  ) {}

  /**
   * Create a new long-lived session.
   * First prompt triggers context injection; subsequent prompts go straight to pi.
   */
  createSession(config: SessionConfig = {}): OrchestratorSession {
    return new OrchestratorSession(this.logger, this.contextEngine, config, this.noteMetrics, this.workspaceRegistry);
  }

  /**
   * Single-shot: create a session, send one prompt, dispose, return result.
   * Useful for scripting and testing.
   */
  async run(config: RunConfig): Promise<RunResult> {
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
    } catch (err) {
      return {
        sessionId: session.sessionId,
        runId: crypto.randomUUID(),
        stage: "error",
        durationMs: Date.now() - startTime,
        messages: session.messages,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await session.finalize();
    }
  }
}
