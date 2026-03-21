---
id: f6a7b8c9-d0e1-2345-f012-456789012345
type: concept
created: 20260321-200000
updated: 20260321-200000
tags:
    - context_engine
    - retrieval
    - synthesis
    - llm
    - architecture
---

# Context Synthesis Pipeline

The context engine's retrieval pipeline has two stages: **hybrid retrieval** (deterministic, code-driven) and **optional LLM synthesis** (rewrites retrieved notes into query-focused context). The synthesis step is the key differentiator — it ensures agents receive targeted signal, not raw cosine-similarity word salad.

## Pipeline Flow

```
prompt
  ↓
hybridRetrieve(prompt, vectorIndex, graphStore, topK=5)
  ├── Vector seeds: LlamaIndex top-K by embedding similarity
  ├── Tag boost: +10% per matching tag (capped at +30%)
  ├── Index-type notes filtered out
  └── Graph expansion: SQLite BFS depth-1 via [[wikilinks]], score × 0.7 decay
  ↓
formatContext(seeds, expanded) → raw markdown
  ├── ## Seed Notes (direct vector matches)
  ├── ## Linked Supporting Notes (graph-expanded)
  └── ## Suggested Tools (tool-type notes)
  ↓
[Optional] ContextReviewer.review(query, notes, rawContext)
  ├── Skipped if avg score >= confidenceThreshold (default 0.5)
  ├── Direct Ollama /api/chat call (NOT a full Pi subagent session)
  ├── LLM receives raw formatted context + query
  ├── LLM outputs synthesized, query-focused markdown
  └── Falls back to raw context on failure/timeout
  ↓
ContextPackage.formattedContext → MCP → agent
```

## The Synthesis Step

The `ContextReviewer` is not a binary keep/filter gate. It takes the entire raw formatted context and asks the `context-gardener` personality's LLM to **rewrite it** as a focused document. The LLM outputs natural language markdown — no structured JSON, no fragile parsing.

### Why Natural Language Output

Early versions asked the LLM for structured `{ keep: [ids], filter: [ids] }` JSON. This was brittle:
- LLMs produce malformed JSON under time pressure
- Binary keep/filter doesn't address the real problem (notes are relevant but verbose)
- Parsing structured output adds failure modes

The current approach: LLM in, markdown out. The raw context goes in, focused context comes out. If the LLM fails, we fall back to raw notes. Code handles all structural concerns (retrieval, scoring, thresholds, metrics).

### Confidence Threshold

The synthesis step is expensive (~5-15s Ollama API call). It's skipped when retrieval confidence is high:
- Compute average retrieval score across all notes
- If avg >= `confidenceThreshold` (default 0.5), skip synthesis
- High-confidence results pass through without LLM overhead

### Personality-Driven

The `context-gardener` personality (`shared/agents/personalities/context-gardener.md`) controls the system prompt and model. Its instructions:
- Be ruthless about relevance — extract only the 10% that matters
- Preserve code patterns, API signatures, warnings verbatim
- Never add information not in the source notes
- Omit entire sections with no actionable signal

## Key Files

- `context_engine/retrieval/hybrid-retrieval.ts` — vector seeds + graph expansion
- `context_engine/review/context-reviewer.ts` — LLM synthesis step
- `context_engine/context-engine.ts` — `build()` method wires the full pipeline
- `shared/agents/personalities/context-gardener.md` — synthesis personality

## Related Notes

- [[hybrid_retrieval_workflow]] — detailed retrieval mechanics
- [[context_review_gate]] — the review gate architecture
- [[subagent_personalities]] — personality system used by the reviewer
- [[os_compat_layer]] — OS abstractions used throughout the pipeline
