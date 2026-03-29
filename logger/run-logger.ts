import Database from "better-sqlite3";
import { dirname, join } from "path";
import { ensureDir, appendText } from "../core/os/fs.js";
import type { RunEvent } from "./types.js";
import { TraceEmitter } from "./trace-emitter.js";


export interface RunLoggerOptions {
  /** Path to the SQLite database file. Required — use resolvePaths().dbPath. */
  dbPath: string;
  /**
   * When set, every RunEvent is also appended as a JSON line to
   * {debugDir}/{sessionId}.jsonl. One file per session, created on first event.
   */
  debugDir?: string;
  /**
   * Called when a retrieve_context tool_result error event is logged.
   * Used to route retrieval errors to NoteMetricsLogger.
   */
  onRetrievalError?: (sessionId: string, runId: string | null, timestamp: number, errorPayload: string) => void;
}

/**
 * RunLogger — SQLite-backed event store.
 *
 * Schema:
 *   sessions  — one row per agent session
 *   trace     — one row per RunEvent; run_id is a loose per-prompt correlation
 *               key (no backing table — just groups events within a turn)
 *   (note_hits, synthesis_metrics, context_ratings are in notes.db — NoteMetricsLogger)
 *
 * Session-level events (session_start / session_end) write to trace with run_id = NULL.
 *
 * Debug mode (debugDir set): appends every event as JSONL to
 * {debugDir}/{sessionId}.jsonl for easy inspection.
 */
export class RunLogger {
  private readonly db: Database.Database;
  private readonly debugDir: string | undefined;
  private readonly onRetrievalError: RunLoggerOptions["onRetrievalError"];
  /** Track which session files have been created so we only mkdirSync once. */
  private readonly debugSessions = new Set<string>();
  private _traceEmitter: TraceEmitter | null = null;

  constructor(options: RunLoggerOptions | string) {
    // Support legacy positional string arg for backwards compat
    const opts: RunLoggerOptions = typeof options === "string" ? { dbPath: options } : options;
    const dbPath = opts.dbPath;
    this.debugDir = opts.debugDir;
    this.onRetrievalError = opts.onRetrievalError;

    ensureDir(dirname(dbPath));
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this._initSchema();

    if (this.debugDir) {
      ensureDir(this.debugDir);
    }
  }

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

      CREATE TABLE IF NOT EXISTS trace (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id     TEXT,
        session_id TEXT    NOT NULL,
        type       TEXT    NOT NULL,
        timestamp  INTEGER NOT NULL,
        payload    TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS trace_run_id ON trace(run_id);
      CREATE INDEX IF NOT EXISTS trace_session_id ON trace(session_id);
    `);

    // One-time migration: drop the old runs table if it exists from a previous
    // version of the schema. The sessions + trace tables supersede it.
    try {
      const hasRuns = (this.db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='runs'`
      ).get()) != null;
      if (hasRuns) {
        this.db.exec(`DROP TABLE runs`);
      }
    } catch {
      // Ignore — migration is best-effort
    }
  }

  /**
   * Structured trace emitter. Uses the same `trace` table but writes
   * decomposed source/target/action/status columns with per-run seq counters.
   * Lazily initialized on first access.
   */
  get trace(): TraceEmitter {
    if (!this._traceEmitter) {
      this._traceEmitter = new TraceEmitter(this.db);
    }
    return this._traceEmitter;
  }

  logEvent(event: RunEvent): void {
    if (this.debugDir) this._debugAppend(event);

    const sessionId = event.sessionId;
    const runId = "runId" in event ? event.runId : null;

    // ── Session lifecycle ──────────────────────────────────────────────────
    if (event.type === "session_start") {
      this._insertSession(sessionId, event.timestamp);
    } else if (event.type === "session_end") {
      this._finalizeSession(sessionId, event.timestamp);
    }

    // ── Per-prompt session counter ─────────────────────────────────────────
    if (event.type === "prompt_received") {
      this._incrementSessionPromptCount(sessionId);
    }

    // Route retrieve_context errors to NoteMetricsLogger via callback.
    if (event.type === "tool_result" && event.toolName === "retrieve_context" && event.isError && this.onRetrievalError) {
      const errorPayload = (() => {
        try {
          return JSON.stringify(event.toolResult).slice(0, 240);
        } catch {
          return String(event.toolResult).slice(0, 240);
        }
      })();
      this.onRetrievalError(sessionId, runId, event.timestamp, errorPayload);
    }

    this._insertTrace(runId, sessionId, event.type, event.timestamp, event);
  }

  /**
   * Get the trace events for a session, optionally filtered by run_id.
   */
  getSessionTrace(sessionId: string, runId?: string): Array<{ type: string; timestamp: number; payload: string }> {
    if (runId) {
      return this.db
        .prepare(`SELECT type, timestamp, payload FROM trace WHERE session_id = ? AND run_id = ? ORDER BY timestamp`)
        .all(sessionId, runId) as Array<{ type: string; timestamp: number; payload: string }>;
    }
    return this.db
      .prepare(`SELECT type, timestamp, payload FROM trace WHERE session_id = ? ORDER BY timestamp`)
      .all(sessionId) as Array<{ type: string; timestamp: number; payload: string }>;
  }

  close(): void {
    this.db.close();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

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

  private _insertTrace(
    runId: string | null,
    sessionId: string,
    type: string,
    timestamp: number,
    event: RunEvent,
  ): void {
    this.db
      .prepare(
        `INSERT INTO trace (run_id, session_id, type, timestamp, payload)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(runId, sessionId, type, timestamp, JSON.stringify(event));
  }

  private _debugAppend(event: RunEvent): void {
    const sessionId = event.sessionId;
    const filePath = join(this.debugDir!, `${sessionId}.jsonl`);

    // Write a header comment on first event for this session
    if (!this.debugSessions.has(sessionId)) {
      this.debugSessions.add(sessionId);
      const header = `# session: ${sessionId}  started: ${new Date().toISOString()}\n`;
      appendText(filePath, header);
    }

    appendText(filePath, JSON.stringify(event) + "\n");
  }
}
