---
id: ( UUID )
type: ( context )
created: ( YYYYMMDD-HHmmss )
updated: ( YYYYMMDD-HHmmss )
tags: 
    -( tag1 )
    -( tag2 )
---

# ObsidiClaw System Knowledge

Self-knowledge about the ObsidiClaw project I'm currently operating within. This contains architecture details, current status, and system-specific patterns.

## Architecture Overview

**Core Modules**:
- `md_db/` - Flat-file markdown knowledge graph (tools, concepts, notes)
- `knowledge_graph/` - Python subprocess: VectorStoreIndex + SimplePropertyGraphStore, JSON-RPC stdio server
- `context_engine/` - TS bridge to Python knowledge_graph, context formatting, reviewer, MCP boundary
- `orchestrator/` - Wraps Pi runs, manages lifecycle, event logging
- `logger/` - SQLite run logging (`sessions`, `runs`, `trace`, `synthesis_metrics` tables; `TraceEmitter` for structured trace events)
- `extension/` - Pi extension factory, pure MCP client
- `insight_engine/` - Future: compares runs, derives lessons (Phase 7-8)

## Key Design Decisions

**MCP Boundary**: `ContextEngine` only accessible through `context_engine/mcp/mcp-server.ts`. Extensions are pure MCP clients using `InMemoryTransport` pairs.

**Hybrid Retrieval**: Vector seeds (LlamaIndex Python VectorStoreIndex) + depth-1 graph expansion (SimplePropertyGraphStore). Python subprocess via JSON-RPC. Index-type notes filtered out (navigation/TOC only).

**Startup Behavior**: `before_agent_start` injects `preferences.md` only. Pi uses `retrieve_context` tool for on-demand project knowledge.

**Event Flow**: Everything emits `RunEvent`s → orchestrator → SQLite logger. MCP metrics route via `onContextBuilt` callback. Structured trace events via `TraceEmitter` add source/target/action/status decomposition with per-run seq counters.

**Run Lineage**: Runs have a `run_kind` field (`core`, `subagent`, `reviewer`, `job`) and optional `parent_run_id`/`parent_session_id` for parent/child trees. Sessions are explicit rows in the `sessions` table.

## Current Status

**Completed Phases**: 1-6.5, 9 (foundation through infrastructure hardening + Python graph migration)
**Active Work**: Phase 7-8, 10-11 (subagent reliability, review pipeline, scheduler validation, visualizer)
**Entry Points**: `pi` (interactive, full stack via extension) or `npx tsx orchestrator/run.ts` (headless/scripting)

## Common Patterns

**Indexing Lifecycle**: Happens on startup via `contextEngine.initialize()` which sends `initialize` RPC to Python subprocess (fast path if md_db unchanged, ~570ms; slow path ~1350ms with embedding). Periodic re-sync via `reindex-md-db` scheduled job (30min).

**Note Types**: `tool` (executable), `concept` (insights), `index` (filtered navigation). Frontmatter `type:` field controls categorization.

**Context Retrieval**: Use `retrieve_context` tool frequently for project-specific knowledge. Queries Python VectorStoreIndex + SimplePropertyGraphStore graph expansion.

**Extension Changes**: After editing any file in `.pi/extensions/`, Alex must run `/reload` to implement the changes. Extensions are not auto-reloaded on file changes.

## Status Tracking

Current session status tracked in `.claude/CLAUDE.md` - always check phase progress and update session notes before ending work.




----

## Startup Paths

Both entry points use `createObsidiClawStack()` from `shared/stack.ts` to create shared infrastructure (ContextEngine, RunLogger, JobScheduler, SubagentRunner).

### Running `pi` (interactive — recommended)

```
pi (TUI binary)
  └── auto-discovers .pi/extensions/
        ├── obsidi-claw.ts → createObsidiClawExtension({ rootDir })
        │     └── extension/factory.ts (standalone path)
        │           └── createObsidiClawStack({ rootDir })
        │                 ├── RunLogger (debug JSONL ON by default)
        │                 ├── ContextEngine (with onDebug callback)
        │                 ├── JobScheduler (reindex, health-check, normalize)
        │                 └── SubagentRunner
        │           └── createContextEngineMcpServer(full options)
        │                 ├── retrieve_context, get_preferences
        │                 ├── list_jobs, run_job, set_job_enabled
        │                 └── schedule_task, unschedule_task
        ├── subagent.ts (reuses shared engine/runner via getSharedEngine())
        └── web-search.ts
```

Full stack: context injection, scheduler, event logging, subagent tools.

### Running `npx tsx orchestrator/run.ts` (headless/scripting/gateway)

```
orchestrator/run.ts
  └── createObsidiClawStack({ rootDir })  ← same stack factory
        ├── RunLogger, ContextEngine, JobScheduler, SubagentRunner
  └── Orchestrator → OrchestratorSession
        └── createPiSession() (creates its own Pi session internally)
              └── createObsidiClawExtension({ mcpServer })  ← orchestrator path
  └── readline loop (bare TUI)
```

Same infrastructure, different session management. OrchestratorSession creates and owns the Pi session — used for headless integrations (Telegram bot, CI, scripts).

### Shared infrastructure (`shared/stack.ts`)

```typescript
const stack = createObsidiClawStack({ rootDir, enableScheduler? });
await stack.initialize();  // engine init + scheduler start
// ... use stack.engine, stack.logger, stack.scheduler, stack.runner ...
await stack.shutdown();    // scheduler stop + engine close + logger close
```

Each process creates its own stack instance. SQLite WAL mode handles concurrent access across processes.
