---
id: mcp-retrieval-architecture
type: concept
created: 20260321-230000
updated: 20260321-230000
tags:
    - architecture
    - mcp
    - retrieval
    - context-engine
    - llamaindex
---

# MCP Retrieval Architecture — 6-Layer Breakdown

How context flows from an agent's `retrieve_context` call to a synthesized markdown response.

## Layer 1 — Agent (Pi or Subagent)

The agent sees a single MCP tool: `retrieve_context(query)`. It has no knowledge of vector databases, graph stores, or LLM reviewers. The tool returns markdown text.

## Layer 2 — Extension / MCP Client (`extension/factory.ts`)

Pure MCP client using `InMemoryTransport` pairs (same-process, zero-copy). On `before_agent_start`, calls `get_preferences` for startup injection. All `retrieve_context` calls proxy through `client.callTool()`.

Key constraint: the extension holds NO direct reference to `ContextEngine` or `RunLogger`. It only speaks MCP.

## Layer 3 — MCP Server (`context_engine/mcp/mcp-server.ts`)

Exposes tools via `@modelcontextprotocol/sdk`. The `retrieve_context` handler calls `engine.build(query)` and returns the `formattedContext` string. Also exposes scheduler tools (`list_jobs`, `run_job`, etc.) and subagent tools (`spawn_subagent`, `prepare_subagent`).

Metrics flow: `onContextBuilt(pkg)` callback fires with the full `ContextPackage`, which the orchestrator converts to a `context_retrieved` RunEvent.

**This is the stable TS boundary.** Everything above stays TS. Everything below can move to Python.

## Layer 4 — Context Engine (`context_engine/context-engine.ts`)

Orchestrates the retrieval pipeline:

1. `initialize()` — configure Ollama embeddings, open SQLite graph store, build/load vector index (fast path if md_db unchanged)
2. `build(prompt)` — run hybrid retrieval, format context, run reviewer synthesis

The engine is a stateful singleton per process. Multiple sessions share one engine instance.

## Layer 5 — Hybrid Retrieval (`context_engine/retrieval/hybrid-retrieval.ts`)

Two-phase retrieval:

1. **Vector seeds** — LlamaIndex `VectorStoreIndex.asRetriever().retrieve(query)` with Ollama `nomic-embed-text:v1.5` embeddings. Returns top-K notes by cosine similarity.
2. **Graph expansion** — SQLite BFS (depth-1) via `SqliteGraphStore.getNeighbors()`. Follows `[[wikilinks]]` stored as edges. Neighbor score = parentScore * 0.7. Tag boosting applied.

Index-type notes (TOC/navigation) are filtered out as seeds and do not act as BFS origins.

## Layer 6 — Context Reviewer (`context_engine/review/context-reviewer.ts`)

Always-on post-processing step. NOT "in the middle" between agent and MCP — it runs inside `ContextEngine.build()` after retrieval completes.

Direct Ollama `/api/chat` call using the `context-gardener` personality. Takes raw formatted context + query, produces a focused markdown document. Natural language in/out, no structured JSON. Falls back to raw notes on LLM/network failure.

## Where LlamaIndex Works

LlamaIndex (TS SDK) owns **vector embeddings only**:
- `OllamaEmbedding` for embedding generation
- `VectorStoreIndex` for vector storage and retrieval
- `storageContextFromDefaults` for persisting/loading the vector index

The wikilink graph lives entirely in SQLite (`better-sqlite3`). LlamaIndex has no graph awareness in the TS SDK.

## Data Flow Summary

```
Agent → retrieve_context(query)
  → MCP client (InMemoryTransport)
    → MCP server handler
      → engine.build(query)
        → hybridRetrieve(query, vectorIndex, graphStore)
          → LlamaIndex vector search (Ollama embeddings)
          → SQLite BFS graph expansion
        → formatContext(seeds, expanded)
        → reviewer.review(query, notes, rawContext)  [always-on]
          → Ollama /api/chat (context-gardener personality)
      → return formattedContext
    → onContextBuilt(pkg) → RunEvent logging
  → agent receives markdown
```

## Python Migration Impact

| Layer | Stays TS | Moves to Python | Notes |
|-------|----------|-----------------|-------|
| 1. Agent | Yes | — | Unchanged |
| 2. Extension | Yes | — | Unchanged |
| 3. MCP Server | Yes | — | Stable boundary. May proxy to Python subprocess |
| 4. Context Engine | Partial | Partial | Orchestration may stay TS; retrieval logic moves |
| 5. Hybrid Retrieval | No | Yes | LlamaIndex Python has PropertyGraphIndex, typed edges, path_depth |
| 6. Reviewer | Either | Either | Could stay as direct Ollama call in TS, or move to Python |

The MCP server is the **seam**. A Python subprocess behind MCP stdio transport replaces layers 4-6 without touching anything above.
