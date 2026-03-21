/**
 * SqliteGraphStore — owns all graph persistence for ObsidiClaw.
 *
 * Three tables:
 *   notes        — canonical note records (upserted from md_db)
 *   edges        — directed wikilinks between notes
 *   index_state  — key/value store for sync metadata
 *
 * NOTE: better-sqlite3 is synchronous. Do NOT await any method here.
 *
 * NOTE (Windows / Node version): If you see a native binding error on startup,
 * run `npm rebuild better-sqlite3` with the exact Node version that runs the app.
 *
 * NOTE: getNotesByIds uses .all(...ids) spread — safe for vaults < ~800 notes
 * (SQLite default SQLITE_MAX_VARIABLE_NUMBER = 999). Chunk for larger vaults.
 */
import Database from "better-sqlite3";
// ---------------------------------------------------------------------------
// SqliteGraphStore
// ---------------------------------------------------------------------------
export class SqliteGraphStore {
    db;
    constructor(dbPath) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
        this.initSchema();
    }
    // ── Schema ────────────────────────────────────────────────────────────────
    /**
     * Current schema version. Bump this whenever a breaking schema change is made.
     * On mismatch, notes + edges are dropped and recreated (they are pure caches of md_db).
     */
    static SCHEMA_VERSION = 2;
    initSchema() {
        // Bootstrap index_state first (it holds the version and is never dropped)
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS index_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
        // Check stored schema version
        const row = this.db
            .prepare("SELECT value FROM index_state WHERE key = 'schema_version'")
            .get();
        const storedVersion = row ? parseInt(row.value, 10) : 0;
        if (storedVersion < SqliteGraphStore.SCHEMA_VERSION) {
            // Drop and recreate notes + edges so the new schema applies cleanly.
            // These tables are pure caches — md_db is the source of truth.
            this.db.exec(`
        DROP TABLE IF EXISTS edges;
        DROP TABLE IF EXISTS notes;
      `);
        }
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        note_id          TEXT PRIMARY KEY,
        path             TEXT NOT NULL UNIQUE,
        title            TEXT NOT NULL,
        note_type        TEXT NOT NULL CHECK(note_type IN ('tool','concept','index','codebase')),
        body             TEXT NOT NULL,
        tool_id          TEXT,
        frontmatter_json TEXT NOT NULL DEFAULT '{}',
        created_at       TEXT,
        updated_at       TEXT
      );

      CREATE TABLE IF NOT EXISTS edges (
        src_note_id  TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
        dst_note_id  TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
        PRIMARY KEY (src_note_id, dst_note_id)
      );

      CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_note_id);
    `);
        // Persist version so we don't migrate on the next startup
        this.db
            .prepare("INSERT OR REPLACE INTO index_state (key, value) VALUES ('schema_version', ?)")
            .run(String(SqliteGraphStore.SCHEMA_VERSION));
    }
    // ── Note operations ───────────────────────────────────────────────────────
    /**
     * Insert or replace a note.
     * WARNING: INSERT OR REPLACE deletes the old row, which cascades to edges.
     * Always call replaceEdges after upsertNote in a two-pass sync.
     */
    upsertNote(note) {
        this.db
            .prepare(`
        INSERT OR REPLACE INTO notes
          (note_id, path, title, note_type, body, tool_id, frontmatter_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
            .run(note.noteId, note.path, note.title, note.noteType, note.body, note.toolId ?? null, JSON.stringify(note.frontmatter), note.timeCreated ?? null, note.lastEdited ?? null);
    }
    getNoteByPath(path) {
        return (this.db
            .prepare("SELECT * FROM notes WHERE path = ?")
            .get(path) ?? null);
    }
    listAllNotes() {
        return this.db.prepare("SELECT * FROM notes").all();
    }
    getNotesByIds(ids) {
        if (ids.length === 0)
            return [];
        const placeholders = ids.map(() => "?").join(", ");
        return this.db
            .prepare(`SELECT * FROM notes WHERE note_id IN (${placeholders})`)
            .all(...ids);
    }
    // ── Edge operations ───────────────────────────────────────────────────────
    /**
     * Replace all outgoing edges from srcNoteId.
     * Filters dstNoteIds to only those that exist in the notes table
     * (to avoid foreign key violations on unresolved links).
     */
    replaceEdges(srcNoteId, dstNoteIds) {
        if (dstNoteIds.length === 0) {
            this.db.prepare("DELETE FROM edges WHERE src_note_id = ?").run(srcNoteId);
            return;
        }
        // Validate destinations exist
        const placeholders = dstNoteIds.map(() => "?").join(", ");
        const existing = this.db
            .prepare(`SELECT note_id FROM notes WHERE note_id IN (${placeholders})`)
            .all(...dstNoteIds);
        const validIds = new Set(existing.map((r) => r.note_id));
        const toInsert = dstNoteIds.filter((id) => validIds.has(id));
        const deleteStmt = this.db.prepare("DELETE FROM edges WHERE src_note_id = ?");
        const insertStmt = this.db.prepare("INSERT OR IGNORE INTO edges (src_note_id, dst_note_id) VALUES (?, ?)");
        const runTransaction = this.db.transaction(() => {
            deleteStmt.run(srcNoteId);
            for (const dstId of toInsert) {
                insertStmt.run(srcNoteId, dstId);
            }
        });
        runTransaction();
    }
    // ── Graph traversal ───────────────────────────────────────────────────────
    /**
     * BFS traversal starting from `startIds`, up to `maxDepth` hops.
     * Traverses BOTH forward edges (what this note links to) and
     * backward edges (what links to this note) for maximum recall.
     *
     * Returns only nodes not already in startIds.
     */
    getNeighbors(startIds, maxDepth = 1) {
        if (startIds.length === 0 || maxDepth <= 0)
            return [];
        const forwardStmt = this.db.prepare("SELECT dst_note_id AS neighborId FROM edges WHERE src_note_id = ?");
        const backwardStmt = this.db.prepare("SELECT src_note_id AS neighborId FROM edges WHERE dst_note_id = ?");
        const results = [];
        const visited = new Set(startIds);
        const queue = startIds.map((id) => ({
            noteId: id,
            depth: 0,
            linkedFrom: "",
        }));
        while (queue.length > 0) {
            const current = queue.shift();
            if (current.depth >= maxDepth)
                continue;
            const nextDepth = current.depth + 1;
            const forwardNeighbors = forwardStmt.all(current.noteId);
            const backwardNeighbors = backwardStmt.all(current.noteId);
            for (const { neighborId } of [...forwardNeighbors, ...backwardNeighbors]) {
                if (!visited.has(neighborId)) {
                    visited.add(neighborId);
                    results.push({ noteId: neighborId, depth: nextDepth, linkedFrom: current.noteId });
                    queue.push({ noteId: neighborId, depth: nextDepth, linkedFrom: current.noteId });
                }
            }
        }
        return results;
    }
    // ── Link resolution ───────────────────────────────────────────────────────
    /**
     * Resolve a raw wikilink text (e.g. "network") to a noteId.
     *
     * Matches notes whose path ends with "/<linkText>.md" or equals "<linkText>.md".
     * If multiple matches (ambiguous), prefers: tool > concept > index.
     *
     * Returns null if no note matches.
     */
    resolveLink(linkText) {
        const rows = this.db
            .prepare(`SELECT note_id, note_type FROM notes
         WHERE note_id = ?
            OR note_id LIKE ?`)
            .all(`${linkText}.md`, `%/${linkText}.md`);
        if (rows.length === 0)
            return null;
        if (rows.length === 1)
            return rows[0].note_id;
        // Multiple matches — prefer tool > concept > index
        const priority = { tool: 0, concept: 1, index: 2 };
        rows.sort((a, b) => (priority[a.note_type] ?? 3) - (priority[b.note_type] ?? 3));
        return rows[0].note_id;
    }
    // ── Index state ───────────────────────────────────────────────────────────
    setState(key, value) {
        this.db
            .prepare("INSERT OR REPLACE INTO index_state (key, value) VALUES (?, ?)")
            .run(key, value);
    }
    getState(key) {
        const row = this.db
            .prepare("SELECT value FROM index_state WHERE key = ?")
            .get(key);
        return row?.value ?? null;
    }
    // ── Database access ───────────────────────────────────────────────────────
    /**
     * Get access to the underlying SQLite database.
     * Used by extensions that need direct database access.
     */
    getDatabase() {
        return this.db;
    }
    // ── Lifecycle ─────────────────────────────────────────────────────────────
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=graph-store.js.map