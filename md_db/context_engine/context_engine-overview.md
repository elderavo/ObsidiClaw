---
title: Context Engine Overview
type: concept
---

# Context Engine Overview

The **ContextEngine** coordinates indexing and retrieval for the ObsidiClaw knowledge base.

## Responsibilities

- **Initialization**
  - Configure Ollama embeddings (host + model).
  - Open the SQLite graph via [[sqlite-graph-store]].
  - Build or reload the LlamaIndex vector index from graph notes.
  - Fast-path startup when `md_db` is unchanged; full reindex otherwise.
- **Retrieval**
  - Hybrid RAG via [[context_engine-retrieval-workflow]]:
    - Vector seeds (LlamaIndex) + depth‑1 graph neighbors (SQLite).
    - Tag-aware scoring and index-note filtering.
  - Package results into a `ContextPackage` for injection into Pi.
- **Subagents**
  - Build `SubagentPackage`s for child sessions:
    - Run retrieval against the subagent plan.
    - Format a ready-to-inject system prompt.
    - See [[subagent_context_packaging]].
- **Runtime maintenance**
  - `reindex()` – full sync and re-embed when `md_db` changes at runtime.
  - `rebuildLinkGraph()` – rebuild enhanced link graph via [[link-graph-infrastructure]].
  - `close()` – cleanly close the SQLite DB.

## Main collaborators

- [[context_engine-ingest-pipeline]] – parses `.md` files into `ParsedNote`s.
- [[context_engine-indexing-lifecycle]] – syncs notes to SQLite + builds vector index.
- [[sqlite-graph-store]] – persistent note + edge graph.
- [[context_engine-retrieval-workflow]] – hybrid retrieval logic.
- [[link-graph-infrastructure]] – enhanced wikilink graph & validation.
- [[context_engine-mcp-interface]] – MCP tools that expose the engine.

See [[context_engine-data-models]] for the data shapes the engine works with.
