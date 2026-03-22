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
| `context_engine/review/` | Context synthesis: LLM rewrites raw notes into query-focused context |
| `context_engine/ingest/` | Domain-specific note parsing (noteType inference, toolId). Uses `shared/markdown/` |
| `context_engine/prune/` | Vector-similarity clustering for note deduplication |
| `context_engine/link_graph/` | Rich wikilink graph: parsing, storage, validation, cycle detection |
| `extension/` | Pi extension factory: full-stack standalone mode (creates ObsidiClawStack) or orchestrator client mode |
| `orchestrator/` | Headless session management: lifecycle stages, MCP wiring, event emission. Secondary entry point for scripting/gateway |
| `logger/` | SQLite-backed run logging — `sessions`, `runs`, `trace`, `synthesis_metrics` tables + `TraceEmitter` (structured trace) + debug JSONL |
| `tools/` | Live tools for real-time fact retrieval (web search via Perplexity API) |
| `.pi/extensions/` | Pi TUI extensions: codebase indexing, subagent spawning, web search |
| `shared/` | Types, config, event schema, MD templates, `stack.ts` (shared infrastructure factory) |
| `shared/os/` | OS compatibility layer: process spawning, filesystem, scheduling backend interface |
| `shared/markdown/` | Canonical markdown utilities: frontmatter parse/build, wikilinks, token normalization, md_db normalizer |
| `shared/agents/` | First-class subagent entity: SubagentRunner, personality loader, personality files |
| `shared/agents/personalities/` | Subagent personality markdown files (outside md_db, not indexed) |
| `scheduler/` | In-process job scheduler with setInterval: reindex (30m), health-check (15m), normalize-md-db (2h) |
| `insight_engine/` | Post-session review: captures session transcripts, proposes preference updates + new concept notes |

# Key Design Decisions
- `md_db/tools/` nodes point to **live tools** that fetch real-time facts — never hardcode facts
- `md_db/concepts/` nodes store **durable agent insight** (failure modes, best practices, heuristics)
- Knowledge graph is flat-file but link-structured (Obsidian-style `[[wikilinks]]`)
- Use **Conda** for all Python commands
- **MCP boundary**: `ContextEngine` is only accessible through `context_engine/mcp/server.ts` — Pi's extension never holds a direct engine reference. This lets the context engine be swapped to a remote/subprocess transport without changing the extension.
- **Shared infrastructure**: `createObsidiClawStack()` in `shared/stack.ts` creates ContextEngine, RunLogger, JobScheduler, and SubagentRunner. Both `extension/factory.ts` (Pi TUI) and `orchestrator/run.ts` (headless) consume it. Each process creates its own instance; SQLite WAL handles concurrency.
- **Two entry points**: `pi` (interactive, full stack via extension) and `orchestrator/run.ts` (headless/scripting/gateway via OrchestratorSession). Both use `createObsidiClawStack()`.
- **Metrics via events**: `onContextBuilt` callback on the MCP server fires with the full `ContextPackage`; both the extension (standalone mode) and orchestrator convert it to a `context_retrieved` `RunEvent` which the logger persists.
- **Debug events**: `ContextEngine` emits `ce_*` events via `onDebug` callback at every internal state transition (init, vector retrieval, graph expansion, review, reindex). Debug JSONL is **ON by default** (`OBSIDI_CLAW_DEBUG=0` to disable). All events land in `trace` table + `.obsidi-claw/debug/{sessionId}.jsonl`.
- **Startup injection**: `before_agent_start` calls MCP `get_preferences` and injects `preferences.md` only — no RAG on startup. Pi uses `retrieve_context` for on-demand project knowledge.
- **Index notes filtered**: `note_type === "index"` notes (TOC/nav files) are excluded from hybrid retrieval results and do not act as graph expansion origins.
- **Python owns retrieval**: `knowledge_graph/` module runs as subprocess. `VectorStoreIndex` (LlamaIndex Python) for vector embeddings, `SimplePropertyGraphStore` for wikilink graph (EntityNode + Relation). TS bridge communicates via JSON-RPC over stdin/stdout. TS retains context formatting, reviewer, debug events, prune storage.
- **Subagents are first-class entities**: `SubagentRunner` in `shared/agents/` can be spawned from Pi tools, scheduler, or standalone scripts — no parent Pi session required.
- **Personalities**: Stored in `shared/agents/personalities/` (outside `md_db/`) with frontmatter provider config. Injected into system prompt before task section.
- **OS compat layer**: All code uses `shared/os/` abstractions for process spawning, filesystem, signal handling. No `process.platform` or Windows-specific code.
- **Shared markdown layer**: `shared/markdown/` is the single source of truth for frontmatter parsing/building, wikilink extraction, token normalization. All consumers import from here — no local duplicates.
- **Context synthesis**: `ContextReviewer` in `context_engine/review/` takes raw formatted context + query and produces a focused markdown document via LLM. Natural language in/out, no structured JSON. Falls back to raw notes on failure.
- **Scheduler**: In-process `setInterval`-based. Jobs: `reindex-md-db` (30m), `health-check` (15m), `normalize-md-db` (2h). `PersistentScheduleBackend` interface stubbed for future OS-native scheduling. Job executions create `runs` rows with `run_kind="job"`.
- **Session/Run/Trace hierarchy**: `sessions` table is the top-level container (multi-prompt). `runs` table has `run_kind` (`core`|`subagent`|`reviewer`|`job`) + `parent_run_id`/`parent_session_id` for lineage trees. `trace` table supports both legacy (`type`+`payload`) and structured (`source`/`target`/`action`/`status`/`seq`/`span_id`) columns. `TraceEmitter` in `logger/trace-emitter.ts` manages per-run monotonic seq counters.
- **Trace modules**: Canonical module names in `shared/trace-modules.ts`: `orchestrator`, `pi_session`, `context_engine`, `scheduler`, `extension`, `subagent`, `insight_engine`, `logger`, `user`, `tool:<name>`. All trace events use these as source/target.

# Build Order
## Foundation (Complete)
- [x] **Phase 1** — Project skeleton + shared contracts (types, config, event schema)
- [x] **Phase 2** — Pi runtime adapter (minimal end-to-end: prompt in → result out)
- [x] **Phase 3** — Orchestrator skeleton (wraps Pi run, run_id, lifecycle, run logger)
- [x] **Phase 4** — SQLite logging + context injection path working end-to-end
- [x] **Phase 5** — Retrieval pipeline (hybrid RAG: vector seeds + BFS graph expansion)
- [x] **Phase 6** — Tool execution integration (web search, Pi extensions, MCP boundary)
- [x] **Phase 6.5** — Infrastructure hardening (OS compat layer, shared markdown, context synthesis, debug events, scheduler, personality system, subagent entity)

## Active Work
- [ ] **Phase 7 — Subagent reliability** *(problem: subagents feel flaky)*
  - [ ] 7a. Diagnose: run subagents with debug ON, capture `ce_*` + agent events in JSONL, identify failure modes (timeout? LLM errors? context too large? personality misconfigured?)
  - [ ] 7b. Add structured error reporting: catch and classify subagent failures (LLM timeout, malformed output, empty response, OOM)
  - [ ] 7c. Add retry logic or graceful degradation to `SubagentRunner` based on diagnosed failure modes
  - [ ] 7d. Validate subagent lifecycle end-to-end: spawn → context injection → prompt → output extraction → dispose

- [ ] **Phase 8 — Post-session review pipeline** *(problem: capturing logs but not generating md_db files)*
  - [ ] 8a. Diagnose: run a session with debug ON, trace `session_review.ts` flow — is `runSessionReview` called? Does the child session produce output? Does `parseProposal` return null?
  - [ ] 8b. Validate the review subagent actually produces valid JSON (check if LLM output matches expected schema, or if `extractJson()` is failing silently)
  - [ ] 8c. Validate `applyProposal` → `writeNewNote` path: are files being written? Is the md_db path correct? Are file permissions blocking writes?
  - [ ] 8d. Add logging/debug events to `session_review.ts` so the review pipeline is visible in JSONL (proposal received, notes written, errors)
  - [ ] 8e. End-to-end test: session with a clear learnable pattern → review fires → new concept note appears in md_db

- [x] **Phase 9 — Graph system refactor to Python** *(LlamaIndex Python VectorStoreIndex + SimplePropertyGraphStore)*
  - [x] 9a. Evaluate: LlamaIndex Python gives native OllamaEmbedding + SimplePropertyGraphStore for typed entity/relation storage
  - [x] 9b. Design the bridge: Python subprocess with JSON-RPC over stdin/stdout. TS spawns conda env Python directly.
  - [x] 9c. Implement Python knowledge_graph module: VectorStoreIndex + SimplePropertyGraphStore with Ollama embeddings, 7 RPC methods
  - [x] 9d. Migrate TS context-engine.ts to subprocess bridge, remove LlamaIndex TS deps, move old TS files to _legacy/
  - [x] 9e. Validate: vector retrieval + graph expansion working (43 notes, 90 edges, scores verified, fast/slow paths, JSON-RPC confirmed)

- [ ] **Phase 10 — Scheduler validation** *(depends on Phase 7 — if agents are flaky, scheduled jobs may silently fail)*
  - [ ] 10a. Verify all scheduled jobs run: `reindex-md-db`, `health-check`, `normalize-md-db` — check `job_start`/`job_complete` events in runs.db
  - [ ] 10b. Verify scheduled subagent jobs (if any) complete successfully using Phase 7 fixes
  - [ ] 10c. Add a `scheduler-status` MCP tool or CLI command that reports job states, last run times, error counts
  - [ ] 10d. Evaluate whether `PersistentScheduleBackend` is needed (do jobs need to survive process restarts?) — implement if yes

- [ ] **Phase 11 — runs.db visualizer** *(need to see what the pipeline actually does)*
  - [ ] 11a. Build a CLI tool (`scripts/trace-viewer.ts`) that reads runs.db and prints a timeline of events for a session: `session_start → ce_init_start(slow) → ce_init_end(3200ms, 42 notes) → prompt_received → ce_retrieval_start → ce_vector_done(5 seeds) → ...`
  - [ ] 11b. Add context inspection: for `context_retrieved` events, show seed note IDs, expanded note IDs, and the actual `formattedContext` (or a preview). For `ce_review_done`, show whether synthesis ran, input/output char counts.
  - [ ] 11c. Add tool call inspection: for `tool_call`/`tool_result` events, show tool name, args, and result preview
  - [ ] 11d. Add filtering: by session ID, by event type prefix (`ce_*`, `tool_*`), by time range
  - [ ] 11e. Consider a web UI (simple HTML + SQLite query API) for richer visualization — but CLI-first

## Learning Loops (0 of 3 closed)

Three self-improvement loops are in flight. None are closed end-to-end yet.

1. **Domain learning (md_db)** — The system learns about its domain by improving markdown notes. Session review proposes new concept notes and preference updates; the reindex job picks them up. *Status: pipeline built, not yet producing output (Phase 8).*
2. **User learning (session logging)** — The system learns about the user by analyzing session-level conversations. Session transcripts are reviewed for patterns, corrections, and preferences. *Status: logging works, review fires on shutdown but proposals not validated (Phase 8).*
3. **Self learning (subagent call logging)** — The system learns about itself by analyzing failure modes of subagent calls. Run lineage (parent/child) and run_kind tracking are in the schema. *Status: schema ready, no analysis or feedback loop implemented yet (Phase 7/12).*

See `.claude/learning-loops-plan.md` for the detailed closure plan.

## Future
- [ ] **Phase 12** — Comparison engine (compare logged runs, diff outcomes)
- [ ] **Phase 13** — Insight generation (derive durable lessons from run comparisons, write back to md_db)
- [ ] **Phase 14** — Self-improvement loop validation (full cycle: session → review → new note → better retrieval → measurably better next session)

# Current Status

**Interactive entry point:** `pi` (full stack via extension/factory.ts)
**Headless entry point:** `npx tsx orchestrator/run.ts` (scripting, gateway, CI)

## What Works
- Full stack in Pi TUI: context injection, scheduler, event logging, subagent tools — all via `createObsidiClawStack()`
- Full orchestrator lifecycle: session creation, multi-prompt conversations, lazy Pi session, event logging
- Hybrid RAG: LlamaIndex vector seeds + SQLite BFS graph expansion + tag boosting
- Context synthesis: optional LLM rewrite of raw notes into query-focused context
- MCP boundary: context engine accessible only through MCP server; extension is pure client
- Comprehensive event logging: all events → SQLite `trace` table + debug JSONL (ON by default)
- `ce_*` debug events: full visibility into context engine internals (init path, vector/graph timing, review status)
- Shared markdown layer: canonical frontmatter/wikilink/token handling, md_db normalizer
- OS compat layer: all code uses `shared/os/` abstractions
- Personality-driven subagents: `SubagentRunner` with personality files, spawnable from anywhere
- Scheduler: reindex (30m), health-check (15m), normalize-md-db (2h). Job executions tracked in `runs` table.
- Session/run/trace schema: `sessions` table, `run_kind` enum, parent linking, `TraceEmitter` with structured columns + seq counters

## What's Broken / Unvalidated
- **Subagents feel flaky** — need to diagnose with debug JSONL (Phase 7)
- **Post-session review not generating files** — `session_review.ts` runs but `md_db/` notes not appearing (Phase 8)
- **Scheduler jobs unvalidated** — registered but never confirmed running successfully in production (Phase 10)
- **Context synthesis untested** — review gate exists but hasn't been smoke-tested with review enabled (Phase 8a)
- **No way to inspect pipeline output** — need runs.db visualizer to see what context the agent actually received (Phase 11)

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

**2026-03-21 — Session 9 (Cron Jobs, Subagent Personalities, Context Review Gate)**
- **OS compat layer** (`shared/os/`) — `process.ts` (spawn, signals, exit), `fs.ts` (ensureDir, readText, writeText, etc.), `scheduling.ts` (PersistentScheduleBackend interface stub). All new code routes through these; existing code left for follow-up migration.
- **Subagent as first-class entity** — `SubagentRunner` in `shared/agents/subagent-runner.ts` encapsulates full lifecycle: load personality → build system prompt (with or without RAG) → create child OrchestratorSession → run with timeout/abort → extract output. Can be called from Pi tools, scheduler, or standalone scripts without a parent session.
- **Personality system** — `shared/agents/personality-loader.ts` reads `.md` files from `shared/agents/personalities/` (outside md_db, not indexed by context engine). Frontmatter includes `provider.model` and `provider.baseUrl` for LLM config per personality. Three built-in: deep-researcher, code-reviewer, context-gardener.
- **Subagent extension refactor** — `.pi/extensions/subagent.ts` rewritten as thin wrapper around `SubagentRunner`. Added `personality` parameter to `spawn_subagent` and `spawn_subagent_detached`. Removed ~100 lines of duplicated session/MCP/logger management. `scripts/run_detached_subagent.ts` also simplified to use SubagentRunner.
- **Context review gate** — `context_engine/review/context-reviewer.ts` with `ContextReviewer` class. Direct Ollama `/api/chat` call using personality's model. Confidence-threshold trigger (skips review when avg retrieval score >= threshold). Wired into `ContextEngine.build()` as optional post-retrieval filter. Review metrics flow through `context_retrieved` RunEvent.
- **Cron scheduler** — `scheduler/scheduler.ts` with `JobScheduler` class using setInterval. `register()`, `start()`, `stop()`, `runNow()`, `setEnabled()`. Built-in jobs: `reindex-md-db` (30min), `health-check` (15min). Job events (`job_start`/`job_complete`/`job_error`) added to RunEvent union. Wired into `orchestrator/run.ts` with graceful shutdown.
- **Type changes**: `SubagentInput.personality` field, `SubagentPackage.personalityConfig`, `ContextEngineConfig.personalitiesDir` + `.review`, `ContextPackage.reviewResult`, `prepare_subagent` MCP tool gets `personality` param.
- `tsc --noEmit` clean. Zero platform-specific code (`process.platform`, `win32`, etc.) in any new module.
- **Next**: Phase 7 — comparison engine. Also: migrate existing OS calls to compat layer, implement `PersistentScheduleBackend` for at least one platform.

**2026-03-21 — Session 10 (Context Pipeline Cleanup + Review Specializer)**
- **OS compat migration complete** — all raw `fs`, `child_process`, `process` imports in existing code migrated to `shared/os/` abstractions. Files: `extension/factory.ts`, `context_engine/context-engine.ts`, `logger/run-logger.ts`, `insight_engine/session_review.ts`, `orchestrator/run.ts`, `scripts/run_detached_subagent.ts`. Also migrated `process.cwd()` → `resolvePaths()` in `orchestrator/session.ts`, `insight_engine/session_review.ts`, `.pi/extensions/codebase-indexer.ts`.
- **Consolidated text extractors** — created `shared/text-utils.ts` with `extractMcpText()` and `extractMessageText()`, replacing 3 duplicate implementations across `extension/factory.ts`, `orchestrator/session.ts`, and `shared/agents/subagent-runner.ts`. `insight_engine/session_review.ts` also updated to use shared util.
- **Removed stale TODO comments** — cleaned up outdated Phase 1/6/7 TODOs from `context_engine/types.ts`, `context-engine.ts`, `orchestrator/session.ts`, `logger/run-logger.ts`.
- **Context reviewer evolved to synthesizer** — `ContextReviewer` now produces a synthesized, query-focused markdown document instead of binary keep/filter JSON decisions. LLM receives raw formatted context + query, outputs natural language — no structured JSON parsing needed. Falls back to raw notes on failure. Context-gardener personality rewritten with aggressive specialization instructions.
- **Committed session 9 work in 7 waves** — OS compat layer, subagent entity, review gate, scheduler, subagent refactors, orchestrator wiring, pruning system.
- `tsc --noEmit` clean. Zero `process.platform`/`win32` in application code.
- **Next**: Phase 7 — comparison engine. Smoke test synthesizer with review enabled.

**2026-03-21 — Session 11 (Shared Markdown Layer + Debug Events + CLAUDE.md Rewrite)**
- **Shared markdown layer** (`shared/markdown/`) — consolidated duplicate markdown utilities from 4+ modules into single source of truth:
  - `frontmatter.ts`: merged two separate parsers (note-parser + personality-loader), added `buildFrontmatter()` for canonical YAML output
  - `wikilinks.ts`: combined simple `extractWikilinks()` and rich `parseWikiLinks()` (with position/alias/anchor)
  - `tokens.ts`: consolidated duplicate `normalizeToken()`, `extractTags()`, `normalizeTagList()` from hybrid-retrieval and prune-builder
  - `normalizer.ts`: md_db health checker — scans for frontmatter inconsistencies, broken wikilinks, auto-fixes safe issues
- **Consumers migrated**: `context_engine/ingest/note-parser.ts`, `context_engine/retrieval/hybrid-retrieval.ts`, `context_engine/prune/prune-builder.ts`, `context_engine/link_graph/parser.ts` (now thin re-export), `shared/agents/personality-loader.ts`, `insight_engine/session_review.ts`
- **`buildFrontmatter()` fixes inconsistency** — `session_review.ts` was generating `tags: [a, b]` inline format; now produces canonical YAML dash lists
- **md_db normalizer job** — `normalize-md-db` registered in scheduler (every 2h), auto-fixes inline arrays → YAML dash lists, infers missing `type` field from path
- **Debug mode with `ce_*` events** — 9 new `RunEvent` types for context engine internal visibility: `ce_init_start/end`, `ce_retrieval_start`, `ce_vector_done`, `ce_graph_done`, `ce_review_start/done`, `ce_reindex_start/done`. `onDebug` callback on `ContextEngineConfig`, same pattern as `onContextBuilt`. Debug JSONL flipped to ON by default (`OBSIDI_CLAW_DEBUG=0` to disable).
- **CLAUDE.md rewrite** — Module Map updated, Key Design Decisions expanded, Build Order rewritten as problem-driven roadmap (Phases 7-14) based on 5 known issues: flaky subagents, review not writing files, Python graph migration, scheduler validation, runs.db visualizer
- `tsc --noEmit` clean
- **Next**: User to choose which phase to tackle (Phase 7 subagent reliability, Phase 8 review pipeline, Phase 11 visualizer, etc.)

**2026-03-21 — Session 12 (Shared Infrastructure Stack + Pi Full-Stack Unification)**
- **`shared/stack.ts`** (new) — `createObsidiClawStack()` extracts infrastructure setup from `orchestrator/run.ts` into a reusable factory. Creates RunLogger (with debug JSONL), ContextEngine (with `onDebug` callback), optional JobScheduler (reindex/health-check/normalize jobs), and SubagentRunner. `initialize()` boots engine + starts scheduler; `shutdown()` tears down cleanly.
- **`extension/factory.ts`** (major rewrite) — standalone path now creates full `ObsidiClawStack` instead of bare ContextEngine. Wires `onContextBuilt`/`onSubagentPrepared` callbacks and scheduler/runner into MCP server (enables `list_jobs`, `run_job`, `schedule_task` etc. for Pi). Adds Pi event logging (`prompt_received`, `agent_turn_start/end`, `tool_call/result`, `agent_done`, `session_start/end`). Exports `getSharedEngine()`/`getSharedRunner()` for cross-extension reuse.
- **`orchestrator/run.ts`** (simplified) — replaced 30 lines of manual setup with `createObsidiClawStack()`. Marked as headless/scripting/gateway entry point. Pi is now the recommended interactive path.
- **`.pi/extensions/subagent.ts`** — `ensureRunner()` checks shared getters before falling back to lazy engine creation, preventing duplicate ContextEngine instances.
- **md_db updated** — `obsidiclaw.md` startup call stacks rewritten, `scheduler_and_cron.md` wiring updated, `headless_decoupling.md` integration example updated to use stack.
- **Architecture decision**: two entry points are both first-class. `pi` for interactive (full TUI), `OrchestratorSession` for headless (Telegram gateway, scripts). Both use same stack. Each process creates its own instance; WAL handles concurrent SQLite access.
- `tsc --noEmit` clean
- **Next**: Validate Pi full-stack startup end-to-end. Consider Telegram gateway design (Phase 12+).

**2026-03-21 — Session 13 (Trace/Session Schema Refactor)**
- **Validated user's schema refactor instructions** against codebase — identified 6 factual mismatches: sessions are multi-prompt (not single-prompt), module list included 3 phantom modules and missed 2 real ones, scheduler jobs had no run rows, `isSubagent` was boolean not enum, no parent linking, no structured trace columns.
- **Implemented 6 foundational changes**:
  1. **`sessions` table** — pure container (no user_prompt/final_output). Created on `session_start`, finalized on `session_end`, `prompt_count` incremented per prompt.
  2. **`RunKind` enum** — `"core" | "subagent" | "reviewer" | "job"` replaces `isSubagent: boolean`. `run_kind` column on `runs` table. `isSubagent` kept for backward compat.
  3. **Parent linking** — `parentRunId`/`parentSessionId` threaded through `SessionConfig`, `SubagentSpec`, `OrchestratorSession`, `SubagentRunner`, and `prompt_received` event. `parent_run_id`/`parent_session_id` columns on `runs`.
  4. **Job runs in `runs` table** — `JobScheduler.executeJob()` now inserts/finalizes run rows with `run_kind="job"`. New public `insertJobRun()`/`finalizeRun()` on `RunLogger`.
  5. **`TraceModule` constants** — `shared/trace-modules.ts` with 9 static modules + `tool:<name>` dynamic pattern. `TraceModule`/`TraceModuleOrTool` types.
  6. **`TraceEmitter`** — `logger/trace-emitter.ts`. Per-run monotonic `seq` counters, structured columns (`event_id`, `seq`, `source`, `target`, `action`, `status`, `span_id`, `parent_event_id`, `payload_summary`, `error_text`). Backward compatible — legacy `type`+`payload` columns still populated. Accessible via `logger.trace`.
- **Decision**: Deferred instrumentation (wiring `logger.trace.emit()` at module boundaries) until a consumer (visualizer) drives which events need it. Schema is forward-compatible.
- `tsc --noEmit` clean.
- **Next**: Build Phase 11 visualizer to drive targeted instrumentation. Or rebuild and test the new schema populates correctly.

**2026-03-21 — Session 14 (Phase 9 — Python Graph Migration Complete)**
- **Architecture pivot**: `PropertyGraphIndex` doesn't properly persist vector embeddings for manually-upserted `EntityNode`s. Switched to **separate** `VectorStoreIndex` (vector search) + `SimplePropertyGraphStore` (wikilink graph) — same dual-store pattern as the old TS code, implemented in Python.
- **Python `knowledge_graph/` module** (10 files): `__init__.py`, `__main__.py`, `engine.py`, `indexer.py`, `retriever.py`, `pruner.py`, `server.py`, `protocol.py`, `markdown_utils.py`, `models.py`
  - `indexer.py`: Scans md_db → creates `EntityNode` + `Relation` in graph store → creates `TextNode` in `VectorStoreIndex` → persists both separately
  - `retriever.py`: `VectorStoreIndex.as_retriever()` for seeds + `graph_store.get_triplets()` for BFS depth-1 expansion. Tag boost (+10%/tag, max +30%). Index notes filtered.
  - `pruner.py`: `VectorStoreIndex.as_retriever()` for pairwise similarity → DFS connected components
  - `server.py`: JSON-RPC stdio loop (stdin/stdout) with 7 RPC methods
  - `engine.py`: Hash-based fast/slow path, note cache, lifecycle management
- **TS bridge** (`context_engine/context-engine.ts`): All LlamaIndex/SQLite imports removed. Subprocess spawns direct conda Python (`C:\...\envs\obsidiclaw\python.exe`, **not** `conda run` which doesn't forward stdin on Windows). JSON-RPC with UUID-based request IDs, 120s timeout, crash recovery.
- **Lesson: `conda run` doesn't forward stdin** — `conda run -n env python` receives empty stdin from pipes. Must use the conda env's Python executable directly. `resolvePythonPath()` checks common conda paths, falls back to `execSync` discovery.
- **Lesson: `SimplePropertyGraphStore.supports_vector_queries` is False** — can't use `VectorContextRetriever` with it. Must use `VectorStoreIndex.as_retriever()` separately.
- **Validation results**: Slow path 1350ms (43 notes), fast path 570ms. Vector retrieval returns scored results (e.g., `web_search.md` → 0.94 for "web search tool"). Graph expansion finds 4-11 neighbors. 43 nodes, 90 edges. JSON-RPC subprocess works end-to-end. `tsc --noEmit` clean.
- **Consumers updated**: `mcp-server.ts` (prune storage opens `prune.db` directly), `health-check.ts` (`getGraphStats()` instead of `getGraphStore()`), `package.json` (removed LlamaIndex TS deps)
- **Deleted TS files** → `context_engine/_legacy/`: `graph-store.ts`, `graph-indexer.ts`, `hybrid-retrieval.ts`, `note-parser.ts`, `note-models.ts`, `prune-builder.ts`
- **Next**: Commit Phase 9 work. Then Phase 7 (subagent reliability) or Phase 8 (post-session review) or Phase 10 (scheduler validation).

# End-of-Run Protocol
Every agent session MUST close by doing all three:
1. Check off any completed phases in the Build Order above
2. Update the "Current Phase" section with what's done and what's next
3. Append a dated entry to "Session Notes" — what was done, what worked, what didn't, what's next
4. Update memory files at `C:\Users\Alex\.claude\projects\C--Users-Alex-Desktop-Projects-Coding-ObsidiClaw\memory\` if new preferences or project facts were uncover