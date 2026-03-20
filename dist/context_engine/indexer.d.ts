/**
 * Indexer — loads md_db markdown files and builds a LlamaIndex VectorStoreIndex.
 *
 * Design notes:
 * - Reads all .md files from md_db/ recursively using Node.js fs
 * - Creates a LlamaIndex Document per file, with path metadata
 * - Builds an in-memory VectorStoreIndex (no disk persistence yet)
 *
 * TODO: Phase 5 — persist index to disk to avoid re-indexing every startup
 * TODO: Phase 5 — watch md_db for changes and incrementally update index
 * TODO: Phase 8 — re-index after insight_engine writes new notes to md_db
 */
import { Document, VectorStoreIndex } from "llamaindex";
/**
 * Load all markdown files from mdDbPath and return LlamaIndex Documents.
 * Each document's metadata includes the relative path from mdDbPath.
 */
export declare function loadMdDbDocuments(mdDbPath: string): Promise<Document[]>;
/**
 * Build a VectorStoreIndex from md_db documents.
 * Requires Settings.embedModel to be configured before calling.
 */
export declare function buildIndex(mdDbPath: string): Promise<VectorStoreIndex>;
//# sourceMappingURL=indexer.d.ts.map