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
import type { Database as DB } from "better-sqlite3";
import type { ParsedNote } from "../ingest/note-models.js";
export interface StoredNote {
    note_id: string;
    path: string;
    title: string;
    note_type: string;
    body: string;
    tool_id: string | null;
    frontmatter_json: string;
    created_at: string | null;
    updated_at: string | null;
}
export interface NeighborResult {
    /** The neighbor's noteId. */
    noteId: string;
    /** Hop distance from the closest seed. */
    depth: number;
    /** noteId of the node that links to/from this one at this depth. */
    linkedFrom: string;
}
export declare class SqliteGraphStore {
    private readonly db;
    constructor(dbPath: string);
    /**
     * Current schema version. Bump this whenever a breaking schema change is made.
     * On mismatch, notes + edges are dropped and recreated (they are pure caches of md_db).
     */
    private static readonly SCHEMA_VERSION;
    private initSchema;
    /**
     * Insert or replace a note.
     * WARNING: INSERT OR REPLACE deletes the old row, which cascades to edges.
     * Always call replaceEdges after upsertNote in a two-pass sync.
     */
    upsertNote(note: ParsedNote): void;
    getNoteByPath(path: string): StoredNote | null;
    listAllNotes(): StoredNote[];
    getNotesByIds(ids: string[]): StoredNote[];
    /**
     * Replace all outgoing edges from srcNoteId.
     * Filters dstNoteIds to only those that exist in the notes table
     * (to avoid foreign key violations on unresolved links).
     */
    replaceEdges(srcNoteId: string, dstNoteIds: string[]): void;
    /**
     * BFS traversal starting from `startIds`, up to `maxDepth` hops.
     * Traverses BOTH forward edges (what this note links to) and
     * backward edges (what links to this note) for maximum recall.
     *
     * Returns only nodes not already in startIds.
     */
    getNeighbors(startIds: string[], maxDepth?: number): NeighborResult[];
    /**
     * Resolve a raw wikilink text (e.g. "network") to a noteId.
     *
     * Matches notes whose path ends with "/<linkText>.md" or equals "<linkText>.md".
     * If multiple matches (ambiguous), prefers: tool > concept > index.
     *
     * Returns null if no note matches.
     */
    resolveLink(linkText: string): string | null;
    setState(key: string, value: string): void;
    getState(key: string): string | null;
    /**
     * Get access to the underlying SQLite database.
     * Used by extensions that need direct database access.
     */
    getDatabase(): DB;
    close(): void;
}
//# sourceMappingURL=graph-store.d.ts.map