/**
 * NoteMetricsLogger — SQLite-backed note retrieval analytics.
 *
 * Owns `.obsidi-claw/notes.db` with tables:
 *   note_hits          — per-note retrieval tracking (3-tier-aware)
 *   synthesis_metrics  — per-query retrieval performance
 *   context_ratings    — agent self-grading of context quality
 *   note_lifecycle     — note creation/modification/reindex events
 *   prune_clusters     — deduplication cluster metadata
 *   prune_cluster_members — cluster membership
 */

import Database from "better-sqlite3";
import { dirname } from "path";
import { ensureDir } from "../core/os/fs.js";
import { PruneClusterStorage } from "../knowledge/engine/prune/prune-storage.js";
import type { PruneCluster } from "../knowledge/engine/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NoteHit {
  noteId: string;
  score: number;
  depth: number;
  source: string;
  tier?: string;
  noteType?: string;
  symbolKind?: string;
  edgeLabel?: string;
}

export interface RetrievalEvent {
  sessionId: string;
  runId?: string;
  timestamp: number;
  query: string;
  seedCount: number;
  expandedCount: number;
  toolCount: number;
  retrievalMs: number;
  rawChars: number;
  strippedChars: number;
  estimatedTokens: number;
  noteHits?: NoteHit[];
}

export interface RetrievalErrorEvent {
  sessionId: string;
  runId?: string;
  timestamp: number;
  errorPayload: string;
}

export interface RatingEvent {
  sessionId: string;
  runId?: string;
  timestamp: number;
  query: string;
  score: number;
  missing: string;
  helpful: string;
}

export type LifecycleEventKind = "created" | "mirrored" | "summarized" | "reindexed" | "pruned";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export class NoteMetricsLogger {
  private readonly db: Database.Database;
  private readonly _pruneStorage: PruneClusterStorage;

  constructor(dbPath: string) {
    ensureDir(dirname(dbPath));
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this._initSchema();
    this._pruneStorage = new PruneClusterStorage(this.db);
  }

  private _initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS note_hits (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT    NOT NULL,
        run_id       TEXT,
        timestamp    INTEGER NOT NULL,
        note_id      TEXT    NOT NULL,
        score        REAL    NOT NULL,
        depth        INTEGER NOT NULL,
        source       TEXT    NOT NULL,
        tier         TEXT,
        note_type    TEXT,
        symbol_kind  TEXT,
        edge_label   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_note_hits_note    ON note_hits(note_id);
      CREATE INDEX IF NOT EXISTS idx_note_hits_session ON note_hits(session_id);
      CREATE INDEX IF NOT EXISTS idx_note_hits_tier    ON note_hits(tier);

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
        error_message    TEXT,
        tier_1_count     INTEGER NOT NULL DEFAULT 0,
        tier_2_count     INTEGER NOT NULL DEFAULT 0,
        tier_3_count     INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_synthesis_session ON synthesis_metrics(session_id);
      CREATE INDEX IF NOT EXISTS idx_synthesis_run_id  ON synthesis_metrics(run_id);

      CREATE TABLE IF NOT EXISTS context_ratings (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT    NOT NULL,
        run_id       TEXT,
        timestamp    INTEGER NOT NULL,
        query        TEXT    NOT NULL,
        score        INTEGER NOT NULL,
        missing      TEXT    NOT NULL DEFAULT '',
        helpful      TEXT    NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_context_ratings_session ON context_ratings(session_id);
      CREATE INDEX IF NOT EXISTS idx_context_ratings_score   ON context_ratings(score);

      CREATE TABLE IF NOT EXISTS note_lifecycle (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id   TEXT    NOT NULL,
        event     TEXT    NOT NULL,
        timestamp INTEGER NOT NULL,
        tier      TEXT,
        metadata  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_lifecycle_note  ON note_lifecycle(note_id);
      CREATE INDEX IF NOT EXISTS idx_lifecycle_event ON note_lifecycle(event);

      CREATE TABLE IF NOT EXISTS job_runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        job_name     TEXT    NOT NULL,
        workspace    TEXT,
        started_at   INTEGER NOT NULL,
        finished_at  INTEGER,
        status       TEXT    NOT NULL DEFAULT 'running',
        error_text   TEXT,
        stats_json   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_job_runs_name   ON job_runs(job_name);
      CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs(status);

      CREATE TABLE IF NOT EXISTS job_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        job_run_id  INTEGER NOT NULL,
        timestamp   INTEGER NOT NULL,
        level       TEXT    NOT NULL,
        message     TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_job_logs_run ON job_logs(job_run_id);
    `);
  }

  // ── Retrieval logging ─────────────────────────────────────────────────────

  logRetrieval(event: RetrievalEvent): void {
    const tierCounts = { "1": 0, "2": 0, "3": 0 };
    if (event.noteHits) {
      for (const hit of event.noteHits) {
        if (hit.tier === "1" || hit.tier === "2" || hit.tier === "3") {
          tierCounts[hit.tier]++;
        }
      }
    }

    this.db
      .prepare(
        `INSERT INTO synthesis_metrics
           (session_id, run_id, timestamp, prompt_snippet, seed_count, expanded_count,
            tool_count, retrieval_ms, raw_chars, stripped_chars, estimated_tokens,
            is_error, error_type, error_message, tier_1_count, tier_2_count, tier_3_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?)`
      )
      .run(
        event.sessionId,
        event.runId ?? null,
        event.timestamp,
        event.query.slice(0, 120),
        event.seedCount,
        event.expandedCount,
        event.toolCount,
        event.retrievalMs,
        event.rawChars,
        event.strippedChars,
        event.estimatedTokens,
        tierCounts["1"],
        tierCounts["2"],
        tierCounts["3"],
      );

    if (event.noteHits?.length) {
      const insertHit = this.db.prepare(
        `INSERT INTO note_hits
           (session_id, run_id, timestamp, note_id, score, depth, source, tier, note_type, symbol_kind, edge_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertMany = this.db.transaction((hits: NoteHit[]) => {
        for (const hit of hits) {
          insertHit.run(
            event.sessionId,
            event.runId ?? null,
            event.timestamp,
            hit.noteId,
            hit.score,
            hit.depth,
            hit.source,
            hit.tier ?? null,
            hit.noteType ?? null,
            hit.symbolKind ?? null,
            hit.edgeLabel ?? null,
          );
        }
      });
      insertMany(event.noteHits);
    }
  }

  logRetrievalError(event: RetrievalErrorEvent): void {
    this.db
      .prepare(
        `INSERT INTO synthesis_metrics
           (session_id, run_id, timestamp, prompt_snippet, seed_count, expanded_count,
            tool_count, retrieval_ms, raw_chars, stripped_chars, estimated_tokens,
            is_error, error_type, error_message, tier_1_count, tier_2_count, tier_3_count)
         VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 1, 'tool_error', ?, 0, 0, 0)`
      )
      .run(
        event.sessionId,
        event.runId ?? null,
        event.timestamp,
        "retrieve_context error",
        event.errorPayload,
      );
  }

  // ── Rating logging ────────────────────────────────────────────────────────

  logRating(event: RatingEvent): void {
    this.db
      .prepare(
        `INSERT INTO context_ratings (session_id, run_id, timestamp, query, score, missing, helpful)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.sessionId,
        event.runId ?? null,
        event.timestamp,
        event.query,
        event.score,
        event.missing,
        event.helpful,
      );
  }

  // ── Lifecycle logging ─────────────────────────────────────────────────────

  logLifecycleEvent(
    noteId: string,
    event: LifecycleEventKind,
    tier?: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO note_lifecycle (note_id, event, timestamp, tier, metadata)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        noteId,
        event,
        Date.now(),
        tier ?? null,
        metadata ? JSON.stringify(metadata) : null,
      );
  }

  // ── Job logging (background workers: summarize cascade, etc.) ────────────

  /** Record a new job invocation. Returns the integer row ID used for subsequent calls. */
  startJob(jobName: string, workspace?: string): number {
    const result = this.db
      .prepare(`INSERT INTO job_runs (job_name, workspace, started_at) VALUES (?, ?, ?)`)
      .run(jobName, workspace ?? null, Date.now());
    return result.lastInsertRowid as number;
  }

  /** Append a log line to a running job. */
  logJobMessage(jobRunId: number, level: "info" | "warn" | "error", message: string): void {
    this.db
      .prepare(`INSERT INTO job_logs (job_run_id, timestamp, level, message) VALUES (?, ?, ?, ?)`)
      .run(jobRunId, Date.now(), level, message);
  }

  /** Mark a job as finished with outcome. */
  finishJob(
    jobRunId: number,
    status: "complete" | "error",
    opts?: { errorText?: string; statsJson?: Record<string, unknown> },
  ): void {
    this.db
      .prepare(
        `UPDATE job_runs SET finished_at = ?, status = ?, error_text = ?, stats_json = ? WHERE id = ?`,
      )
      .run(
        Date.now(),
        status,
        opts?.errorText ?? null,
        opts?.statsJson ? JSON.stringify(opts.statsJson) : null,
        jobRunId,
      );
  }

  // ── Prune storage ─────────────────────────────────────────────────────────

  get pruneStorage(): PruneClusterStorage {
    return this._pruneStorage;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
