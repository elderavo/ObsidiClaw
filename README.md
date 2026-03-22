# ObsidiClaw

Self-improving memory and context injection system for AI agents. Maintains a markdown knowledge graph, injects relevant context via hybrid RAG, logs every session, and writes durable lessons back to the graph — so the agent gets smarter over time.

## How it works

1. **Knowledge graph** (`md_db/`) — Flat-file markdown notes linked with Obsidian-style `[[wikilinks]]`. Tools, concepts, best practices, failure modes.
2. **Hybrid retrieval** — LlamaIndex vector similarity seeds + SQLite BFS graph expansion. Notes are ranked, expanded, and optionally synthesized by an LLM into query-focused context.
3. **MCP boundary** — The context engine is only accessible through an MCP server. Extensions and integrations are pure MCP clients.
4. **Session logging** — Every event (prompts, tool calls, context retrievals, subagent runs, scheduled jobs) is logged to SQLite with full lineage tracking.
5. **Scheduled maintenance** — In-process jobs reindex the knowledge graph, run health checks, and normalize markdown formatting.
6. **Subagents** — First-class spawnable agents with personality profiles, callable from tools, scheduler jobs, or standalone scripts.

## Entry points

- **`pi`** — Interactive TUI. The ObsidiClaw extension boots the full stack (context engine, scheduler, event logging, subagent tools) automatically.
- **`npx tsx orchestrator/run.ts`** — Headless mode for scripting, CI, and gateway integrations (e.g., Telegram bot).

Both paths use `createObsidiClawStack()` from `shared/stack.ts` for shared infrastructure.

## Stack

- TypeScript
- [LlamaIndex.TS](https://ts.llamaindex.ai/) — vector embeddings + retrieval
- [Ollama](https://ollama.ai/) — local LLM provider (embeddings + synthesis)
- SQLite (better-sqlite3, WAL mode) — knowledge graph store + run logging
- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) — tool/resource protocol
- [@mariozechner/pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) — agent runtime + TUI

## Status

Work in progress. Core pipeline (retrieval, injection, logging, scheduling) is operational. Active work on subagent reliability, post-session review, and observability tooling.
