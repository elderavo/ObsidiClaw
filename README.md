# ObsidiClaw

Self-improving memory and context injection system for AI agents. Maintains a markdown knowledge graph, injects relevant context via hybrid RAG, logs every session, and writes durable lessons back to the graph — so the agent gets smarter over time.

## How it works

1. **Knowledge graph** (`md_db/`) — Flat-file markdown notes linked with Obsidian-style `[[wikilinks]]`. Tools, concepts, best practices, failure modes.
2. **Hybrid retrieval** — Vector similarity seeds + link-graph expansion. Indexing/retrieval is performed by a Python service (`knowledge/graph/`) and accessed from TS via a subprocess bridge (`knowledge/engine/context-engine.ts`).
3. **MCP boundary** — The context engine is only accessible through an MCP server. Extensions and integrations are pure MCP clients.
4. **Session logging** — Every event (prompts, tool calls, context retrievals, subagent runs, scheduled jobs) is logged to SQLite with full lineage tracking.
5. **Scheduled maintenance** — In-process jobs reindex the knowledge graph, run health checks, and normalize markdown formatting.
6. **Subagents** — First-class spawnable agents with personality profiles, callable from tools, scheduler jobs, or standalone scripts.

## Entry points

- **`pi`** — Interactive TUI. The ObsidiClaw extension boots the full stack (context engine, scheduler, event logging, subagent tools) automatically.
- **`npx tsx entry/run-mcp.ts`** — Headless MCP server (no TUI). Useful for scripting, CI, and gateway integrations.

Both paths use `createObsidiClawStack()` from `entry/stack.ts` for shared infrastructure.

## Stack

- TypeScript
- Python (knowledge graph service in `knowledge/graph/`)
- LlamaIndex (Python) — vector embeddings + retrieval
- Ollama — local LLM provider (embeddings + synthesis)
- SQLite (better-sqlite3, WAL mode) — knowledge graph store + run logging
- MCP SDK — tool/resource protocol
- `@mariozechner/pi-coding-agent` — agent runtime + TUI

## Environment variables

| Name | Purpose | Default / when needed |
| --- | --- | --- |
| `OBSIDI_LLM_PROVIDER` | LLM provider (`ollama` \| `openai`) | `ollama` |
| `OBSIDI_LLM_HOST` | LLM endpoint base URL (no `/v1`) | `http://localhost:11434` |
| `OBSIDI_LLM_MODEL` | LLM model name | `cogito:8b` (falls back to `OLLAMA_MODEL` if set) |
| `OBSIDI_EMBED_PROVIDER` | Embedding provider (`ollama` \| `openai` \| `local`) | `ollama` |
| `OBSIDI_EMBED_HOST` | Embedding endpoint base URL | `http://localhost:11434` |
| `OBSIDI_EMBED_MODEL` | Embedding model name | `nomic-embed-text:v1.5` |
| `OPENAI_API_KEY` | OpenAI API key (used when LLM/embedding provider is `openai`) | required for OpenAI providers |
| `OBSIDI_CLAW_DEBUG` | Enable debug JSONL logging (`.obsidi-claw/debug/*.jsonl`) | on by default; set to `0`/`false` to disable |
| `OLLAMA_BASE_URL` | Compatibility: Ollama `/v1` URL for detached review worker | `http://localhost:11434/v1` |
| `OLLAMA_MODEL` | Compatibility: alternate source for `OBSIDI_LLM_MODEL` | none (falls back to `cogito:8b`) |
| `PERPLEXITY_API_KEY` | Needed to enable the `web_search` tool (`.pi/extensions/web-search.ts`) | required if using web search |

## Status

Work in progress. Core pipeline (retrieval, injection, logging, scheduling) is operational. Active work on subagent reliability, post-session review, and observability tooling.
