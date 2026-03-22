import type { RunEvent } from "../orchestrator/types.js";
import { TraceEmitter } from "./trace-emitter.js";
export interface RunLoggerOptions {
    /** Path to the SQLite database file. Required — use resolvePaths().dbPath. */
    dbPath: string;
    /**
     * When set, every RunEvent is also appended as a JSON line to
     * {debugDir}/{sessionId}.jsonl. One file per session, created on first event.
     * Set via OBSIDI_CLAW_DEBUG=1 in run.ts.
     */
    debugDir?: string;
}
/**
 * RunLogger — SQLite-backed event store for orchestrator runs.
 *
 * Schema:
 *   runs               — one row per prompt round-trip (run_id PK)
 *   trace              — one row per RunEvent (run_id FK, many per run)
 *   synthesis_metrics  — context build stats + retrieve_context errors (session_id/run_id FK)
 *
 * Session-level events (session_start / session_end) have no run_id;
 * they are written to trace with run_id = NULL.
 *
 * Debug mode (debugDir set): appends every event as JSONL to
 * {debugDir}/{sessionId}.jsonl for easy inspection.
 */
export declare class RunLogger {
    private readonly db;
    private readonly debugDir;
    /** Track which session files have been created so we only mkdirSync once. */
    private readonly debugSessions;
    private _traceEmitter;
    constructor(options: RunLoggerOptions | string);
    private _initSchema;
    private _ensureRunSchema;
    private _ensureSynthesisSchema;
    /**
     * Structured trace emitter. Uses the same `trace` table but writes
     * decomposed source/target/action/status columns with per-run seq counters.
     * Lazily initialized on first access.
     */
    get trace(): TraceEmitter;
    logEvent(event: RunEvent): void;
    /**
     * Insert a run row for a scheduler job execution.
     * Called by JobScheduler when a job starts.
     */
    insertJobRun(runId: string, sessionId: string, startTime: number, jobName: string): void;
    /**
     * Finalize a run row (set status + end_time).
     * Used by JobScheduler to close job runs.
     */
    finalizeRun(runId: string, status: string, endTime: number): void;
    /**
     * Mark a completed subagent run as awaiting human review.
     * Call this after the run finishes to change status from 'done' to 'awaiting_review'.
     */
    markAwaitingReview(runId: string): void;
    /**
     * Record a human review for a subagent run.
     * @param runId - The run to review
     * @param score - Utility score: 1 (not useful), 2 (partially useful), 3 (fully useful)
     * @param feedback - Optional feedback text (required if score < 3)
     */
    recordReview(runId: string, score: number, feedback: string | null): void;
    /**
     * Get all runs awaiting human review.
     */
    getPendingReviews(): Array<{
        run_id: string;
        session_id: string;
        start_time: number;
        end_time: number | null;
    }>;
    /**
     * Get the output trace for a specific run (for review context).
     */
    getRunTrace(runId: string): Array<{
        type: string;
        timestamp: number;
        payload: string;
    }>;
    close(): void;
    private _insertSession;
    private _finalizeSession;
    private _incrementSessionPromptCount;
    private _insertRun;
    private _finalizeRun;
    private _insertTrace;
    private _debugAppend;
}
//# sourceMappingURL=run-logger.d.ts.map