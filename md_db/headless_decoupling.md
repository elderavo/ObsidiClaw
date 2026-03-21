---
id: headless-decoupling-2026-03-21
type: concept
created: 20260321-200000
updated: 20260321-200000
tags:
    - architecture
    - headless
    - decoupling
    - refactor
---

# Headless Decoupling Refactor

Refactored the codebase to eliminate coupling to the Pi TUI, enabling headless/offline execution. The goal: `OrchestratorSession` can be driven by any input channel (Telegram bot, REST API, CLI, cron job) without requiring a terminal.

## What Changed

### 1. Centralized Config (`shared/config.ts`)

Previously, Ollama provider settings (`OLLAMA_BASE_URL`, `OLLAMA_MODEL`) and path resolution (`process.cwd()` for db/md_db paths) were duplicated across 4+ files. Now:

- `getOllamaConfig(overrides?)` — single source for provider settings, env-var backed
- `resolvePaths(rootDir?)` — single source for all paths (`.obsidi-claw/runs.db`, `md_db/`, etc.)
- `process.cwd()` only appears as the final fallback inside `resolvePaths()`

### 2. Shared Pi Session Factory (`shared/pi-session-factory.ts`)

`createPiAgentSession(options)` encapsulates the full session bootstrap:
- Ollama provider registration
- `DefaultResourceLoader` construction
- `createAgentSession` + `SessionManager.inMemory()`

Both `OrchestratorSession` and the detached subagent worker use this instead of duplicating ~30 lines of provider boilerplate.

### 3. Eliminated `globalThis` Session IDs

Three files shared session IDs via `globalThis.__obsidi_claw_pi_session_id`. This breaks with multiple sessions in one process (daemon, test harness). Now:

- `extension/factory.ts` accepts `sessionId` in its config
- `subagent.ts` accepts `sessionId` in `SubagentExtensionConfig`
- No more ambient global state for identity

### 4. Extension Factory Cleanup (`extension/factory.ts`)

Removed: `getSessionId()`, `SESSION_ID_KEY`, `OLLAMA_*` constants. Added: `rootDir` and `sessionId` config fields. All paths resolved via `resolvePaths()`.

### 5. Subagent Extension Rewrite (`.pi/extensions/subagent.ts`)

- Accepts `SubagentExtensionConfig` with optional `contextEngine`, `paths`, `sessionId`
- **Reuses parent engine** when provided (tracks `ownsEngine` for cleanup) — no more redundant second `ContextEngine`
- **Fixed timeout bug**: `dispose()` + `close()` in `finally` block kills the child session on timeout/cancel instead of letting it run in the background
- **Fixed abort listener leak**: uses `{ once: true }` + `removeEventListener` cleanup
- Detached subagent script path points to compiled `dist/scripts/`

### 6. Deleted Dead Session Logger (`.pi/extensions/session-logger.ts`)

Was entirely no-op (`LOG_SESSION_TRACE = false`) but still opened a SQLite connection. `OrchestratorSession` already handles all run/trace logging. Removed.

### 7. Detached Subagent Script → TypeScript (`scripts/run_detached_subagent.ts`)

Converted from `.js` to `.ts`. Uses `createPiAgentSession()` and `resolvePaths()` instead of duplicating provider config. Imports from source, compiles to `dist/scripts/`.

### 8. RunLogger Requires Explicit `dbPath`

`dbPath` was optional with a `process.cwd()` default. Now required — all call sites pass `resolvePaths().dbPath` explicitly. No hidden path assumptions.

## How Headless Integration Works

After these changes, `OrchestratorSession` is a clean headless agent core. Use `createObsidiClawStack()` to bootstrap infrastructure, then create sessions as needed:

```typescript
import { createObsidiClawStack } from "./shared/stack.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";

const stack = createObsidiClawStack({
  rootDir: "/path/to/project",
  enableScheduler: false, // gateway doesn't need its own scheduler
});
await stack.initialize();

const orchestrator = new Orchestrator(stack.logger, stack.engine, stack.scheduler, stack.runner);

// One stack, many sessions (e.g. one per Telegram chat)
const session = orchestrator.createSession();
await session.prompt("user message here");
const messages = session.messages; // extract response
await session.finalize();

// On process exit
await stack.shutdown();
```

The session handles: context injection (RAG), tool execution, subagent spawning, full SQLite logging — all without a TUI.

## Related

- [[obsidiclaw]] — system architecture overview
- [[subagent_context_packaging]] — how subagent context is built
