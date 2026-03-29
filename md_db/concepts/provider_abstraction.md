---
id: bde05fea-1ea0-4b7f-a162-06b808db4338
uuid: bde05fea-1ea0-4b7f-a162-06b808db4338
type: concept
created: 20260323
updated: 2026-03-23T05:37:06.126Z
tags:
    - architecture
    - providers
    - embedding
    - llm
md_db: true
---
# Provider Abstraction

ObsidiClaw's LLM and embedding layers are **provider-agnostic**. The system supports Ollama, OpenAI, and a zero-dependency "local" fallback — all configured via environment variables.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OBSIDI_EMBED_PROVIDER` | `ollama` | `"ollama"` \| `"openai"` \| `"local"` |
| `OBSIDI_EMBED_MODEL` | `nomic-embed-text:v1.5` | Embedding model name |
| `OBSIDI_EMBED_HOST` | `http://localhost:11434` | Embedding provider host |
| `OBSIDI_LLM_PROVIDER` | `ollama` | `"ollama"` \| `"openai"` |
| `OBSIDI_LLM_MODEL` | `cogito:8b` | LLM model name |
| `OBSIDI_LLM_HOST` | `http://localhost:11434` | LLM provider host |
| `OPENAI_API_KEY` | — | Required for `openai` provider |

## Architecture

### TypeScript Side — `core/llm-client.ts`

All TS LLM calls route through `llmChat()`. It reads `getLlmConfig()` from `core/config.ts`, routes to the right provider API (Ollama `/api/chat` or OpenAI `/v1/chat/completions`), and returns a normalized `ChatResult`.

Throws `ProviderUnreachableError` for network failures (ECONNREFUSED, ETIMEDOUT, etc.) so callers can distinguish "server down" from "bad auth" or "model not found."

`isLlmReachable()` sends a minimal ping through `llmChat()` — used by standalone scripts for early-out checks.

### Python Side — `knowledge_graph/providers.py`

Embedding provider factory. `create_embedding()` reads `OBSIDI_EMBED_*` env vars and returns the appropriate LlamaIndex `BaseEmbedding` instance (or `None` for `"local"` mode).

`check_reachable()` does a quick HTTP health check before attempting to build/load the vector index.

## Consumers

- **Context reviewer** (`knowledge/engine/review/context-reviewer.ts`) — uses `llmChat()` for synthesis
- **Summarize worker** (`automation/jobs/summarize-worker.ts`) — uses `llmChat()` + `isLlmReachable()` early-out
- **force-summarize script** (`automation/scripts/force-summarize.ts`) — uses `isLlmReachable()` early-out
- **Knowledge graph engine** (`knowledge/graph/engine.py`) — uses `providers.py` for embeddings

## Related

- [[graceful_degradation]] — what happens when providers are unavailable
- [[context_synthesis_pipeline]] — context reviewer uses `llmChat()`
