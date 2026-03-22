---
title: Context Engine Indexing Lifecycle
type: concept
---

# Context Engine Indexing Lifecycle

Describes how `md_db/` is scanned, parsed, embedded, and persisted by the Python `knowledge_graph/` subprocess.

## High-level phases

1. **TS bridge spawns Python subprocess**
   - `ContextEngine.initialize()` in TS:
     - Resolves the conda env Python path (`obsidiclaw` environment)
     - Spawns `python -m knowledge_graph` as a long-lived subprocess
     - Sends `initialize` JSON-RPC with `md_db_path`, `db_dir`, `ollama_host`

2. **Change detection (fast vs slow path)**
   - `compute_md_db_hash(md_db_path)` in Python:
     - MD5 of sorted `relative_path:mtime_ms` entries for all `.md` files
     - Stored in `.obsidi-claw/knowledge_graph/.md_db_hash`
   - Fast path:
     - Hash unchanged **and** `property_graph_store.json` + `docstore.json` exist
     - Loads `VectorStoreIndex` from storage + `SimplePropertyGraphStore` from JSON
     - Re-scans md_db for note bodies (no embedding, just file reads)
   - Slow path:
     - First run or any file changed → full rebuild

3. **Slow path: scan md_db → build stores**
   - `build_index(md_db_path, db_dir, embed_model)` in `knowledge_graph/indexer.py`:
     - **Scan**: Recursively collect `.md` files (skip `.obsidian`)
     - **Parse**: For each file → frontmatter, body, wikilinks, note type, title, tags
     - **Graph store**: Create `EntityNode` per note (label, properties), `Relation` per resolved wikilink → `SimplePropertyGraphStore`
     - **Vector index**: Create `TextNode` per note (title + body, metadata) → `VectorStoreIndex` with `OllamaEmbedding`
     - **Persist**: Graph store to `property_graph_store.json`, vector index to `docstore.json` + `default__vector_store.json` + `index_store.json`

4. **Note cache**
   - `initialize` and `reindex` responses include `note_cache: {path: body}`
   - TS caches all note bodies in-memory for synchronous `getNoteContent()` calls

## Runtime reindexing

- `ContextEngine.reindex()` in TS sends `reindex` RPC to Python
- Python computes hash — if unchanged, returns `{skipped: true}`
- If changed: full rebuild, returns updated note cache
- Triggered by `reindex-md-db` scheduled job (30min) or manual `run_job`

## Dependencies

- [[context_engine-ingest-pipeline]] — parsing (now in `knowledge_graph/markdown_utils.py`)
- [[sqlite-graph-store]] — `SimplePropertyGraphStore` (now Python, not SQLite)
- [[context_engine-retrieval-workflow]] — assumes indexing has run before retrieval
