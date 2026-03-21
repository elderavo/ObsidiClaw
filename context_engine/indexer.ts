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

import { readdir, readFile } from "fs/promises";
import { join, relative, extname } from "path";
import { Document, VectorStoreIndex } from "llamaindex";
import { parseMarkdownFile } from "./ingest/parser.js";
import type { SqliteGraphStore } from "./store/sqlite_graph.js";
import { LinkGraphProcessor } from "./link_graph/index.js";

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await collectMarkdownFiles(fullPath)));
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      paths.push(fullPath);
    }
  }

  return paths;
}

// ---------------------------------------------------------------------------
// Two-pass graph sync
// ---------------------------------------------------------------------------

/**
 * Parse all .md files from mdDbPath and sync them into the graph store.
 *
 * Pass 1: upsert every note (notes table must be complete before edges).
 * Pass 2: resolve [[wikilinks]] and replace edges for each note.
 * Pass 3: build enhanced link graph with cycle detection and validation.
 *
 * Unresolved links (notes not in the db) are silently dropped —
 * SqliteGraphStore.replaceEdges filters them out.
 */
export async function syncMdDbToGraph(
  mdDbPath: string,
  graphStore: SqliteGraphStore,
): Promise<void> {
  const filePaths = await collectMarkdownFiles(mdDbPath);

  if (filePaths.length === 0) {
    console.warn(`[indexer] No .md files found in ${mdDbPath}`);
    return;
  }

  // Pass 1 — parse + upsert notes
  const parsedNotes = await Promise.all(
    filePaths.map(async (fullPath) => {
      const content = await readFile(fullPath, "utf-8");
      const relativePath = relative(mdDbPath, fullPath).replace(/\\/g, "/");
      return parseMarkdownFile(content, relativePath);
    }),
  );

  for (const note of parsedNotes) {
    graphStore.upsertNote(note);
  }

  //console.log(`[indexer] Upserted ${parsedNotes.length} notes into graph`);

  // Pass 2 — resolve wikilinks + insert edges
  for (const note of parsedNotes) {
    const resolvedIds: string[] = [];
    for (const linkText of note.linksOut) {
      const dstId = graphStore.resolveLink(linkText);
      if (dstId !== null) {
        resolvedIds.push(dstId);
      }
    }
    graphStore.replaceEdges(note.noteId, resolvedIds);
  }

  const totalLinks = parsedNotes.reduce((sum, n) => sum + n.linksOut.length, 0);
  //console.log(`[indexer] Resolved edges (${totalLinks} raw links → graph)`);

  // Pass 3 — build enhanced link graph with cycle detection
  await buildEnhancedLinkGraph(mdDbPath, graphStore);
}

/**
 * Build enhanced link graph with cycle detection and validation.
 * This runs as part of the standard indexing process.
 */
async function buildEnhancedLinkGraph(
  mdDbPath: string, 
  graphStore: SqliteGraphStore
): Promise<void> {
  try {
    // Access the internal DB from graphStore
    const linkProcessor = new LinkGraphProcessor(graphStore.getDatabase(), mdDbPath);
    
    // Build the enhanced link graph (stores rich wikilink metadata + cycle detection)
    // Validation (broken links, orphans) is intentionally deferred — it runs LCS-based
    // fuzzy matching which is too slow for the startup path. Call linkProcessor.isHealthy()
    // explicitly when you need a validation report (e.g. Phase 7 insight engine).
    await linkProcessor.buildFromMarkdownFiles();
    
  } catch (error) {
    console.error('[indexer] Enhanced link graph build failed:', error);
    // Don't fail the entire indexing process for link graph issues
  }
}

// ---------------------------------------------------------------------------
// Vector index from graph
// ---------------------------------------------------------------------------

/**
 * Build a LlamaIndex VectorStoreIndex from notes already in the graph store.
 * Requires Settings.embedModel to be configured before calling.
 *
 * Uses the stored body (frontmatter stripped) as document text.
 * Metadata includes file_path (= noteId) and note_type for downstream filtering.
 */
export async function buildVectorIndexFromGraph(
  graphStore: SqliteGraphStore,
): Promise<VectorStoreIndex> {
  const notes = graphStore.listAllNotes();

  const docs: Document[] =
    notes.length === 0
      ? [
          new Document({
            text: "(empty knowledge base)",
            metadata: { file_path: "index.md", note_type: "index" },
          }),
        ]
      : notes.map(
          (n) =>
            new Document({
              text: n.body,
              metadata: {
                file_path: n.path,
                note_type: n.note_type,
                tool_id: n.tool_id ?? "",
              },
            }),
        );

  //console.log(`[indexer] Building vector index over ${docs.length} notes`);
  return VectorStoreIndex.fromDocuments(docs);
}
