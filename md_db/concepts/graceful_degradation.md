---
id: cf4e3ede-abd5-4a1d-8acc-d4e2efa50082
uuid: cf4e3ede-abd5-4a1d-8acc-d4e2efa50082
type: concept
created: 20260323
updated: 2026-03-23T05:37:29.373Z
tags:
    - architecture
    - resilience
    - fallback
md_db: true
---
# Graceful Degradation

When an embedding or LLM provider is unavailable, ObsidiClaw degrades gracefully instead of crashing. The extension always loads, `retrieve_context` always returns results.

## Degradation Modes

The Python `KnowledgeGraphEngine` reports its mode after initialization:

| Mode | Meaning |
|---|---|
| `"full"` | Vector embeddings + graph + keyword all available |
| `"degraded"` | Graph + keyword only — embedding provider unavailable or set to `"local"` |

## What Always Works (No Provider Needed)

- **Note scanning/parsing** — pure file I/O
- **Graph store** — wikilink traversal via `SimplePropertyGraphStore`
- **Keyword retriever** — `KeywordRetriever` scores notes by tokenized title/tag/path/body overlap
- **Note cache** — in-memory `{note_id: body}` map

## Keyword Fallback — `knowledge_graph/keyword_retriever.py`

BM25-style scoring using `normalize_token()` from `markdown_utils`:

| Match type | Weight per token |
|---|---|
| Title overlap | 0.4 |
| Tag overlap | 0.3 |
| Path segment overlap | 0.2 |
| Body token overlap | 0.05 (capped at 0.3) |

Scores are normalized so the best match = 1.0. Graph expansion still runs on top of keyword seeds — the graph store never needed embeddings.

## Engine Initialization Flow

```
1. Scan + parse all notes           (always)
2. Build graph store                (always)
3. Build KeywordRetriever           (always)
4. Populate note cache              (always)
5. Check embedding provider:
   ├── reachable → build/load vector index → mode="full"
   ├── unreachable + cached index → load from disk → mode="degraded"
   └── unreachable + no cache → skip vector index → mode="degraded"
```

## Retrieve Fallback Chain

```
1. Try vector retrieval (if index exists)
   ├── success → return vector seeds + graph expansion
   └── failure → log warning, fall through
2. Keyword retrieval → keyword seeds + graph expansion
```

## Job Behavior When Provider Unavailable

| Job | Behavior |
|---|---|
| `reindex-md-db` | Rebuilds graph + keyword index; skips vector rebuild |
| `normalize-md-db` | Unaffected (pure file I/O) |
| `merge-preferences-inbox` | `isLlmReachable()` early-out; inbox items deferred to next run |
| `summarize-code` | `isLlmReachable()` early-out; stale summaries wait for next run |
| `health-check` | Reports "LLM provider unreachable" as an issue |

## TS-Side Awareness

`ContextEngine` tracks `isDegraded` and `degradedReasonMessage`. In degraded mode, `build()` appends a warning to the formatted context:

> ⚠️ Embedding provider unavailable — using keyword matching. Results may be less precise.

## Related

- [[provider_abstraction]] — environment variable config for providers
- [[hybrid_retrieval_workflow]] — full retrieval pipeline
- [[context_engine_startup_fast_path]] — hash-based fast/slow path
