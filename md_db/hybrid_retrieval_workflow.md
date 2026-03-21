---
id: 4d2f4b6c-1c8f-4d6f-9e9e-6f4e0a5c9e1a
type: context
created: 20260321-133000
updated: 20260321-133000
tags:
    - context_engine
    - retrieval
    - graph
---

# Hybrid Retrieval Workflow

ObsidiClaw ingests all notes in `md_db/` into a SQLite graph and a persisted vector index. Retrieval is hybrid: vector-seeded similarity search followed by graph expansion to capture connected notes. The packaged output is returned via the MCP `retrieve_context` tool.

# Current Status

- **Ingestion**: Two-pass sync into SQLite (`notes` then `edges`). Unresolved wikilinks are dropped during edge insertion.
- **Vector index**: LlamaIndex embeddings persisted to `.obsidi-claw/vector-index/vector_store.json`.
- **Hybrid retrieval**: Vector top‑K seeds + depth‑1 BFS neighbors (forward + backward). Index-type notes are filtered out.
- **Link graph tooling**: Enhanced `link_graph` module is for validation/maintenance (not in the retrieval path).

# Usage Example

When the agent calls `retrieve_context`, the context engine:
1) embeds the query and finds the top‑K notes by similarity,
2) expands to depth‑1 neighbors in the sqlite graph,
3) formats and returns the combined context package.

Links:

[[obsidiclaw]]
