Read this before doing anything.  

# Who you are
 - you are a coding expert, project manager and implementation architect. 
 - you are charged with the succesful implementation of this project according to spec.
  - you are charged with updating this document regularly to reflect your most up to date understanding of the project and the implementation status. 
  - you are autonomous enough to use the .claude directory for whatever tooling or scratchpad space you want, in the pursuit of making the project better. 

You can edit below this line:
-------------

# What we're doing
ObsidiClaw is a **self-improving memory and context injection system** for an AI agent ("Pi"). It gives Pi a knowledge graph of tools and insights, logs its runs, compares outcomes, and writes durable lessons back to the graph. The goal: an agent that gets smarter each session through structured memory.

Full spec: see `md_db/index.md` and `.claude/Conceptual_Plan.md`.

# Module Map
| Directory | Role |
|-----------|------|
| `md_db/` | Flat-file markdown knowledge graph. Entry point: `md_db/index.md` |
| `context_engine/` | Hybrid retrieval engine: vector similarity + graph expansion, SQLite storage |
| `context_engine/mcp/` | MCP server exposing context engine — sole interface between retrieval and Pi |
| `context_engine/store/` | SQLite graph store with better-sqlite3, WAL mode, BFS traversal |
| `context_engine/retrieval/` | Hybrid retrieval: LlamaIndex vector seeds + graph expansion |
| `context_engine/ingest/` | Markdown parser, frontmatter extraction, wikilink resolution |
| `extension/` | Pi extension factory: MCP client, registers `retrieve_context` tool + `before_agent_start` hook |
| `orchestrator/` | Session management: lifecycle stages, MCP wiring, event emission |
| `logger/` | SQLite-backed run logging — `runs`, `trace`, `synthesis_metrics` tables |
| `tools/` | Live tools for real-time fact retrieval (web search via Perplexity API) |
| `.pi/extensions/` | Pi TUI extensions: codebase indexing, subagent spawning, web search |
| `shared/` | Types, config, event schema, MD templates |
| `insight_engine/` | Compares runs, derives lessons, writes new/updated notes back to md_db (Phase 7–8) |

# Key Design Decisions
- `md_db/tools/` nodes point to **live tools** that fetch real-time facts — never hardcode facts
- `md_db/concepts/` nodes store **durable agent insight** (failure modes, best practices, heuristics)
- Knowledge graph is flat-file but link-structured (Obsidian-style `[[wikilinks]]`)
- Use **Conda** for all Python commands
- **MCP boundary**: `ContextEngine` is only accessible through `context_engine/mcp/server.ts` — Pi's extension never holds a direct engine reference. This lets the context engine be swapped to a remote/subprocess transport without changing the extension.
- **Metrics via events**: `onContextBuilt` callback on the MCP server fires with the full `ContextPackage`; the orchestrator converts it to a `context_retrieved` `RunEvent` which the logger persists. The extension itself is logger-free.
- **Startup injection**: `before_agent_start` calls MCP `get_preferences` and injects `preferences.md` only — no RAG on startup. Pi uses `retrieve_context` for on-demand project knowledge.
- **Index notes filtered**: `note_type === "index"` notes (TOC/nav files) are excluded from hybrid retrieval results and do not act as graph expansion origins.
- **LlamaIndex owns embeddings only**: wikilink graph lives in SQLite (`better-sqlite3`); LlamaIndex handles vector seeds.

# Build Order (8 Phases)
- [x] **Phase 1** — Project skeleton + shared contracts (types, config, event schema, context package schema)
- [x] **Phase 2** — Pi runtime adapter (minimal end-to-end: prompt in → result out)
- [x] **Phase 3** — Orchestrator skeleton (wraps Pi run, run_id, lifecycle, run logger)
- [x] **Phase 4** — SQLite logging + context injection path working end-to-end
- [x] **Phase 5** — Retrieval pipeline (hybrid RAG: vector seeds + BFS graph expansion, frontmatter strip, token estimation)
- [x] **Phase 6** — Tool execution integration (web search, Pi extensions, MCP boundary complete)
- [ ] **Phase 7** — Comparison engine (compare logged runs)
- [ ] **Phase 8** — Insight generation (derive lessons, write back to md_db)

# Current Phase
**Phases 3–6 complete.** Full system operational with tool integration:

## Phase 3–5 (Complete)
- `OrchestratorSession` manages Pi lifecycle, lazy session creation, full `RunEvent` logging
- SQLite logger persists `runs`, `trace`, and `synthesis_metrics` tables to `.obsidi-claw/runs.db`
- Hybrid retrieval: LlamaIndex vector seeds + SQLite BFS graph expansion via `better-sqlite3`
- MCP boundary in place: `ContextEngine` exposed only via `context_engine/mcp/server.ts`; extension is pure MCP client
- `before_agent_start` injects `preferences.md` only; Pi uses `retrieve_context` tool for on-demand RAG
- Metrics route via `context_retrieved` RunEvent → logger (extension is logger-free)
- Index-type notes filtered from retrieval results

## Phase 6 (Complete)
- **Tool Ecosystem**: Web search via Perplexity API (`tools/web_search.ts`), custom tools framework
- **Pi Extensions**: Codebase indexer, subagent spawning, web search extensions in `.pi/extensions/`
- **MCP Tools Integration**: `retrieve_context` and `get_preferences` tools exposed via MCP server
- **Extension Factory**: Full MCP client implementation with InMemoryTransport pair
- **API Access Methods**: `getGraphStore()`, `getVectorIndex()`, `rebuildVectorIndex()` for extensions

**Interactive entry point:** `npm run build && npx tsx orchestrator/run.ts`

**Next: Phase 7** — comparison engine (getRuns/getTrace queries, run comparison logic for insight derivation).

## Architectural Completeness
- ✅ Knowledge graph (SQLite + wikilinks)
- ✅ Vector similarity search (LlamaIndex + Ollama embeddings) 
- ✅ Hybrid retrieval pipeline (semantic + graph expansion)
- ✅ MCP server/client boundary (transport-agnostic context engine)
- ✅ Session lifecycle management with comprehensive event logging
- ✅ Tool execution framework with Pi extension ecosystem
- ✅ Context injection system (preferences + on-demand RAG)
- 🚧 Run comparison and insight generation (Phase 7–8)

# Session Notes
<!-- Agents: append a dated entry here at the end of every run -->

**2026-03-20 — Session 1**
- Read full project structure; all module dirs were empty
- Established CLAUDE.md context persistence and memory files
- Project confirmed TypeScript (not Python); uses `@mariozechner/pi-coding-agent` SDK v0.61.0
- Ollama provider at `http://10.0.132.100/v1` (OpenAI-compat endpoint)
- Next action: implement Phase 1 shared contracts

**2026-03-20 — Session 4**
- `OrchestratorSession` created: long-lived wrapper around a pi agent session
  - Pi session is created LAZILY on first prompt (so context can be injected via `agentsFilesOverride`)
  - First prompt → context engine runs → pi session created with RAG context in system prompt
  - Subsequent prompts → straight to existing pi session, no context re-run
- `Orchestrator` simplified to: `createSession()` (returns `OrchestratorSession`) + `run()` (single-shot shorthand)
- `orchestrator/run.ts` updated to readline stdin loop using `OrchestratorSession`
- Event schema rewritten to be session-scoped (`sessionId`) + run-scoped (`runId`), emitted at every interface boundary
- `AgentSession` is exported directly from `@mariozechner/pi-coding-agent` — import it directly
- **Lesson: always read `.d.ts` exports list before guessing type names**
- `tsc --noEmit` passes clean
- Next: test end-to-end, then implement Phase 1 (shared types) or Phase 4 (SQLite logger)

**2026-03-20 — Session 3**
- Context engine skeleton complete: `context_engine/context-engine.ts`, `context_engine/indexer.ts`, `context_engine/types.ts`, `context_engine/index.ts`
- LlamaIndex 0.12.1 + @llamaindex/ollama 0.1.23 installed; uses `OllamaEmbedding` + `VectorStoreIndex`
- **Lesson learned: always read `.d.ts` type definitions in node_modules for API correctness — do NOT use `node -e` runtime introspection**
  - `BaseNode.getContent(MetadataMode.NONE)` is the correct text accessor (not `.getText()`, which only exists on `TextNode`)
  - `retriever.retrieve(string)` is the public API (`QueryType` = string); `_retrieve(QueryBundle)` is internal
  - `NodeWithScore.node` is typed as `BaseNode`, not `TextNode`
- Intercept flow: prompt → `context_engine.build()` → `ContextPackage` → injected into pi session via `agentsFilesOverride` → agent sees original prompt + RAG context
- New `RunEvent`: `context_built` with noteCount, toolCount, retrievalMs
- Next action: implement Phase 1 (shared types) or start testing the end-to-end flow

**2026-03-20 — Session 5**
- Context engine graph refactor complete
- `context_engine/ingest/models.ts` — `ParsedNote` interface
- `context_engine/ingest/parser.ts` — `parseMarkdownFile`: frontmatter parser, wikilink extractor, noteType inference, title extraction
- `context_engine/store/sqlite_graph.ts` — `SqliteGraphStore`: notes/edges/index_state tables, WAL mode, BFS traversal (forward + backward edges), `resolveLink` with tool > concept > index priority
- `context_engine/indexer.ts` — refactored to `syncMdDbToGraph` (two-pass: upsert notes, then resolve edges) + `buildVectorIndexFromGraph`
- `context_engine/retrieval/hybrid.ts` — `hybridRetrieve`: vector seeds + depth-1 graph expansion, neighbor score = parentScore × 0.7
- `context_engine/context-engine.ts` — updated `initialize()` (opens SQLite, syncs, builds vector index) and `build()` (hybrid retrieve, formats Seed Notes / Linked Supporting Notes / Suggested Tools); added `close()`
- `tsc --noEmit` passes clean
- **Key decision: LlamaIndex owns only vector retrieval; wikilink graph lives in SQLite (better-sqlite3)**
- Next: test end-to-end, then Phase 4 or Phase 1

**2026-03-20 — Session 2**
- Phase 3 orchestrator skeleton complete: `orchestrator/orchestrator.ts`, `orchestrator/types.ts`, `orchestrator/run.ts`, `orchestrator/index.ts`
- Logger stub: `logger/run-logger.ts` (console.log; SQLite in Phase 4)
- Shared stubs created: `shared/types.ts`, `shared/config.ts`, `shared/events.ts` (Phase 1 TODOs)
- Root `package.json` + `tsconfig.json` created; `npm install` done; `tsc --noEmit` passes
- Entry point: `npx tsx orchestrator/run.ts` (or `npm run build && node dist/orchestrator/run.js`)
- Next action: plan + implement Phase 1 (shared types extracted from orchestrator/types.ts)

**2026-03-20 — Session 6**
- Filtered `note_type === "index"` notes from hybrid retrieval — index/TOC nodes excluded as seeds and do not act as BFS expansion origins
- `ContextEngine.getNoteContent(relativePath)` added — reads specific note body from graph store
- `before_agent_start` changed to inject `preferences.md` only (via `getNoteContent`) instead of full RAG; Pi uses `retrieve_context` for on-demand lookup
- Full MCP refactor of synthesizer-model boundary:
  - `context_engine/mcp/server.ts`: `createContextEngineMcpServer(engine, onContextBuilt?)` — exposes `retrieve_context` and `get_preferences` MCP tools; fires `onContextBuilt(pkg)` with full `ContextPackage` for metrics routing
  - `extension/factory.ts`: rewritten as pure MCP client — no `ContextEngine` or `RunLogger` references; wires `InMemoryTransport` pair on `session_start`; `retrieve_context` Pi tool and `before_agent_start` hook both proxy through `client.callTool()`
  - `orchestrator/session.ts`: creates `McpServer` via `createContextEngineMcpServer`, wires `onContextBuilt` to emit `context_retrieved` RunEvent
  - `orchestrator/types.ts`: new `context_retrieved` event with full metrics fields
  - `logger/run-logger.ts`: `logEvent()` handles `context_retrieved` → inserts to `synthesis_metrics`; removed `logSynthesis()` public method and `SynthesisMetrics` export
- Installed `@modelcontextprotocol/sdk` + `zod`
- **Lesson: `client.callTool()` return has `[x: string]: unknown` index signature that widens `content` to `unknown` in TypeScript — use a local `extractText(result: unknown)` cast helper**
- `tsc --noEmit` passes clean
- Next: smoke test end-to-end, then Phase 6 (tool execution)

**2026-03-21 — Session 7 (Codebase Audit & CLAUDE.md Update)**
- **Phase 6 Complete**: Tool ecosystem fully implemented
  - Web search tool via Perplexity API (`tools/web_search.ts`) with axios integration
  - Pi extensions in `.pi/extensions/`: codebase-indexer, subagent spawning, web-search wrapper
  - MCP server exposes `retrieve_context` and `get_preferences` tools
  - Extension factory uses InMemoryTransport pairs for same-process MCP communication
- **Enhanced Context Engine**: Added `getGraphStore()`, `getVectorIndex()`, and `rebuildVectorIndex()` methods for extension ecosystem access
- **Build System**: Clean TypeScript compilation, dist/ directory with all modules compiled
- **Database State**: Active `.obsidi-claw/graph.db` and `runs.db` with WAL mode, indicating successful production usage
- **Knowledge Base**: Expanded md_db with NEVERs, obsidiclaw self-knowledge, failure modes, heuristics
- **Next Priority**: Phase 7 comparison engine — implement query methods on RunLogger for run comparison and insight derivation
- Updated CLAUDE.md to reflect Phases 1-6 complete, architectural completeness achieved for core functionality

**2026-03-21 — Session 8 (Pi TUI Logging + Subagent OrchestratorSession)**
- **`session-logger.ts`** (new) — always-on Pi TUI extension writing full `RunEvent`s to shared `runs.db`. Maps the complete Pi event API: `before_agent_start(prompt)` → `prompt_received` + `agent_prompt_sent` (generates new `runId` per turn); `agent_start` → `agent_turn_start`; `turn_end` → `agent_turn_end`; `agent_end(messages)` → `agent_done` + `prompt_complete` (with `durationMs`); `tool_execution_start/end` → `tool_call`/`tool_result`. Optional JSONL debug file via `OBSIDI_CLAW_DEBUG=1`. Replaces `debug-logger.ts` (which only captured 3 events with no SQLite persistence).
- **`subagent.ts`** (rewrite) — replaced `createAgentSession` + `DefaultResourceLoader` with `OrchestratorSession`. Child session reuses the `session_start` engine (already initialized), gets its own `RunLogger` per invocation writing to the same `runs.db`, and receives `formattedSystemPrompt` from `prepare_subagent` MCP. Subagent runs are now fully traced in SQLite identical to orchestrator runs. Engine not re-initialized; `childLogger.close()` called in teardown.
- **`link_graph/index.ts`** (fix) — `LinkGraphProcessor` was referencing `LinkGraph`, `LinkGraphStorage`, `LinkValidator`, `parseWikiLinks` etc. from re-export-only statements (no local bindings). Added local import statements so the class can reference them. `tsc --noEmit` clean.
- **Key design**: `pi` TUI and orchestrator paths now both produce full `RunEvent` traces to the same `runs.db` — unified observability across both entry points. Subagent runs appear as child sessions in the same database.
- **Next**: Phase 7 — comparison engine (query `runs`/`trace` tables, diff run outcomes, feed to insight derivation)

# End-of-Run Protocol
Every agent session MUST close by doing all three:
1. Check off any completed phases in the Build Order above
2. Update the "Current Phase" section with what's done and what's next
3. Append a dated entry to "Session Notes" — what was done, what worked, what didn't, what's next
4. Update memory files at `C:\Users\Alex\.claude\projects\C--Users-Alex-Desktop-Projects-Coding-ObsidiClaw\memory\` if new preferences or project facts were uncover