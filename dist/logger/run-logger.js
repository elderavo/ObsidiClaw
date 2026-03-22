import Database from "better-sqlite3";
import { dirname, join } from "path";
import { ensureDir, appendText } from "../shared/os/fs.js";
import { TraceEmitter } from "./trace-emitter.js";
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
export class RunLogger {
    db;
    debugDir;
    /** Track which session files have been created so we only mkdirSync once. */
    debugSessions = new Set();
    _traceEmitter = null;
    constructor(options) {
        // Support legacy positional string arg for backwards compat
        const opts = typeof options === "string" ? { dbPath: options } : options;
        const dbPath = opts.dbPath;
        this.debugDir = opts.debugDir;
        ensureDir(dirname(dbPath));
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this._initSchema();
        if (this.debugDir) {
            ensureDir(this.debugDir);
        }
    }
    _initSchema() {
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
        run_id           TEXT,
        timestamp        INTEGER NOT NULL,
        prompt_snippet   TEXT    NOT NULL,
        seed_count       INTEGER NOT NULL,
        expanded_count   INTEGER NOT NULL,
        tool_count       INTEGER NOT NULL,
        retrieval_ms     INTEGER NOT NULL,
        raw_chars        INTEGER NOT NULL,
        stripped_chars   INTEGER NOT NULL,
        estimated_tokens INTEGER NOT NULL,
        is_error         INTEGER NOT NULL DEFAULT 0,
        error_type       TEXT,
        error_message    TEXT
      );

      CREATE INDEX IF NOT EXISTS trace_run_id        ON trace(run_id);
      CREATE INDEX IF NOT EXISTS synthesis_session   ON synthesis_metrics(session_id);
    `);
        this._ensureRunSchema();
        this._ensureSynthesisSchema();
        this.db.exec(`
      CREATE INDEX IF NOT EXISTS synthesis_run_id    ON synthesis_metrics(run_id);
    `);
    }
    _ensureRunSchema() {
        const columns = this.db.prepare("PRAGMA table_info(runs)").all();
        const columnNames = new Set(columns.map((col) => col.name));
        if (!columnNames.has("is_subagent")) {
            this.db.exec("ALTER TABLE runs ADD COLUMN is_subagent INTEGER NOT NULL DEFAULT 0");
        }
        if (!columnNames.has("run_kind")) {
            this.db.exec("ALTER TABLE runs ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'core'");
        }
        if (!columnNames.has("parent_run_id")) {
            this.db.exec("ALTER TABLE runs ADD COLUMN parent_run_id TEXT");
        }
        if (!columnNames.has("parent_session_id")) {
            this.db.exec("ALTER TABLE runs ADD COLUMN parent_session_id TEXT");
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
    _ensureSynthesisSchema() {
        const columns = this.db.prepare("PRAGMA table_info(synthesis_metrics)").all();
        const columnNames = new Set(columns.map((col) => col.name));
        if (!columnNames.has("run_id")) {
            this.db.exec("ALTER TABLE synthesis_metrics ADD COLUMN run_id TEXT");
        }
        if (!columnNames.has("is_error")) {
            this.db.exec("ALTER TABLE synthesis_metrics ADD COLUMN is_error INTEGER NOT NULL DEFAULT 0");
        }
        if (!columnNames.has("error_type")) {
            this.db.exec("ALTER TABLE synthesis_metrics ADD COLUMN error_type TEXT");
        }
        if (!columnNames.has("error_message")) {
            this.db.exec("ALTER TABLE synthesis_metrics ADD COLUMN error_message TEXT");
        }
    }
    /**
     * Structured trace emitter. Uses the same `trace` table but writes
     * decomposed source/target/action/status columns with per-run seq counters.
     * Lazily initialized on first access.
     */
    get trace() {
        if (!this._traceEmitter) {
            this._traceEmitter = new TraceEmitter(this.db);
        }
        return this._traceEmitter;
    }
    logEvent(event) {
        if (this.debugDir)
            this._debugAppend(event);
        const sessionId = event.sessionId;
        const runId = "runId" in event ? event.runId : null;
        // ── Session lifecycle ──────────────────────────────────────────────────
        if (event.type === "session_start") {
            this._insertSession(sessionId, event.timestamp);
        }
        else if (event.type === "session_end") {
            this._finalizeSession(sessionId, event.timestamp);
        }
        // ── Run lifecycle ──────────────────────────────────────────────────────
        if (event.type === "prompt_received") {
            const runKind = event.runKind ?? (event.isSubagent ? "subagent" : "core");
            this._insertRun(event.runId, sessionId, event.timestamp, runKind, event.parentRunId, event.parentSessionId);
            this._incrementSessionPromptCount(sessionId);
        }
        if (event.type === "prompt_complete") {
            this._finalizeRun(event.runId, "done", event.timestamp);
        }
        else if (event.type === "prompt_error") {
            this._finalizeRun(event.runId, "error", event.timestamp);
        }
        if (event.type === "context_retrieved") {
            this.db
                .prepare(`INSERT INTO synthesis_metrics
             (session_id, run_id, timestamp, prompt_snippet, seed_count, expanded_count,
              tool_count, retrieval_ms, raw_chars, stripped_chars, estimated_tokens, is_error, error_type, error_message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)`)
                .run(sessionId, runId, event.timestamp, event.query.slice(0, 120), event.seedCount, event.expandedCount, event.toolCount, event.retrievalMs, event.rawChars, event.strippedChars, event.estimatedTokens);
        }
        // Log retrieval failures (tool_result errors for retrieve_context) so gaps are visible in metrics.
        if (event.type === "tool_result" && event.toolName === "retrieve_context" && event.isError) {
            const errorPayload = (() => {
                try {
                    return JSON.stringify(event.toolResult).slice(0, 240);
                }
                catch {
                    return String(event.toolResult).slice(0, 240);
                }
            })();
            this.db
                .prepare(`INSERT INTO synthesis_metrics
             (session_id, run_id, timestamp, prompt_snippet, seed_count, expanded_count,
              tool_count, retrieval_ms, raw_chars, stripped_chars, estimated_tokens, is_error, error_type, error_message)
           VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 1, 'tool_error', ?)`)
                .run(sessionId, runId, event.timestamp, "retrieve_context error", errorPayload);
        }
        this._insertTrace(runId, sessionId, event.type, event.timestamp, event);
    }
    /**
     * Insert a run row for a scheduler job execution.
     * Called by JobScheduler when a job starts.
     */
    insertJobRun(runId, sessionId, startTime, jobName) {
        this._insertRun(runId, sessionId, startTime, "job");
    }
    /**
     * Finalize a run row (set status + end_time).
     * Used by JobScheduler to close job runs.
     */
    finalizeRun(runId, status, endTime) {
        this._finalizeRun(runId, status, endTime);
    }
    /**
     * Mark a completed subagent run as awaiting human review.
     * Call this after the run finishes to change status from 'done' to 'awaiting_review'.
     */
    markAwaitingReview(runId) {
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
    recordReview(runId, score, feedback) {
        this.db
            .prepare(`UPDATE runs
         SET review_status = 'reviewed',
             utility_score = ?,
             review_feedback = ?,
             status = 'done'
         WHERE run_id = ?`)
            .run(score, feedback, runId);
    }
    /**
     * Get all runs awaiting human review.
     */
    getPendingReviews() {
        return this.db
            .prepare(`SELECT run_id, session_id, start_time, end_time FROM runs WHERE status = 'awaiting_review' ORDER BY end_time DESC`)
            .all();
    }
    /**
     * Get the output trace for a specific run (for review context).
     */
    getRunTrace(runId) {
        return this.db
            .prepare(`SELECT type, timestamp, payload FROM trace WHERE run_id = ? ORDER BY timestamp`)
            .all(runId);
    }
    close() {
        this.db.close();
    }
    // ── Private helpers ────────────────────────────────────────────────────────
    _insertSession(sessionId, timestamp) {
        this.db
            .prepare(`INSERT OR IGNORE INTO sessions (session_id, created_at, updated_at, status, prompt_count)
         VALUES (?, ?, ?, 'running', 0)`)
            .run(sessionId, timestamp, timestamp);
    }
    _finalizeSession(sessionId, timestamp) {
        this.db
            .prepare(`UPDATE sessions SET status = 'completed', updated_at = ? WHERE session_id = ?`)
            .run(timestamp, sessionId);
    }
    _incrementSessionPromptCount(sessionId) {
        this.db
            .prepare(`UPDATE sessions SET prompt_count = prompt_count + 1, updated_at = ? WHERE session_id = ?`)
            .run(Date.now(), sessionId);
    }
    _insertRun(runId, sessionId, startTime, runKind, parentRunId, parentSessionId) {
        const isSubagent = runKind !== "core" && runKind !== "job" ? 1 : 0;
        this.db
            .prepare(`INSERT OR IGNORE INTO runs (run_id, session_id, status, start_time, is_subagent, run_kind, parent_run_id, parent_session_id)
         VALUES (?, ?, 'running', ?, ?, ?, ?, ?)`)
            .run(runId, sessionId, startTime, isSubagent, runKind, parentRunId ?? null, parentSessionId ?? null);
    }
    _finalizeRun(runId, status, endTime) {
        this.db
            .prepare(`UPDATE runs SET status = ?, end_time = ? WHERE run_id = ?`)
            .run(status, endTime, runId);
    }
    _insertTrace(runId, sessionId, type, timestamp, event) {
        this.db
            .prepare(`INSERT INTO trace (run_id, session_id, type, timestamp, payload)
         VALUES (?, ?, ?, ?, ?)`)
            .run(runId, sessionId, type, timestamp, JSON.stringify(event));
    }
    _debugAppend(event) {
        const sessionId = event.sessionId;
        const filePath = join(this.debugDir, `${sessionId}.jsonl`);
        // Write a header comment on first event for this session
        if (!this.debugSessions.has(sessionId)) {
            this.debugSessions.add(sessionId);
            const header = `# session: ${sessionId}  started: ${new Date().toISOString()}\n`;
            appendText(filePath, header);
        }
        appendText(filePath, JSON.stringify(event) + "\n");
    }
}
//# sourceMappingURL=run-logger.js.map