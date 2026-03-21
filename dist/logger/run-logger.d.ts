import type { RunEvent } from "../orchestrator/types.js";
export interface RunLoggerOptions {
    dbPath?: string;
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
 *   synthesis_metrics  — one row per context build (session_id FK)
 *
 * Session-level events (session_start / session_end) have no run_id;
 * they are written to trace with run_id = NULL.
 *
 * Debug mode (debugDir set): appends every event as JSONL to
 * {debugDir}/{sessionId}.jsonl for easy inspection.
 *
 * TODO: Phase 7 — add getRuns() / getTrace() query methods for insight engine
 */
export declare class RunLogger {
    private readonly db;
    private readonly debugDir;
    /** Track which session files have been created so we only mkdirSync once. */
    private readonly debugSessions;
    constructor(options?: RunLoggerOptions | string);
    private _initSchema;
    private _ensureRunSchema;
    logEvent(event: RunEvent): void;
    close(): void;
    private _insertRun;
    private _finalizeRun;
    private _insertTrace;
    private _debugAppend;
}
//# sourceMappingURL=run-logger.d.ts.map