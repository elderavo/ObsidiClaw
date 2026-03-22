/**
 * SubagentRunner — first-class subagent executor.
 *
 * Can be called from anywhere without requiring a parent Pi session:
 *   - Pi tool handler (spawn_subagent)
 *   - Scheduler job
 *   - Standalone script
 *   - Context reviewer
 *
 * Encapsulates the full subagent lifecycle:
 *   1. Load personality (if specified)
 *   2. Build system prompt (with or without RAG context)
 *   3. Create child OrchestratorSession
 *   4. Run prompt with timeout/abort
 *   5. Extract output, dispose, return result
 */
import type { ContextEngine } from "../../context_engine/context-engine.js";
import type { SubagentSpec, SubagentResult } from "./types.js";
export interface SubagentRunnerConfig {
    /** Path to runs.db for event logging. */
    dbPath: string;
    /** ContextEngine for RAG. Optional — runs without RAG if omitted. */
    contextEngine?: ContextEngine;
    /** Path to personalities directory. Default: shared/agents/personalities/ */
    personalitiesDir?: string;
    /** Root directory for detached subagent work dirs. */
    rootDir?: string;
}
export declare class SubagentRunner {
    private readonly config;
    constructor(config: SubagentRunnerConfig);
    /**
     * Run a subagent to completion.
     *
     * Creates a child OrchestratorSession, runs the plan, extracts the
     * last assistant message, and returns a SubagentResult.
     */
    run(spec: SubagentSpec, signal?: AbortSignal): Promise<SubagentResult>;
    /**
     * Run a subagent in a detached child process (fire-and-forget).
     * Returns immediately with the job ID and result path.
     */
    runDetached(spec: SubagentSpec): {
        jobId: string;
        resultPath: string;
    };
}
//# sourceMappingURL=subagent-runner.d.ts.map