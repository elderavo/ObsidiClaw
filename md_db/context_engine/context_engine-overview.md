---
title: Context Engine Overview
type: concept
---

# Context Engine Overview

The **ContextEngine** coordinates indexing and retrieval for the ObsidiClaw knowledge base. It operates as a TS bridge to a Python subprocess (`knowledge_graph/`) that owns all vector and graph operations.

## Architecture

```
TS ContextEngine (context_engine/context-engine.ts)
  ├── JSON-RPC over stdin/stdout
  └── Python knowledge_graph subprocess
        ├── VectorStoreIndex (LlamaIndex + OllamaEmbedding)
        └── SimplePropertyGraphStore (EntityNode + Relation)
```

## Responsibilities

- **Initialization**
  - Spawn Python subprocess (conda env `obsidiclaw`)
  - Send `initialize` RPC (handles fast/slow path internally)
  - Populate in-memory note cache from response
- **Retrieval**
  - Hybrid RAG via [[context_engine-retrieval-workflow]]:
    - Vector seeds (VectorStoreIndex) + depth-1 graph neighbors (SimplePropertyGraphStore)
    - Tag-aware scoring and index-note filtering
  - Optional context synthesis via ContextReviewer (always-on)
  - Package results into a `ContextPackage` for injection into Pi
- **Subagents**
  - Build `SubagentPackage`s for child sessions:
    - Run retrieval against the subagent plan
    - Format a ready-to-inject system prompt
    - See [[subagent_context_packaging]]
- **Runtime maintenance**
  - `reindex()` — send `reindex` RPC, update note cache if md_db changed
  - `getGraphStats()` — async stats via Python RPC
  - `close()` — send `shutdown` RPC, kill subprocess

## What stays in TS

- Context formatting (`formatContext`, `formatSubagentSystemPrompt`)
- Context synthesis (`ContextReviewer` — direct Ollama `/api/chat`)
- Debug event emission (`ce_*` events via `onDebug` callback)
- Prune storage (SQLite via `better-sqlite3` in `prune.db`)
- MCP server (`context_engine/mcp/mcp-server.ts`)

## What lives in Python

- md_db scanning and parsing (`knowledge_graph/markdown_utils.py`)
- Vector embeddings (`VectorStoreIndex` + `OllamaEmbedding`)
- Wikilink graph (`SimplePropertyGraphStore` with `EntityNode` + `Relation`)
- Hybrid retrieval (`knowledge_graph/retriever.py`)
- Prune cluster computation (`knowledge_graph/pruner.py`)
- Hash-based change detection

## Main collaborators

- [[context_engine-indexing-lifecycle]] — syncs notes to vector + graph stores
- [[sqlite-graph-store]] — `SimplePropertyGraphStore` (now Python, not SQLite)
- [[context_engine-retrieval-workflow]] — hybrid retrieval logic
- [[context_engine-mcp-interface]] — MCP tools that expose the engine
- [[link-graph-infrastructure]] — enhanced wikilink graph & validation (still TS)

See [[context_engine-data-models]] for the data shapes the engine works with.
