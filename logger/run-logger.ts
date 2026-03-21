import Database from "better-sqlite3";
import { mkdirSync, appendFileSync } from "fs";
import { dirname, join } from "path";
import type { RunEvent } from "../orchestrator/types.js";


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
export class RunLogger {
  private readonly db: Database.Database;
  private readonly debugDir: string | undefined;
  /** Track which session files have been created so we only mkdirSync once. */
  private readonly debugSessions = new Set<string>();

  constructor(options: RunLoggerOptions | string) {
    // Support legacy positional string arg for backwards compat
    const opts: RunLoggerOptions = typeof options === "string" ? { dbPath: options } : options;
    const dbPath = opts.dbPath;
    this.debugDir = opts.debugDir;

    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this._initSchema();

    if (this.debugDir) {
      mkdirSync(this.debugDir, { recursive: true });
    }
  }

  private _initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id       TEXT    PRIMARY KEY,
        session_id   TEXT    NOT NULL,
        status       TEXT    NOT NULL DEFAULT 'running',
        start_time   INTEGER NOT NULL,
        end_time     INTEGER,
        is_subagent  INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS trace (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id     TEXT,
        session_id TEXT    NOT NULL,
        type       TEXT    NOT NULL,
        timestamp  INTEGER NOT NULL,
        payload    TEXT    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS synthesis_metrics (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id       TEXT    NOT NULL,
        timestamp        INTEGER NOT NULL,
        prompt_snippet   TEXT    NOT NULL,
        seed_count       INTEGER NOT NULL,
        expanded_count   INTEGER NOT NULL,
        tool_count       INTEGER NOT NULL,
        retrieval_ms     INTEGER NOT NULL,
        raw_chars        INTEGER NOT NULL,
        stripped_chars   INTEGER NOT NULL,
        estimated_tokens INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS trace_run_id        ON trace(run_id);
      CREATE INDEX IF NOT EXISTS synthesis_session   ON synthesis_metrics(session_id);
    `);

    this._ensureRunSchema();
  }

  private _ensureRunSchema(): void {
    const columns = this.db.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
    const columnNames = new Set(columns.map((col) => col.name));

    if (!columnNames.has("is_subagent")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN is_subagent INTEGER NOT NULL DEFAULT 0");
    }
    if (!columnNames.has("review_status")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN review_status TEXT");
    }
    if (!columnNames.has("utility_score")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN utility_score INTEGER");
    }
    if (!columnNames.has("review_feedback")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN review_feedback TEXT");
    }
  }

  logEvent(event: RunEvent): void {
    if (this.debugDir) this._debugAppend(event);

    const sessionId = event.sessionId;
    const runId = "runId" in event ? event.runId : null;

    if (event.type === "prompt_received") {
      this._insertRun(event.runId, sessionId, event.timestamp, Boolean(event.isSubagent));
    }

    if (event.type === "prompt_complete") {
      this._finalizeRun(event.runId, "done", event.timestamp);
    } else if (event.type === "prompt_error") {
      this._finalizeRun(event.runId, "error", event.timestamp);
    }

    if (event.type === "context_retrieved") {
      this.db
        .prepare(
          `INSERT INTO synthesis_metrics
             (session_id, timestamp, prompt_snippet, seed_count, expanded_count,
              tool_count, retrieval_ms, raw_chars, stripped_chars, estimated_tokens)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionId,
          event.timestamp,
          event.query.slice(0, 120),
          event.seedCount,
          event.expandedCount,
          event.toolCount,
          event.retrievalMs,
          event.rawChars,
          event.strippedChars,
          event.estimatedTokens,
        );
    }

    this._insertTrace(runId, sessionId, event.type, event.timestamp, event);
  }

  /**
   * Mark a completed subagent run as awaiting human review.
   * Call this after the run finishes to change status from 'done' to 'awaiting_review'.
   */
  markAwaitingReview(runId: string): void {
    this.db
      .prepare(`UPDATE runs SET status = 'awaiting_review', review_status = 'pending' WHERE run_id = ?`)
      .run(runId);
  }

  /**
   * Record a human review for a subagent run.
   * @param runId - The run to review
   * @param score - Utility score: 1 (not useful), 2 (partially useful), 3 (fully useful)
   * @param feedback - Optional feedback text (required if score < 3)
   */
  recordReview(runId: string, score: number, feedback: string | null): void {
    this.db
      .prepare(
        `UPDATE runs
         SET review_status = 'reviewed',
             utility_score = ?,
             review_feedback = ?,
             status = 'done'
         WHERE run_id = ?`,
      )
      .run(score, feedback, runId);
  }

  /**
   * Get all runs awaiting human review.
   */
  getPendingReviews(): Array<{ run_id: string; session_id: string; start_time: number; end_time: number | null }> {
    return this.db
      .prepare(`SELECT run_id, session_id, start_time, end_time FROM runs WHERE status = 'awaiting_review' ORDER BY end_time DESC`)
      .all() as Array<{ run_id: string; session_id: string; start_time: number; end_time: number | null }>;
  }

  /**
   * Get the output trace for a specific run (for review context).
   */
  getRunTrace(runId: string): Array<{ type: string; timestamp: number; payload: string }> {
    return this.db
      .prepare(`SELECT type, timestamp, payload FROM trace WHERE run_id = ? ORDER BY timestamp`)
      .all(runId) as Array<{ type: string; timestamp: number; payload: string }>;
  }

  close(): void {
    this.db.close();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _insertRun(
    runId: string,
    sessionId: string,
    startTime: number,
    isSubagent: boolean,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO runs (run_id, session_id, status, start_time, is_subagent)
         VALUES (?, ?, 'running', ?, ?)`,
      )
      .run(runId, sessionId, startTime, isSubagent ? 1 : 0);
  }

  private _finalizeRun(runId: string, status: string, endTime: number): void {
    this.db
      .prepare(`UPDATE runs SET status = ?, end_time = ? WHERE run_id = ?`)
      .run(status, endTime, runId);
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
         VALUES (?, ?, ?, ?, ?)`,
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
      appendFileSync(filePath, header, "utf8");
    }

    appendFileSync(filePath, JSON.stringify(event) + "\n", "utf8");
  }
}
