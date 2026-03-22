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
// TODO: Split file discovery/hash logic from graph sync + vector index building.
// This module currently mixes filesystem scanning, graph persistence, and embedding concerns.
import { readdir, readFile, stat } from "fs/promises";
import { join, relative, extname } from "path";
import { createHash } from "crypto";
import { Document, VectorStoreIndex } from "llamaindex";
import { parseMarkdownFile } from "./ingest/note-parser.js";
export async function collectMarkdownFiles(dir, options) {
    const ignoredDirs = new Set(options?.ignoredDirs ?? [".obsidian"]);
    const entries = await readdir(dir, { withFileTypes: true });
    const paths = [];
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (ignoredDirs.has(entry.name))
                continue;
            paths.push(...(await collectMarkdownFiles(fullPath, { ignoredDirs: [...ignoredDirs] })));
        }
        else if (entry.isFile() && extname(entry.name) === ".md") {
            paths.push(fullPath);
        }
    }
    return paths;
}
// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------
/**
 * Compute a fingerprint of all .md files in mdDbPath based on their
 * modification times. Returns the same hash for the same set of files
 * with unchanged mtimes; changes if any file is added, removed, or edited.
 */
export async function computeMdDbHash(mdDbPath) {
    const filePaths = await collectMarkdownFiles(mdDbPath);
    const entries = await Promise.all(filePaths.map(async (p) => {
        const s = await stat(p);
        return `${p}:${s.mtimeMs}`;
    }));
    entries.sort(); // deterministic regardless of readdir order
    return createHash("md5").update(entries.join("|")).digest("hex");
}
// ---------------------------------------------------------------------------
// Two-pass graph sync
// ---------------------------------------------------------------------------
/**
 * Parse all .md files from mdDbPath and sync them into the graph store.
 *
 * Pass 1: upsert every note (notes table must be complete before edges).
 * Pass 2: resolve [[wikilinks]] and replace edges for each note.
 *
 * Unresolved links (notes not in the db) are silently dropped —
 * SqliteGraphStore.replaceEdges filters them out.
 */
export async function syncMdDbToGraph(mdDbPath, graphStore) {
    const filePaths = await collectMarkdownFiles(mdDbPath);
    if (filePaths.length === 0) {
        console.warn(`[indexer] No .md files found in ${mdDbPath}`);
        return;
    }
    // Pass 1 — parse + upsert notes
    const parsedNotes = await Promise.all(filePaths.map(async (fullPath) => {
        const content = await readFile(fullPath, "utf-8");
        const relativePath = relative(mdDbPath, fullPath).replace(/\\/g, "/");
        return parseMarkdownFile(content, relativePath);
    }));
    for (const note of parsedNotes) {
        graphStore.upsertNote(note);
    }
    // Pass 2 — resolve wikilinks + insert edges
    for (const note of parsedNotes) {
        const resolvedIds = [];
        for (const linkText of note.linksOut) {
            const dstId = graphStore.resolveLink(linkText);
            if (dstId !== null) {
                resolvedIds.push(dstId);
            }
        }
        graphStore.replaceEdges(note.noteId, resolvedIds);
    }
}
// ---------------------------------------------------------------------------
// Vector index from graph
// ---------------------------------------------------------------------------
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
export async function buildVectorIndexFromGraph(graphStore, storageContext) {
    const notes = graphStore.listAllNotes();
    const docs = notes.length === 0
        ? [
            new Document({
                text: "(empty knowledge base)",
                metadata: { file_path: "index.md", note_type: "index" },
            }),
        ]
        : notes.map((n) => new Document({
            text: n.body,
            metadata: {
                file_path: n.path,
                note_type: n.note_type,
                tool_id: n.tool_id ?? "",
            },
        }));
    return storageContext
        ? VectorStoreIndex.fromDocuments(docs, { storageContext })
        : VectorStoreIndex.fromDocuments(docs);
}
//# sourceMappingURL=graph-indexer.js.map