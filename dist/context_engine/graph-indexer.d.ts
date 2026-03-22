/**
 * Indexer — syncs md_db to the SQLite graph store and builds a LlamaIndex
 * VectorStoreIndex from the stored notes.
 *
 * Two-pass sync (required for foreign-key safe edge insertion):
 *   Pass 1 — parse + upsert all notes into the notes table
 *   Pass 2 — resolve [[wikilinks]] and insert edges
 *
 * buildVectorIndexFromGraph reads notes directly from SQLite so the vector
 * index is always consistent with the graph.
 *
 * computeMdDbHash produces an mtime fingerprint of all md_db files.
 * ContextEngine uses this to skip re-sync and re-embedding when nothing
 * has changed since the last run (see context-engine.ts initialize()).
 */
import { VectorStoreIndex } from "llamaindex";
import type { StorageContext } from "llamaindex";
import type { SqliteGraphStore } from "./store/graph-store.js";
type CollectOptions = {
    /** Directory basenames to skip (non-recursive into them). */
    ignoredDirs?: string[];
};
export declare function collectMarkdownFiles(dir: string, options?: CollectOptions): Promise<string[]>;
/**
 * Compute a fingerprint of all .md files in mdDbPath based on their
 * modification times. Returns the same hash for the same set of files
 * with unchanged mtimes; changes if any file is added, removed, or edited.
 */
export declare function computeMdDbHash(mdDbPath: string): Promise<string>;
/**
 * Parse all .md files from mdDbPath and sync them into the graph store.
 *
 * Pass 1: upsert every note (notes table must be complete before edges).
 * Pass 2: resolve [[wikilinks]] and replace edges for each note.
 *
 * Unresolved links (notes not in the db) are silently dropped —
 * SqliteGraphStore.replaceEdges filters them out.
 */
export declare function syncMdDbToGraph(mdDbPath: string, graphStore: SqliteGraphStore): Promise<void>;
/**
 * Build a LlamaIndex VectorStoreIndex from notes already in the graph store.
 * Requires Settings.embedModel to be configured before calling.
 *
 * Pass storageContext (created with persistDir) to auto-persist embeddings
 * to disk so they can be reloaded without re-embedding on the next startup.
 *
 * Uses the stored body (frontmatter stripped) as document text.
 * Metadata includes file_path (= noteId) and note_type for downstream filtering.
 */
export declare function buildVectorIndexFromGraph(graphStore: SqliteGraphStore, storageContext?: StorageContext): Promise<VectorStoreIndex>;
export {};
//# sourceMappingURL=graph-indexer.d.ts.map