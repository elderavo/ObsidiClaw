import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { dirname } from "path";
import { ensureDir } from "../core/os/fs.js";
import type { RunEvent } from "./types.js";
import { mapRunEvent } from "./event-mapping.js";

export interface RunLoggerOptions {
  /** Path to the SQLite database file. Required — use resolvePaths().dbPath. */
  dbPath: string;
  /**
   * Called when a retrieve_context tool_result error event is logged.
   * Used to route retrieval errors to NoteMetricsLogger.
   */
  onRetrievalError?: (sessionId: string, runId: string | null, timestamp: number, errorPayload: string) => void;
}

/**
 * RunLogger — unified SQLite event store.
 *
 * Schema:
 *   sessions — one row per agent session
 *   trace    — one row per event, structured columns, no redundancy
 */
export class RunLogger {
  private readonly db: Database.Database;
  private readonly onRetrievalError: RunLoggerOptions["onRetrievalError"];

  /** Per-session monotonic sequence counter. */
  private readonly seqCounters = new Map<string, number>();

  private insertStmt: Database.Statement | null = null;

  constructor(options: RunLoggerOptions | string) {
    const opts: RunLoggerOptions = typeof options === "string" ? { dbPath: options } : options;
    const dbPath = opts.dbPath;
    this.onRetrievalError = opts.onRetrievalError;

    ensureDir(dirname(dbPath));
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this._initSchema();
  }

  // =========================================================================
  // Schema
  // =========================================================================

  private _initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id   TEXT    PRIMARY KEY,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        status       TEXT    NOT NULL DEFAULT 'running',
        prompt_count INTEGER NOT NULL DEFAULT 0,
        human_verdict TEXT,
        human_notes   TEXT
      );
    `);

    // Check if the trace table needs to be rebuilt (legacy schema detection).
    // Legacy schema has a payload column but no event_id column.
    const needsRebuild = this._traceSchemaNeedsRebuild();
    if (needsRebuild) {
      this.db.exec(`DROP TABLE IF EXISTS trace`);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trace (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id   TEXT    UNIQUE NOT NULL,
        session_id TEXT    NOT NULL,
        run_id     TEXT,
        seq        INTEGER NOT NULL,
        ts         INTEGER NOT NULL,
        type       TEXT    NOT NULL,
        source     TEXT    NOT NULL,
        target     TEXT,
        action     TEXT    NOT NULL,
        status     TEXT    NOT NULL,
        phase      TEXT,
        span_id    TEXT,
        parent_id  TEXT,
        data       TEXT,
        summary    TEXT,
        error      TEXT
      );

      CREATE INDEX IF NOT EXISTS trace_session_id ON trace(session_id);
      CREATE INDEX IF NOT EXISTS trace_run_id     ON trace(run_id);
      CREATE INDEX IF NOT EXISTS trace_event_id   ON trace(event_id);
      CREATE INDEX IF NOT EXISTS trace_type       ON trace(type);
      CREATE INDEX IF NOT EXISTS trace_source     ON trace(source);
      CREATE INDEX IF NOT EXISTS trace_action     ON trace(action);
      CREATE INDEX IF NOT EXISTS trace_span_id    ON trace(span_id);
    `);

    // Drop old runs table if it lingers from an even older schema version.
    try {
      const hasRuns = this.db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='runs'`
      ).get() != null;
      if (hasRuns) this.db.exec(`DROP TABLE runs`);
    } catch { /* best-effort */ }
  }

  /** Detect whether the trace table is the legacy schema (has payload, lacks event_id). */
  private _traceSchemaNeedsRebuild(): boolean {
    const exists = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='trace'`
    ).get();
    if (!exists) return false; // table doesn't exist yet — no rebuild needed

    const columns = this.db.prepare("PRAGMA table_info(trace)").all() as { name: string }[];
    const names = new Set(columns.map((c) => c.name));
    // Legacy schema has 'payload' but not 'event_id'
    return names.has("payload") && !names.has("event_id");
  }

  // =========================================================================
  // Public API
  // =========================================================================

  logEvent(event: RunEvent): void {
    const sessionId = event.sessionId;
    const runId = "runId" in event ? (event.runId as string | undefined) ?? null : null;

    // ── Session lifecycle side effects ─────────────────────────────────────
    if (event.type === "session_start") {
      this._insertSession(sessionId, event.timestamp);
    } else if (event.type === "session_end") {
      this._finalizeSession(sessionId, event.timestamp);
    }

    if (event.type === "prompt_received") {
      this._incrementSessionPromptCount(sessionId);
    }

    // ── Route retrieval errors to NoteMetricsLogger ───────────────────────
    if (event.type === "tool_result" && event.toolName === "retrieve_context" && event.isError && this.onRetrievalError) {
      const errorPayload = (() => {
        try { return JSON.stringify(event.toolResult).slice(0, 240); }
        catch { return String(event.toolResult).slice(0, 240); }
      })();
      this.onRetrievalError(sessionId, runId, event.timestamp, errorPayload);
    }

    // ── Map and write structured trace row ─────────────────────────────────
    const mapped = mapRunEvent(event);
    const eventId = randomUUID();
    const seq = this._nextSeq(sessionId);
    const dataJson = mapped.data != null ? JSON.stringify(mapped.data) : null;

    this._getInsertStmt().run(
      eventId,
      sessionId,
      runId,
      seq,
      event.timestamp,
      event.type,
      mapped.source,
      mapped.target ?? null,
      mapped.action,
      mapped.status,
      mapped.phase ?? null,
      null, // span_id — set by callers who need correlation
      null, // parent_id — set by callers who need nesting
      dataJson,
      mapped.summary ?? null,
      mapped.error ?? null,
    );
  }

  /**
   * Get trace events for a session, optionally filtered by run_id.
   */
  getSessionTrace(sessionId: string, runId?: string): TraceRow[] {
    if (runId) {
      return this.db
        .prepare(`SELECT * FROM trace WHERE session_id = ? AND run_id = ? ORDER BY seq`)
        .all(sessionId, runId) as TraceRow[];
    }
    return this.db
      .prepare(`SELECT * FROM trace WHERE session_id = ? ORDER BY seq`)
      .all(sessionId) as TraceRow[];
  }

  /**
   * Create a new span ID for correlating start/return event pairs.
   */
  newSpan(): string {
    return randomUUID();
  }

  close(): void {
    this.db.close();
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private _nextSeq(sessionId: string): number {
    const current = this.seqCounters.get(sessionId) ?? 0;
    const next = current + 1;
    this.seqCounters.set(sessionId, next);
    return next;
  }

  private _getInsertStmt(): Database.Statement {
    if (!this.insertStmt) {
      this.insertStmt = this.db.prepare(
        `INSERT INTO trace
           (event_id, session_id, run_id, seq, ts, type, source, target, action, status, phase, span_id, parent_id, data, summary, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
    }
    return this.insertStmt;
  }

  private _insertSession(sessionId: string, timestamp: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (session_id, created_at, updated_at, status, prompt_count)
         VALUES (?, ?, ?, 'running', 0)`
      )
      .run(sessionId, timestamp, timestamp);
  }

  private _finalizeSession(sessionId: string, timestamp: number): void {
    this.db
      .prepare(`UPDATE sessions SET status = 'completed', updated_at = ? WHERE session_id = ?`)
      .run(timestamp, sessionId);
  }

  private _incrementSessionPromptCount(sessionId: string): void {
    this.db
      .prepare(`UPDATE sessions SET prompt_count = prompt_count + 1, updated_at = ? WHERE session_id = ?`)
      .run(Date.now(), sessionId);
  }
}

// ---------------------------------------------------------------------------
// TraceRow — returned by getSessionTrace()
// ---------------------------------------------------------------------------

export interface TraceRow {
  id: number;
  event_id: string;
  session_id: string;
  run_id: string | null;
  seq: number;
  ts: number;
  type: string;
  source: string;
  target: string | null;
  action: string;
  status: string;
  phase: string | null;
  span_id: string | null;
  parent_id: string | null;
  data: string | null;
  summary: string | null;
  error: string | null;
}
