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
 * TODO: Phase 5 — persist index to disk to avoid re-embedding every startup
 * TODO: Phase 5 — watch md_db for changes and incrementally update
 * TODO: Phase 8 — re-index after insight_engine writes new notes
 */
import { VectorStoreIndex } from "llamaindex";
import type { SqliteGraphStore } from "./store/sqlite_graph.js";
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
 * Uses the stored body (frontmatter stripped) as document text.
 * Metadata includes file_path (= noteId) and note_type for downstream filtering.
 */
export declare function buildVectorIndexFromGraph(graphStore: SqliteGraphStore): Promise<VectorStoreIndex>;
//# sourceMappingURL=indexer.d.ts.map