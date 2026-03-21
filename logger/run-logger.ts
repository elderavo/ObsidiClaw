import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import type { RunEvent } from "../orchestrator/types.js";

const DEFAULT_DB_PATH = join(process.cwd(), ".obsidi-claw", "runs.db");


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
export class RunLogger {
  private readonly db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this._initSchema();
  }

  private _initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id     TEXT    PRIMARY KEY,
        session_id TEXT    NOT NULL,
        status     TEXT    NOT NULL DEFAULT 'running',
        start_time INTEGER NOT NULL,
        end_time   INTEGER
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
  }

  logEvent(event: RunEvent): void {
    const sessionId = event.sessionId;
    const runId = "runId" in event ? event.runId : null;

    if (event.type === "prompt_received") {
      this._insertRun(event.runId, sessionId, event.timestamp);
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

  close(): void {
    this.db.close();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _insertRun(runId: string, sessionId: string, startTime: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO runs (run_id, session_id, status, start_time)
         VALUES (?, ?, 'running', ?)`,
      )
      .run(runId, sessionId, startTime);
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
}
