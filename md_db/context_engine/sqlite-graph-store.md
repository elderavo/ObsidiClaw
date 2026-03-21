---
title: Sqlite Graph Store
type: concept
---

# Sqlite Graph Store

`SqliteGraphStore` is the low-level persistence layer for the knowledge graph.

## Schema

- `notes` table
  - `note_id` (PK) – same as `path` (`relative/path.md`).
  - `path` (UNIQUE) – relative path in `md_db/`.
  - `title`
  - `note_type` – `"tool" | "concept" | "index" | "codebase"`.
  - `body` – frontmatter-stripped markdown.
  - `tool_id` – for tool notes.
  - `frontmatter_json` – serialized frontmatter object.
  - `created_at`, `updated_at` (from frontmatter if present).

- `edges` table
  - `src_note_id`, `dst_note_id` – directed wikilink edges.
  - Foreign keys to `notes(note_id)`, cascades on delete.

- `index_state` table
  - Generic `key/value` store.
  - Used for `schema_version` and `md_db_hash` (see [[context_engine-indexing-lifecycle]]).

Enhanced link tables (`wikilinks`, `detected_cycles`, etc.) are managed by [[link-graph-infrastructure]].

## Core operations

- **Upsert notes**
  - `upsertNote(ParsedNote)`:
    - `INSERT OR REPLACE` into `notes`.
    - Replacing a row **deletes associated edges** (via FK), so callers must call `replaceEdges` afterward.

- **Replace edges**
  - `replaceEdges(srcNoteId, dstNoteIds)`:
    - Validates destination noteIds exist; drops unresolved links.
    - Deletes all existing outgoing edges, then inserts new edges transactionally.

- **Neighbor traversal**
  - `getNeighbors(startIds: string[], maxDepth = 1)`:
    - BFS over **both**:
      - Forward edges: `src → dst`.
      - Backward edges: `dst → src`.
    - Returns `NeighborResult[]` with `noteId`, `depth`, `linkedFrom`.
    - Used by [[context_engine-retrieval-workflow]] to expand from seed notes.

- **Link resolution**
  - `resolveLink(linkText: string)`:
    - Matches `note_id = "<linkText>.md"` or `note_id LIKE "%/<linkText>.md"`.
    - If multiple matches:
      - Prefers `tool` → `concept` → `index`.
    - Returns `note_id` or `null`.

- **State**
  - `setState(key, value)` / `getState(key)`:
    - Used for `md_db_hash` (change detection) and schema version tracking.

- **DB access**
  - `getDatabase()`:
    - Provides raw `better-sqlite3` DB handle for [[link-graph-infrastructure]] and tooling.

## Collaborators

- [[context_engine-indexing-lifecycle]] – writes notes & edges, manages `md_db_hash`.
- [[context_engine-retrieval-workflow]] – reads notes, neighbors, and tags for RAG.
- [[link-graph-infrastructure]] – creates additional link tables on the same DB.
