import type { RunEvent } from "../orchestrator/types.js";
export interface SynthesisMetrics {
    sessionId: string;
    timestamp: number;
    /** First 120 chars of the prompt (for inspection without storing full text). */
    promptSnippet: string;
    seedCount: number;
    expandedCount: number;
    toolCount: number;
    retrievalMs: number;
    /** Raw char count of all retrieved note bodies before stripping. */
    rawChars: number;
    /** Char count of the formatted context after frontmatter stripping. */
    strippedChars: number;
    /** Rough token estimate (strippedChars ÷ 4). */
    estimatedTokens: number;
}
/**
 * RunLogger — SQLite-backed event store for orchestrator runs.
 *
 * Schema:
 *   runs               — one row per prompt round-trip (run_id PK)
 *   trace              — one row per RunEvent (run_id FK, many per run)
 *   synthesis_metrics  — one row per context build (session_id FK)
 *
 * Session-level events (session_start / session_end) have no run_id;
 * they are written to trace with run_id = NULL.
 *
 * TODO: Phase 7 — add getRuns() / getTrace() query methods for insight engine
 */
export declare class RunLogger {
    private readonly db;
    constructor(dbPath?: string);
    private _initSchema;
    logEvent(event: RunEvent): void;
    logSynthesis(m: SynthesisMetrics): void;
    close(): void;
    private _insertRun;
    private _finalizeRun;
    private _insertTrace;
}
//# sourceMappingURL=run-logger.d.ts.map