---
title: Context Engine Retrieval Workflow
type: concept
---

# Context Engine Retrieval Workflow

Hybrid retrieval combining vector similarity (LlamaIndex) with graph expansion (SQLite).

## 1. Vector seed retrieval

- `hybridRetrieve(query, vectorIndex, graphStore, topK)`:
  - Gets a retriever: `vectorIndex.asRetriever({ similarityTopK: topK })`.
  - Calls `retrieve(query)` to get top‑K documents.
  - For each result:
    - `path` from node metadata `file_path`.
    - `stored` from `graphStore.getNoteByPath(path)`.
    - `tags` from `stored.frontmatter_json`:
      - Parsed out of `tags:` frontmatter via `extractTags`.
    - `baseScore` from embedding similarity.
    - `score` adjusted by tag matches:
      - `score * (1 + boost)`, where `boost` ≤ 0.3 (TAG_BOOST_PER_MATCH).
    - `type` from `stored.note_type` (or inferred from path).
    - Build `RetrievedNote` with `retrievalSource: "vector"`, `depth: 0`.

- Filters out `"index"` notes:
  - Index notes are navigation-only; not injected into agent context.

## 2. Graph expansion

- Seed IDs = `seedNotes.map(n => n.noteId)`.
- Calls `graphStore.getNeighbors(seedIds, 1)`:
  - BFS to depth‑1 on both forward and backward edges.
  - Returns neighbors with `noteId`, `depth`, `linkedFrom`.

- For each neighbor:
  - `stored` from `getNotesByIds`.
  - `parentScore` from the corresponding seed.
  - `baseScore = parentScore * GRAPH_SCORE_DECAY` (0.7).
  - Tag boosting as above.
  - Builds `RetrievedNote` with:
    - `retrievalSource: "graph"`.
    - `depth` from BFS.
    - `linkedFrom` array with parent noteId.

- Filters out `"index"` neighbors as well.

- Returns `{ seedNotes, expandedNotes }`.

## 3. Context packaging

- `ContextEngine.build(prompt)` orchestrates:
  - Calls `hybridRetrieve`.
  - Combines and sorts `allNotes` by `score` desc.
  - Extracts `suggestedTools` where `type === "tool"` and `toolId` set.
  - Computes `rawChars` from note bodies.

- `formatContext(seedNotes, expandedNotes)`:
  - Produces markdown injected into the Pi session:
    - Comment: `<!-- ObsidiClaw Knowledge Base Context -->`.
    - `## Seed Notes` – non-tool seed notes, with stripped frontmatter.
    - `## Linked Supporting Notes` – non-tool neighbors, with `Linked from:` metadata.
    - `## Suggested Tools` – tool notes, including documentation.
    - Closing comment: `<!-- End ObsidiClaw Context -->`.
  - Uses `stripFrontmatter()` to remove frontmatter noise.
  - Uses `estimateTokens()` to roughly estimate token count.

- Returned `ContextPackage` includes:
  - `formattedContext`, `retrievedNotes`, `suggestedTools`, metrics.
  - Seed and expanded note IDs for logging.

## 4. Subagent retrieval

- `ContextEngine.buildSubagentPackage(input)`:
  - Constructs a query from `plan + prompt` (plan is richer signal).
  - Truncates to 1000 chars.
  - Calls `build(query)` – same hybrid pipeline as above.
  - Formats a subagent system prompt:
    - See [[subagent_context_packaging]] and [[context_engine-mcp-interface]].

For a higher-level narrative of hybrid retrieval across the system, see [[hybrid_retrieval_workflow]].
