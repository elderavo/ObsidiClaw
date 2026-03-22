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
 *   source          TEXT     — emitting module (from logger/trace-modules.ts)
 *   target          TEXT     — receiving module (nullable)
 *   action          TEXT     — operation name (e.g., "retrieve_context", "create_run")
 *   status          TEXT     — lifecycle phase ("started" | "returned" | "failed" | "emitted")
 *   span_id         TEXT     — groups related start/return events
 *   parent_event_id TEXT     — nests events under a parent
 *   payload_summary TEXT     — short human-readable description
 *   error_text      TEXT     — failure details (nullable)
 */

import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type { TraceModuleOrTool } from "./trace-modules.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TraceStatus = "started" | "returned" | "failed" | "emitted";

export type TracePhase =
  | "dispatch"
  | "retrieval"
  | "execution"
  | "logging"
  | "review"
  | "scheduling";

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

// ---------------------------------------------------------------------------
// TraceEmitter
// ---------------------------------------------------------------------------

export class TraceEmitter {
  private readonly db: Database.Database;

  /** Per-run monotonic sequence counters. */
  private readonly seqCounters = new Map<string, number>();

  private insertStmt: Database.Statement | null = null;

  constructor(db: Database.Database) {
    this.db = db;
    this._ensureColumns();
  }

  /**
   * Emit a structured trace event.
   * Returns the generated event_id for use as parent_event_id in nested events.
   */
  emit(event: TraceEvent): string {
    const eventId = randomUUID();
    const timestamp = event.timestamp ?? Date.now();
    const seq = this._nextSeq(event.runId);

    const payloadJson = event.payloadJson != null
      ? JSON.stringify(event.payloadJson)
      : null;

    this._getInsertStmt().run(
      eventId,
      event.runId,
      event.sessionId,
      seq,
      timestamp,
      event.phase ?? null,
      event.action,
      event.status,
      event.source,
      event.target ?? null,
      event.spanId ?? null,
      event.parentEventId ?? null,
      event.payloadSummary ?? null,
      payloadJson,
      event.errorText ?? null,
      // Legacy columns — keep populated for backward compat with existing readers
      `${event.action}_${event.status}`,  // type
      payloadJson ?? JSON.stringify({}),   // payload
    );

    return eventId;
  }

  /**
   * Create a new span ID. Convenience for grouping start/return pairs.
   */
  newSpan(): string {
    return randomUUID();
  }

  /**
   * Reset the seq counter for a run (e.g., on run start).
   */
  resetSeq(runId: string): void {
    this.seqCounters.delete(runId);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _nextSeq(runId: string): number {
    const current = this.seqCounters.get(runId) ?? 0;
    const next = current + 1;
    this.seqCounters.set(runId, next);
    return next;
  }

  private _getInsertStmt(): Database.Statement {
    if (!this.insertStmt) {
      this.insertStmt = this.db.prepare(
        `INSERT INTO trace
           (event_id, run_id, session_id, seq, timestamp,
            phase, action, status, source, target,
            span_id, parent_event_id, payload_summary, payload_json, error_text,
            type, payload)
         VALUES (?, ?, ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?)`
      );
    }
    return this.insertStmt;
  }

  /**
   * Add new columns to the trace table if they don't exist.
   * Uses ALTER TABLE for zero-migration compat with existing databases.
   */
  private _ensureColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(trace)").all() as { name: string }[];
    const existing = new Set(columns.map((c) => c.name));

    const additions: Array<[string, string]> = [
      ["event_id", "TEXT"],
      ["seq", "INTEGER"],
      ["phase", "TEXT"],
      ["action", "TEXT"],
      ["status", "TEXT"],
      ["source", "TEXT"],
      ["target", "TEXT"],
      ["span_id", "TEXT"],
      ["parent_event_id", "TEXT"],
      ["payload_summary", "TEXT"],
      ["payload_json", "TEXT"],
      ["error_text", "TEXT"],
    ];

    for (const [name, type] of additions) {
      if (!existing.has(name)) {
        this.db.exec(`ALTER TABLE trace ADD COLUMN ${name} ${type}`);
      }
    }

    // Index for structured queries
    this.db.exec(`CREATE INDEX IF NOT EXISTS trace_event_id ON trace(event_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS trace_span_id ON trace(span_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS trace_session_id ON trace(session_id)`);
  }
}
