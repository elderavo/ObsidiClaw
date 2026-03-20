import type { RunEvent } from "../orchestrator/types.js";
/**
 * RunLogger — SQLite-backed event store for orchestrator runs.
 *
 * Schema:
 *   runs  — one row per prompt round-trip (run_id PK)
 *   trace — one row per RunEvent (run_id FK, many per run)
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
    close(): void;
    private _insertRun;
    private _finalizeRun;
    private _insertTrace;
}
//# sourceMappingURL=run-logger.d.ts.map