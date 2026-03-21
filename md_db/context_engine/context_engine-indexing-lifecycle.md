---
title: Context Engine Indexing Lifecycle
type: concept
---

# Context Engine Indexing Lifecycle

Describes how `md_db/` is synchronized into SQLite and the vector index.

## High-level phases

1. **Initialize embeddings and DB**
   - `ContextEngine.initialize()`:
     - Creates `.obsidi-claw/` directory if needed.
     - Configures `Settings.embedModel` with `OllamaEmbedding` (host + model from config/env).
     - Opens [[sqlite-graph-store]] (`SqliteGraphStore` with schema migration).

2. **Change detection (fast vs slow path)**
   - `computeMdDbHash(mdDbPath)`:
     - Hash of all `*.md` paths and `mtimeMs`.
     - Same hash → `md_db` unchanged since last run.
   - Stored in SQLite `index_state` as `md_db_hash`.
   - Fast path:
     - If hash unchanged **and** `vector-index/vector_store.json` exists:
       - Build `storageContextFromDefaults({ persistDir })`.
       - `VectorStoreIndex.init({ storageContext })` – reload embeddings, no re-embedding.
   - Slow path:
     - If first run or any file changed:
       - Full sync + re-embedding.

3. **Slow path: sync md_db → SQLite graph**
   - `syncMdDbToGraph(mdDbPath, graphStore)`:
     - Collect `filePaths` via `collectMarkdownFiles`.
     - **Pass 1 – notes**
       - For each file: `parseMarkdownFile(...)` → `ParsedNote` (see [[context_engine-ingest-pipeline]]).
       - `graphStore.upsertNote(note)` populates `notes` table.
     - **Pass 2 – edges**
       - For each parsed note:
         - Resolve each `linksOut` target via `graphStore.resolveLink(linkText)`.
         - Filter unresolved links.
         - `graphStore.replaceEdges(note.noteId, resolvedIds)` updates `edges` table.

4. **Slow path: build vector index from graph**
   - `buildVectorIndexFromGraph(graphStore, storageContext?)`:
     - Reads all notes from SQLite via `listAllNotes()`.
     - Builds `Document`s with:
       - `text`: stored `body` (frontmatter already stripped).
       - `metadata`: `file_path`, `note_type`, `tool_id`.
     - `VectorStoreIndex.fromDocuments(docs, { storageContext })`:
       - Embeds all documents, persists to `vector-index/` if `storageContext` passed.

5. **Persist state**
   - `graphStore.setState("md_db_hash", currentHash)` so next startup can fast-path.

## Runtime reindexing

- `ContextEngine.reindex()`:
  - Re-runs `syncMdDbToGraph` and `buildVectorIndexFromGraph` with persistence.
  - Updates `md_db_hash`.
  - For use when `md_db/` changes while the process is running.

- `ContextEngine.rebuildLinkGraph()`:
  - Uses [[link-graph-infrastructure]] (`LinkGraphProcessor`) with the same SQLite DB and `mdDbPath`.
  - Rebuilds enhanced `wikilinks` / `detected_cycles` tables and validates them.

## Dependencies

- [[context_engine-ingest-pipeline]] – parsing.
- [[sqlite-graph-store]] – persistence & graph traversal.
- [[context_engine-retrieval-workflow]] – assumes this lifecycle has run before retrieval.
