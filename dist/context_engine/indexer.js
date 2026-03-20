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
import { readdir, readFile } from "fs/promises";
import { join, relative, extname } from "path";
import { Document, VectorStoreIndex } from "llamaindex";
/**
 * Recursively collect all .md file paths under a directory.
 */
async function collectMarkdownFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const paths = [];
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            paths.push(...(await collectMarkdownFiles(fullPath)));
        }
        else if (entry.isFile() && extname(entry.name) === ".md") {
            paths.push(fullPath);
        }
    }
    return paths;
}
/**
 * Load all markdown files from mdDbPath and return LlamaIndex Documents.
 * Each document's metadata includes the relative path from mdDbPath.
 */
export async function loadMdDbDocuments(mdDbPath) {
    const filePaths = await collectMarkdownFiles(mdDbPath);
    if (filePaths.length === 0) {
        console.warn(`[indexer] No .md files found in ${mdDbPath}`);
        return [];
    }
    const docs = [];
    for (const filePath of filePaths) {
        const text = await readFile(filePath, "utf-8");
        const relativePath = relative(mdDbPath, filePath).replace(/\\/g, "/");
        docs.push(new Document({
            text,
            metadata: {
                file_path: relativePath,
                // Infer note type from path prefix
                note_type: relativePath.startsWith("tools/")
                    ? "tool"
                    : relativePath.startsWith("concepts/")
                        ? "concept"
                        : "index",
            },
        }));
    }
    console.log(`[indexer] Loaded ${docs.length} documents from ${mdDbPath}`);
    return docs;
}
/**
 * Build a VectorStoreIndex from md_db documents.
 * Requires Settings.embedModel to be configured before calling.
 */
export async function buildIndex(mdDbPath) {
    const docs = await loadMdDbDocuments(mdDbPath);
    if (docs.length === 0) {
        // Return an empty index — retrieval will return no results
        // TODO: consider seeding with index.md so the graph is never truly empty
        return VectorStoreIndex.fromDocuments([
            new Document({
                text: "(empty knowledge base)",
                metadata: { file_path: "index.md", note_type: "index" },
            }),
        ]);
    }
    return VectorStoreIndex.fromDocuments(docs);
}
//# sourceMappingURL=indexer.js.map