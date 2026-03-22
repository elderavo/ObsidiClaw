---
title: Graph Store (Python SimplePropertyGraphStore)
type: concept
---

# Graph Store

The knowledge graph is now stored in a Python `SimplePropertyGraphStore` (LlamaIndex) as part of the `knowledge_graph/` subprocess module. This replaces the previous SQLite `SqliteGraphStore`.

## Storage

- Persisted as JSON at `.obsidi-claw/knowledge_graph/property_graph_store.json`
- `EntityNode` per note with label (`TOOL`, `CONCEPT`, `INDEX`, `CODEBASE`)
- `Relation` per wikilink with label `LINKS_TO`, `source_id` → `target_id`
- Properties on each entity: `path`, `title`, `tool_id`, `tags`, `note_type`

## Core Operations

- **Upsert nodes**: `graph_store.upsert_nodes(entity_nodes)` — bulk insert all notes
- **Upsert relations**: `graph_store.upsert_relations(relations)` — bulk insert all wikilink edges
- **Get triplets**: `graph_store.get_triplets(entity_names=[note_id])` — returns all relations involving a note (both forward and backward edges). Used by the retriever for depth-1 graph expansion.
- **Persist/load**: `graph_store.persist(persist_path=...)` / `SimplePropertyGraphStore.from_persist_path(...)`

## Link Resolution

Wikilinks are resolved during indexing (`knowledge_graph/indexer.py`):
- Exact match by relative path
- Suffix match with `.md` extension
- Stem match (case-insensitive)
- Priority: `tool` > `concept` > `index` > `codebase`

## Collaborators

- [[context_engine-indexing-lifecycle]] — builds graph during slow path
- [[context_engine-retrieval-workflow]] — reads triplets for graph expansion
- [[link-graph-infrastructure]] — separate enhanced link validation (still TS/SQLite)
