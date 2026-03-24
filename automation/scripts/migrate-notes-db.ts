/**
 * One-time migration: move note analytics tables from runs.db to notes.db.
 *
 * What it does:
 *   1. Copies note_hits, synthesis_metrics, context_ratings from runs.db → notes.db
 *   2. Copies prune_clusters, prune_cluster_members from prune.db → notes.db (if prune.db exists)
 *   3. Drops the migrated tables from runs.db
 *   4. Deletes prune.db after successful migration
 *
 * Safe to run multiple times — skips tables that don't exist in the source.
 *
 * Usage: npx tsx --env-file=.env automation/scripts/migrate-notes-db.ts
 */

import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "fs";
import { resolvePaths } from "../../core/config.js";

const paths = resolvePaths();
const runsDbPath = paths.dbPath;
const notesDbPath = paths.notesDbPath;
const pruneDbPath = runsDbPath.replace("runs.db", "prune.db");

console.log("=== ObsidiClaw: Migrate note analytics to notes.db ===\n");
console.log(`  runs.db:  ${runsDbPath}`);
console.log(`  notes.db: ${notesDbPath}`);
console.log(`  prune.db: ${pruneDbPath}\n`);

// ── Open databases ────────────────────────────────────────────────────────

if (!existsSync(runsDbPath)) {
  console.log("No runs.db found — nothing to migrate.");
  process.exit(0);
}

const runsDb = new Database(runsDbPath);
const notesDb = new Database(notesDbPath);
notesDb.pragma("journal_mode = WAL");

// ── Ensure notes.db schema ───────────────────────────────────────────────

// Import NoteMetricsLogger to initialize the schema
import { NoteMetricsLogger } from "../../logger/note-metrics.js";
const metricsLogger = new NoteMetricsLogger(notesDbPath);

// ── Helper: check if table exists ─────────────────────────────────────────

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) as { name: string } | undefined;
  return !!row;
}

// ── Migrate runs.db tables ───────────────────────────────────────────────

const runsDbTables = ["note_hits", "synthesis_metrics", "context_ratings"];

for (const table of runsDbTables) {
  if (!tableExists(runsDb, table)) {
    console.log(`  [skip] ${table} — not found in runs.db`);
    continue;
  }

  const rows = runsDb.prepare(`SELECT * FROM ${table}`).all();
  if (rows.length === 0) {
    console.log(`  [skip] ${table} — 0 rows`);
    // Still drop it
    runsDb.exec(`DROP TABLE IF EXISTS ${table}`);
    console.log(`  [drop] ${table} dropped from runs.db`);
    continue;
  }

  // Build insert statement from column names
  const columns = runsDb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  const colNames = columns.map((c) => c.name).filter((n) => n !== "id"); // skip autoincrement id

  // Check if notes.db has extra columns (tier fields) — only insert columns that exist in source
  const notesColumns = notesDb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  const notesColSet = new Set(notesColumns.map((c) => c.name));
  const validCols = colNames.filter((c) => notesColSet.has(c));

  const placeholders = validCols.map(() => "?").join(", ");
  const insertStmt = notesDb.prepare(
    `INSERT INTO ${table} (${validCols.join(", ")}) VALUES (${placeholders})`
  );

  const insertAll = notesDb.transaction((data: Record<string, unknown>[]) => {
    for (const row of data) {
      insertStmt.run(...validCols.map((c) => (row as Record<string, unknown>)[c] ?? null));
    }
  });

  insertAll(rows as Record<string, unknown>[]);
  console.log(`  [copy] ${table}: ${rows.length} rows → notes.db`);

  // Drop from runs.db
  runsDb.exec(`DROP TABLE IF EXISTS ${table}`);
  console.log(`  [drop] ${table} dropped from runs.db`);
}

// Also drop related indexes from runs.db
for (const idx of [
  "idx_note_hits_note", "idx_note_hits_session",
  "synthesis_session", "synthesis_run_id",
  "idx_context_ratings_session", "idx_context_ratings_score",
]) {
  runsDb.exec(`DROP INDEX IF EXISTS ${idx}`);
}

// ── Migrate prune.db ────────────────────────────────────────────────────

if (existsSync(pruneDbPath)) {
  const pruneDb = new Database(pruneDbPath);
  const pruneTables = ["prune_clusters", "prune_cluster_members"];

  for (const table of pruneTables) {
    if (!tableExists(pruneDb, table)) {
      console.log(`  [skip] ${table} — not found in prune.db`);
      continue;
    }

    const rows = pruneDb.prepare(`SELECT * FROM ${table}`).all();
    if (rows.length === 0) {
      console.log(`  [skip] ${table} — 0 rows`);
      continue;
    }

    const columns = pruneDb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    const colNames = columns.map((c) => c.name);
    const placeholders = colNames.map(() => "?").join(", ");
    const insertStmt = notesDb.prepare(
      `INSERT OR REPLACE INTO ${table} (${colNames.join(", ")}) VALUES (${placeholders})`
    );

    const insertAll = notesDb.transaction((data: Record<string, unknown>[]) => {
      for (const row of data) {
        insertStmt.run(...colNames.map((c) => (row as Record<string, unknown>)[c] ?? null));
      }
    });

    insertAll(rows as Record<string, unknown>[]);
    console.log(`  [copy] ${table}: ${rows.length} rows → notes.db`);
  }

  pruneDb.close();

  // Delete prune.db and its WAL/SHM files
  unlinkSync(pruneDbPath);
  if (existsSync(pruneDbPath + "-wal")) unlinkSync(pruneDbPath + "-wal");
  if (existsSync(pruneDbPath + "-shm")) unlinkSync(pruneDbPath + "-shm");
  console.log(`  [delete] prune.db removed`);
} else {
  console.log(`  [skip] prune.db — not found`);
}

// ── Cleanup ─────────────────────────────────────────────────────────────

metricsLogger.close();
runsDb.close();
notesDb.close();

console.log("\n=== Migration complete ===");
