---
id: 46d71963-d18e-4d23-8a1b-f352b8a0ceb4
uuid: 46d71963-d18e-4d23-8a1b-f352b8a0ceb4
type: concept
created: 2026-03-22
updated: 2026-03-22T17:23:25.118Z
tags:
    - context_engine
    - retrieval
    - scoring
    - logging
    - learning_loop
md_db: true
---
# Retrieval Scoring and Storage

How retrieval hits are scored, stored, and what's missing for the context-improvement cycle.

## Scoring Pipeline

Scores flow through four stages in `knowledge_graph/retriever.py`:

1. **Raw cosine similarity** — `VectorStoreIndex.as_retriever().retrieve(query)` returns `NodeWithScore` with raw embedding similarity (0.0-1.0).
2. **Tag boosting** — +10% per note tag that matches a query token, capped at +30%. Applied as `score * (1.0 + boost)`. Can push scores above 1.0.
3. **Graph expansion** — For each seed, `get_triplets()` finds depth-1 wikilink neighbors. Neighbor score = `parent_seed_score * 0.7`. Same tag boost applied to neighbors.
4. **Sorting** — All notes (seeds + expanded) sorted by final score descending in TS before formatting.

Scores are visible in formatted context as `### notes/foo.md (score: 0.847)`.

## Storage Tables

Every retrieval produces a `context_retrieved` RunEvent that writes to three places:

### `note_hits` table
Per-note rows capturing individual retrieval hits. This is the primary table for the learning loop.

| Column | Type | Description |
|--------|------|-------------|
| note_id | TEXT | Which note was retrieved |
| score | REAL | Final boosted score |
| depth | INTEGER | 0 = vector seed, 1 = graph expansion |
| source | TEXT | "vector" or "graph" |
| session_id | TEXT | FK to sessions |
| run_id | TEXT | FK to runs |
| timestamp | INTEGER | When the retrieval happened |

Indexed on `note_id` and `session_id`.

### `synthesis_metrics` table
Aggregate stats per retrieval call. See [[concepts/synthesis_metrics_logging]].

### `trace` table
Full event payload as JSON blob, queryable by run_id/session_id/event type.

### `runs` table (review fields)
`utility_score` (1-3) and `review_feedback` columns on runs, written by `recordReview()`. Links run quality to what was retrieved.

## What LlamaIndex Owns vs What's Hand-Rolled

### LlamaIndex owns
- **Embeddings**: `OllamaEmbedding` generates vectors for all notes
- **Vector search**: `VectorStoreIndex.as_retriever()` returns raw cosine similarity seeds
- **Graph storage**: `SimplePropertyGraphStore` stores wikilink edges as `EntityNode` + `Relation`
- **Persistence**: `StorageContext.persist()` / `load_index_from_storage()`

### Hand-rolled
- **Hybrid retrieval logic**: Custom `ObsidiClawRetriever` class (not a LlamaIndex `BaseRetriever` subclass)
- **Tag boosting**: `_apply_tag_boost()` in retriever.py
- **Score decay**: parent * 0.7 for graph-expanded neighbors
- **Index note filtering**: Post-retrieval filter on `note_type == "index"`
- **Markdown ingestion**: `markdown_utils.py` handles frontmatter parsing, wikilink extraction, note type inference, title extraction, and MD5 hashing (must match TS byte-for-byte)
- **Context formatting**: TS-side `formatContext()` renders notes into markdown sections
- **Context synthesis**: Optional LLM rewrite via `ContextReviewer` in TS

### Why the split
`PropertyGraphIndex` (LlamaIndex's unified graph+vector object) doesn't persist embeddings for manually-upserted `EntityNode`s. The dual-store pattern (`VectorStoreIndex` + `SimplePropertyGraphStore`) is intentional. Python handles vector/graph primitives; TS owns formatting, review, and orchestration. The JSON-RPC subprocess boundary keeps the two sides decoupled.

### `context_ratings` table
Agent self-grades of retrieval quality, written by the `rate_context` MCP tool. See [[concepts/context_feedback_loop]] for the full feedback loop status.

| Column | Type | Description |
|--------|------|-------------|
| query | TEXT | The original search query |
| score | INTEGER | 1 (irrelevant) to 5 (exactly what was needed) |
| missing | TEXT | Free-text: what information was lacking |
| helpful | TEXT | Free-text: what was useful |
| session_id | TEXT | FK to sessions |
| run_id | TEXT | FK to runs |

Joinable to `note_hits` via `session_id` + `run_id` — this is the key link between "what was retrieved" and "was it useful."

## Gaps for the Context-Improvement Cycle

See [[concepts/context_feedback_loop]] for the full gap analysis and proposed closure plan.

### 1. No link between note_hits and outcomes
`note_hits` records what was retrieved. `context_ratings` records whether it was useful. The join key exists (`session_id` + `run_id`) but **no query methods exist** — `RunLogger` is write-only for all three tables. `runs.utility_score` provides a second signal (subagent grading) but is also unqueried.

### 2. Boosted scores hide base quality
The stored `score` merges raw cosine similarity with tag boost. You can't distinguish "this note scored 0.8 from embedding quality" from "0.62 base + 30% tag boost." Tuning boost weights or evaluating embedding quality requires storing both the raw and boosted scores.

### 3. No reviewer impact tracking
`synthesis_metrics` stores `raw_chars` and `stripped_chars` but not which notes the reviewer kept vs dropped during synthesis. If the reviewer rewrites context, visibility into per-note contribution is lost.

### 4. No query column on note_hits
You can join to `synthesis_metrics` via session_id+run_id+timestamp to get `prompt_snippet`, but it's indirect. A denormalized `query_snippet` on `note_hits` would make "what queries pull this note?" trivial to query.

## Key Queries This Enables

```sql
-- Notes that never get retrieved (candidates for review/deletion)
SELECT path FROM notes
WHERE note_id NOT IN (SELECT DISTINCT note_id FROM note_hits);

-- Notes with consistently low scores (weak embeddings or poor content)
SELECT note_id, AVG(score) as avg_score, COUNT(*) as hit_count
FROM note_hits GROUP BY note_id HAVING avg_score < 0.3;

-- Retrieval performance over time
SELECT date(timestamp/1000, 'unixepoch') as day,
       AVG(retrieval_ms) as avg_ms, AVG(seed_count) as avg_seeds
FROM synthesis_metrics WHERE is_error = 0 GROUP BY day;
```
