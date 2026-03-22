---
id: 4d2f4b6c-1c8f-4d6f-9e9e-6f4e0a5c9e1a
type: context
created: 20260321-133000
updated: 20260321-180000
tags:
    - context_engine
    - retrieval
    - graph
---

# Hybrid Retrieval Workflow

ObsidiClaw ingests all notes in `md_db/` into a `VectorStoreIndex` (vector embeddings) and a `SimplePropertyGraphStore` (wikilink graph). Retrieval is hybrid: vector-seeded similarity search followed by graph expansion to capture connected notes. The packaged output is returned via the MCP `retrieve_context` tool.

# Architecture

All retrieval runs in a Python subprocess (`knowledge_graph/`), called by the TS bridge via JSON-RPC over stdin/stdout.

- **Vector store**: `VectorStoreIndex` with `OllamaEmbedding` (nomic-embed-text:v1.5)
- **Graph store**: `SimplePropertyGraphStore` with `EntityNode` + `Relation` edges
- **Persistence**: `.obsidi-claw/knowledge_graph/` (JSON files)

# Current Status

- **Ingestion**: Scan md_db → parse frontmatter/wikilinks → build EntityNodes + TextNodes → embed + persist
- **Vector index**: LlamaIndex Python embeddings persisted to `.obsidi-claw/knowledge_graph/`
- **Hybrid retrieval**: Vector top-K seeds + depth-1 graph neighbors via `get_triplets()`. Index-type notes filtered out. Tag boosting (+10%/tag, max +30%). Neighbor score decay (0.7x parent).
- **Context synthesis**: Optional LLM rewrite of raw notes into query-focused context (always-on)
- **Link graph tooling**: Enhanced `link_graph` module is for validation/maintenance (not in the retrieval path)

# Usage Example

When the agent calls `retrieve_context`, the context engine:
1) sends `retrieve` RPC to Python subprocess with the query,
2) Python embeds the query, finds top-K notes by vector similarity,
3) for each seed, finds depth-1 graph neighbors via `get_triplets()`,
4) applies tag boosting and score decay,
5) TS formats and returns the combined context package (with optional synthesis).

Links:

[[obsidiclaw]]
