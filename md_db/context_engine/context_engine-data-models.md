---
title: Context Engine Data Models
type: concept
---

# Context Engine Data Models

Core types that tie indexing, retrieval, and MCP together.

## Note types

- `NoteType`:
  - `"tool"` – executable notes in `tools/`.
  - `"concept"` – normal knowledge notes.
  - `"index"` – navigational/TOC notes, filtered out of retrieval results.
  - `"codebase"` – reserved for future codebase indexing.

## Parsed & stored notes

- `ParsedNote` (from [[context_engine-ingest-pipeline]]):
  - `noteId` / `path` – relative path in `md_db/` (e.g. `tools/network.md`).
  - `title` – derived from frontmatter, first heading, or filename.
  - `noteType` – inferred from frontmatter or path.
  - `body` – markdown with frontmatter stripped.
  - `frontmatter` – raw key/value map.
  - `linksOut` – raw `[[wikilink]]` targets, unresolved.
  - `toolId` – tool identifier for `"tool"` notes.

- `StoredNote` (in [[sqlite-graph-store]]):
  - Mirrors `ParsedNote`, but stored in SQLite (`notes` table).
  - Adds timestamps & JSON-serialized `frontmatter_json`.

## Retrieval types

- `RetrievedNote`:
  - `noteId`, `path`, `content`, `type`, `tags`.
  - `score` – normalized retrieval score (vector or graph-derived).
  - `retrievalSource` – `"vector"` or `"graph"`.
  - `depth` – 0 for vector seeds, 1+ for graph neighbors.
  - `linkedFrom` – parent noteIds for graph-expanded notes.
  - `toolId?` – present for tool notes, used in suggested tool list.

- `ContextPackage` (output of `ContextEngine.build()`):
  - `query` – original retrieval query.
  - `retrievedNotes` – all `RetrievedNote`s, sorted by score.
  - `suggestedTools` – deduped `toolId`s from retrieved tool notes.
  - `formattedContext` – markdown block for Pi injection (built in [[context_engine-retrieval-workflow]]).
  - Metrics: `retrievalMs`, `builtAt`, `rawChars`, `strippedChars`, `estimatedTokens`.
  - Debug: `seedNoteIds`, `expandedNoteIds`.

## Subagent types

- `SubagentInput`:
  - `prompt` – top-level task description.
  - `plan` – detailed implementation plan.
  - `successCriteria` – measurable completion criteria.

- `SubagentPackage` (from `buildSubagentPackage()`):
  - `input` – the original `SubagentInput`.
  - `contextPackage` – `ContextPackage` built against plan+prompt.
  - `formattedSystemPrompt` – final prompt injected into child Pi session.
  - `builtAt` – timestamp.

## Configuration

- `ContextEngineConfig`:
  - `mdDbPath` – root of `md_db/`.
  - `dbPath?` – SQLite path (defaults to `.obsidi-claw/graph.db`).
  - `ollamaHost?` – embedding server host (default `"10.0.132.100"`).
  - `embeddingModel?` – e.g. `"nomic-embed-text:v1.5"`.
  - `topK?` – number of vector seeds (default `5`).

These types are used across [[context_engine-indexing-lifecycle]], [[context_engine-retrieval-workflow]], and [[context_engine-mcp-interface]].
