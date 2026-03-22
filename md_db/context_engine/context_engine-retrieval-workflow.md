---
title: Context Engine Retrieval Workflow
type: concept
---

# Context Engine Retrieval Workflow

Hybrid retrieval combining vector similarity (LlamaIndex Python) with graph expansion (SimplePropertyGraphStore).

## 1. Vector seed retrieval

- `ObsidiClawRetriever.retrieve(query)` in `knowledge_graph/retriever.py`:
  - Gets a retriever: `VectorStoreIndex.as_retriever(similarity_top_k=k)`
  - Calls `retriever.retrieve(query)` for top-K notes by embedding similarity
  - For each result:
    - `file_path` from node metadata
    - `tags` from parsed note cache
    - `score` adjusted by tag matches: `score * (1 + boost)`, where boost <= 0.3
    - Builds `RetrievedNote` with `retrieval_source="vector"`, `depth=0`

- Filters out `"index"` notes (navigation-only, not injected into context)

## 2. Graph expansion

- For each seed note ID:
  - Calls `graph_store.get_triplets(entity_names=[seed_id])`
  - Returns all relations involving that entity (both forward and backward edges)
  - For each neighbor (the other end of the relation):
    - Skip if already a seed or already expanded
    - `score = parent_score * 0.7` (NEIGHBOR_SCORE_DECAY)
    - Tag boosting applied same as seeds
    - Builds `RetrievedNote` with `retrieval_source="graph"`, `depth=1`, `linked_from=[seed_id]`

- Filters out `"index"` neighbors as well

- Returns `(seed_notes, expanded_notes)`

## 3. Context packaging

- `ContextEngine.build(prompt)` in TS orchestrates:
  - Sends `retrieve` RPC to Python subprocess
  - Python returns `{seed_notes, expanded_notes}` as JSON
  - TS combines and sorts all notes by score descending
  - Extracts `suggestedTools` where `type === "tool"`

- `formatContext(seedNotes, expandedNotes)` in TS:
  - Produces markdown injected into the Pi session:
    - `## Seed Notes` — non-tool seed notes, with stripped frontmatter
    - `## Linked Supporting Notes` — non-tool neighbors, with `Linked from:` metadata
    - `## Suggested Tools` — tool notes, including documentation
  - Uses `stripFrontmatter()` and `estimateTokens()`

- Optional context synthesis via `ContextReviewer` (always-on unless disabled):
  - LLM rewrites raw context into focused markdown
  - Falls back to raw notes on failure

## 4. Subagent retrieval

- `ContextEngine.buildSubagentPackage(input)`:
  - Constructs query from `plan + prompt`, truncated to 1000 chars
  - Calls `build(query)` — same hybrid pipeline
  - Formats subagent system prompt
  - See [[subagent_context_packaging]] and [[context_engine-mcp-interface]]

For a higher-level narrative see [[hybrid_retrieval_workflow]].
