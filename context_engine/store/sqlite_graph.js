"use strict";
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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteGraphStore = void 0;
var better_sqlite3_1 = require("better-sqlite3");
// ---------------------------------------------------------------------------
// SqliteGraphStore
// ---------------------------------------------------------------------------
var SqliteGraphStore = /** @class */ (function () {
    function SqliteGraphStore(dbPath) {
        this.db = new better_sqlite3_1.default(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
        this.initSchema();
    }
    // ── Schema ────────────────────────────────────────────────────────────────
    SqliteGraphStore.prototype.initSchema = function () {
        this.db.exec("\n      CREATE TABLE IF NOT EXISTS notes (\n        note_id          TEXT PRIMARY KEY,\n        path             TEXT NOT NULL UNIQUE,\n        title            TEXT NOT NULL,\n        note_type        TEXT NOT NULL CHECK(note_type IN ('tool','concept','index')),\n        body             TEXT NOT NULL,\n        tool_id          TEXT,\n        frontmatter_json TEXT NOT NULL DEFAULT '{}',\n        created_at       TEXT,\n        updated_at       TEXT\n      );\n\n      CREATE TABLE IF NOT EXISTS edges (\n        src_note_id  TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,\n        dst_note_id  TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,\n        PRIMARY KEY (src_note_id, dst_note_id)\n      );\n\n      CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_note_id);\n\n      CREATE TABLE IF NOT EXISTS index_state (\n        key   TEXT PRIMARY KEY,\n        value TEXT NOT NULL\n      );\n    ");
    };
    // ── Note operations ───────────────────────────────────────────────────────
    /**
     * Insert or replace a note.
     * WARNING: INSERT OR REPLACE deletes the old row, which cascades to edges.
     * Always call replaceEdges after upsertNote in a two-pass sync.
     */
    SqliteGraphStore.prototype.upsertNote = function (note) {
        var _a, _b, _c;
        this.db
            .prepare("\n        INSERT OR REPLACE INTO notes\n          (note_id, path, title, note_type, body, tool_id, frontmatter_json, created_at, updated_at)\n        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)\n      ")
            .run(note.noteId, note.path, note.title, note.noteType, note.body, (_a = note.toolId) !== null && _a !== void 0 ? _a : null, JSON.stringify(note.frontmatter), (_b = note.timeCreated) !== null && _b !== void 0 ? _b : null, (_c = note.lastEdited) !== null && _c !== void 0 ? _c : null);
    };
    SqliteGraphStore.prototype.getNoteByPath = function (path) {
        var _a;
        return ((_a = this.db
            .prepare("SELECT * FROM notes WHERE path = ?")
            .get(path)) !== null && _a !== void 0 ? _a : null);
    };
    SqliteGraphStore.prototype.listAllNotes = function () {
        return this.db.prepare("SELECT * FROM notes").all();
    };
    SqliteGraphStore.prototype.getNotesByIds = function (ids) {
        var _a;
        if (ids.length === 0)
            return [];
        var placeholders = ids.map(function () { return "?"; }).join(", ");
        return (_a = this.db
            .prepare("SELECT * FROM notes WHERE note_id IN (".concat(placeholders, ")")))
            .all.apply(_a, ids);
    };
    // ── Edge operations ───────────────────────────────────────────────────────
    /**
     * Replace all outgoing edges from srcNoteId.
     * Filters dstNoteIds to only those that exist in the notes table
     * (to avoid foreign key violations on unresolved links).
     */
    SqliteGraphStore.prototype.replaceEdges = function (srcNoteId, dstNoteIds) {
        var _a;
        if (dstNoteIds.length === 0) {
            this.db.prepare("DELETE FROM edges WHERE src_note_id = ?").run(srcNoteId);
            return;
        }
        // Validate destinations exist
        var placeholders = dstNoteIds.map(function () { return "?"; }).join(", ");
        var existing = (_a = this.db
            .prepare("SELECT note_id FROM notes WHERE note_id IN (".concat(placeholders, ")")))
            .all.apply(_a, dstNoteIds);
        var validIds = new Set(existing.map(function (r) { return r.note_id; }));
        var toInsert = dstNoteIds.filter(function (id) { return validIds.has(id); });
        var deleteStmt = this.db.prepare("DELETE FROM edges WHERE src_note_id = ?");
        var insertStmt = this.db.prepare("INSERT OR IGNORE INTO edges (src_note_id, dst_note_id) VALUES (?, ?)");
        var runTransaction = this.db.transaction(function () {
            deleteStmt.run(srcNoteId);
            for (var _i = 0, toInsert_1 = toInsert; _i < toInsert_1.length; _i++) {
                var dstId = toInsert_1[_i];
                insertStmt.run(srcNoteId, dstId);
            }
        });
        runTransaction();
    };
    // ── Graph traversal ───────────────────────────────────────────────────────
    /**
     * BFS traversal starting from `startIds`, up to `maxDepth` hops.
     * Traverses BOTH forward edges (what this note links to) and
     * backward edges (what links to this note) for maximum recall.
     *
     * Returns only nodes not already in startIds.
     */
    SqliteGraphStore.prototype.getNeighbors = function (startIds, maxDepth) {
        if (maxDepth === void 0) { maxDepth = 1; }
        if (startIds.length === 0 || maxDepth <= 0)
            return [];
        var forwardStmt = this.db.prepare("SELECT dst_note_id AS neighborId FROM edges WHERE src_note_id = ?");
        var backwardStmt = this.db.prepare("SELECT src_note_id AS neighborId FROM edges WHERE dst_note_id = ?");
        var results = [];
        var visited = new Set(startIds);
        var queue = startIds.map(function (id) { return ({
            noteId: id,
            depth: 0,
            linkedFrom: "",
        }); });
        while (queue.length > 0) {
            var current = queue.shift();
            if (current.depth >= maxDepth)
                continue;
            var nextDepth = current.depth + 1;
            var forwardNeighbors = forwardStmt.all(current.noteId);
            var backwardNeighbors = backwardStmt.all(current.noteId);
            for (var _i = 0, _a = __spreadArray(__spreadArray([], forwardNeighbors, true), backwardNeighbors, true); _i < _a.length; _i++) {
                var neighborId = _a[_i].neighborId;
                if (!visited.has(neighborId)) {
                    visited.add(neighborId);
                    results.push({ noteId: neighborId, depth: nextDepth, linkedFrom: current.noteId });
                    queue.push({ noteId: neighborId, depth: nextDepth, linkedFrom: current.noteId });
                }
            }
        }
        return results;
    };
    // ── Link resolution ───────────────────────────────────────────────────────
    /**
     * Resolve a raw wikilink text (e.g. "network") to a noteId.
     *
     * Matches notes whose path ends with "/<linkText>.md" or equals "<linkText>.md".
     * If multiple matches (ambiguous), prefers: tool > concept > index.
     *
     * Returns null if no note matches.
     */
    SqliteGraphStore.prototype.resolveLink = function (linkText) {
        var rows = this.db
            .prepare("SELECT note_id, note_type FROM notes\n         WHERE note_id = ?\n            OR note_id LIKE ?")
            .all("".concat(linkText, ".md"), "%/".concat(linkText, ".md"));
        if (rows.length === 0)
            return null;
        if (rows.length === 1)
            return rows[0].note_id;
        // Multiple matches — prefer tool > concept > index
        var priority = { tool: 0, concept: 1, index: 2 };
        rows.sort(function (a, b) { var _a, _b; return ((_a = priority[a.note_type]) !== null && _a !== void 0 ? _a : 3) - ((_b = priority[b.note_type]) !== null && _b !== void 0 ? _b : 3); });
        return rows[0].note_id;
    };
    // ── Index state ───────────────────────────────────────────────────────────
    SqliteGraphStore.prototype.setState = function (key, value) {
        this.db
            .prepare("INSERT OR REPLACE INTO index_state (key, value) VALUES (?, ?)")
            .run(key, value);
    };
    SqliteGraphStore.prototype.getState = function (key) {
        var _a;
        var row = this.db
            .prepare("SELECT value FROM index_state WHERE key = ?")
            .get(key);
        return (_a = row === null || row === void 0 ? void 0 : row.value) !== null && _a !== void 0 ? _a : null;
    };
    // ── Lifecycle ─────────────────────────────────────────────────────────────
    SqliteGraphStore.prototype.close = function () {
        this.db.close();
    };
    return SqliteGraphStore;
}());
exports.SqliteGraphStore = SqliteGraphStore;
