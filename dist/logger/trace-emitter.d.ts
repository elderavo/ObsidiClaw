/**
 * TraceEmitter — centralized, structured trace event writer.
 *
 * Manages per-run monotonic sequence counters and writes structured trace
 * rows with source/target/action/status decomposition.
 *
 * Backward compatible: the existing RunLogger.logEvent() path continues to
 * write trace rows with the legacy `type`+`payload` columns. TraceEmitter
 * writes to the same table but populates the new structured columns.
 *
 * New columns added to the `trace` table (via migration):
 *   event_id        TEXT     — UUID for this event (allows parent_event_id references)
 *   seq             INTEGER  — monotonic counter per run_id
 *   source          TEXT     — emitting module (from shared/trace-modules.ts)
 *   target          TEXT     — receiving module (nullable)
 *   action          TEXT     — operation name (e.g., "retrieve_context", "create_run")
 *   status          TEXT     — lifecycle phase ("started" | "returned" | "failed" | "emitted")
 *   span_id         TEXT     — groups related start/return events
 *   parent_event_id TEXT     — nests events under a parent
 *   payload_summary TEXT     — short human-readable description
 *   error_text      TEXT     — failure details (nullable)
 */
import type Database from "better-sqlite3";
import type { TraceModuleOrTool } from "../shared/trace-modules.js";
export type TraceStatus = "started" | "returned" | "failed" | "emitted";
export type TracePhase = "dispatch" | "retrieval" | "execution" | "logging" | "review" | "scheduling";
export interface TraceEvent {
    runId: string;
    sessionId: string;
    timestamp?: number;
    phase?: TracePhase;
    action: string;
    status: TraceStatus;
    source: TraceModuleOrTool;
    target?: TraceModuleOrTool;
    spanId?: string;
    parentEventId?: string;
    payloadSummary?: string;
    payloadJson?: unknown;
    errorText?: string;
}
export declare class TraceEmitter {
    private readonly db;
    /** Per-run monotonic sequence counters. */
    private readonly seqCounters;
    private insertStmt;
    constructor(db: Database.Database);
    /**
     * Emit a structured trace event.
     * Returns the generated event_id for use as parent_event_id in nested events.
     */
    emit(event: TraceEvent): string;
    /**
     * Create a new span ID. Convenience for grouping start/return pairs.
     */
    newSpan(): string;
    /**
     * Reset the seq counter for a run (e.g., on run start).
     */
    resetSeq(runId: string): void;
    private _nextSeq;
    private _getInsertStmt;
    /**
     * Add new columns to the trace table if they don't exist.
     * Uses ALTER TABLE for zero-migration compat with existing databases.
     */
    private _ensureColumns;
}
//# sourceMappingURL=trace-emitter.d.ts.map