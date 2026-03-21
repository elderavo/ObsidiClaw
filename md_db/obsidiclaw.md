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
- `context_engine/` - Hybrid retrieval: LlamaIndex vector + SQLite BFS graph expansion
- `orchestrator/` - Wraps Pi runs, manages lifecycle, event logging
- `logger/` - SQLite run logging (`runs`, `trace`, `synthesis_metrics` tables)
- `extension/` - Pi extension factory, pure MCP client
- `insight_engine/` - Future: compares runs, derives lessons (Phase 7-8)

## Key Design Decisions

**MCP Boundary**: `ContextEngine` only accessible through `context_engine/mcp/server.ts`. Extensions are pure MCP clients using `InMemoryTransport` pairs.

**Hybrid Retrieval**: Vector seeds (LlamaIndex/Ollama embeddings) + depth-1 BFS graph expansion (SQLite). Index-type notes filtered out (navigation/TOC only).

**Startup Behavior**: `before_agent_start` injects `preferences.md` only. Pi uses `retrieve_context` tool for on-demand project knowledge.

**Event Flow**: Everything emits `RunEvent`s → orchestrator → SQLite logger. MCP metrics route via `onContextBuilt` callback.

## Current Status

**Completed Phases**: 3-5 (orchestrator, logging, hybrid retrieval)  
**Next Phase**: 6 (tool execution integration)  
**Entry Point**: `npx tsx orchestrator/run.ts`

## Common Patterns

**Indexing Lifecycle**: Only happens on orchestrator startup via `contextEngine.initialize()`. SQLite graph sync → vector index rebuild. Changes require session restart.

**Note Types**: `tool` (executable), `concept` (insights), `index` (filtered navigation). Frontmatter `type:` field controls categorization.

**Context Retrieval**: Use `retrieve_context` tool frequently for project-specific knowledge. Queries vector index + graph expansion.

**Extension Changes**: After editing any file in `.pi/extensions/`, Alex must run `/reload` to implement the changes. Extensions are not auto-reloaded on file changes.

## Status Tracking

Current session status tracked in `.claude/CLAUDE.md` - always check phase progress and update session notes before ending work.
