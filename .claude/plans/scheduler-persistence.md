# Plan: Scheduler Persistence (Layer 3)

## Problem

Dynamic tasks registered via `schedule_task` MCP tool live only in memory (`JobScheduler.jobs` Map). When the process restarts, all agent-scheduled tasks vanish. Built-in jobs (reindex, health-check, normalize) are fine — they're hardcoded in `orchestrator/run.ts`. But the whole point of `schedule_task` is that Pi programs its own maintenance loops, and those need to survive restarts.

## Current Architecture

### What exists today

**`JobScheduler`** (`scheduler/scheduler.ts`) — in-process `setInterval` executor:
- `jobs: Map<string, JobEntry>` — purely in-memory
- `register(job)` → adds to map, no persistence
- `registerAndStart(job)` → adds to map + starts interval immediately (new in this session)
- `unregister(jobName)` → removes from map, clears interval
- `start()` → iterates map, creates `setInterval` for each job
- `stop()` → clears all intervals, aborts running jobs

**`PersistentScheduleBackend`** (`shared/os/scheduling.ts`) — interface stub:
- `install(jobName, intervalMs, command, args)` → OS-level scheduling
- `uninstall(jobName)` → remove OS schedule
- `list()` → query installed schedules
- Never implemented, never referenced outside the file

**Dynamic task flow** (implemented this session):
1. Pi calls `schedule_task` MCP tool with name, prompt, plan, personality, interval
2. MCP handler creates a `JobDefinition` whose `execute()` calls `SubagentRunner.run(spec)`
3. `scheduler.registerAndStart(job)` adds it to the in-memory map + starts interval
4. Task runs on schedule until process stops → gone forever

### Where the data lives

| Data | Location | Survives restart? |
|------|----------|-------------------|
| Built-in job definitions | Hardcoded in `orchestrator/run.ts` | Yes (code) |
| Dynamic task definitions | `JobScheduler.jobs` Map | **No** |
| Job execution history | `runs.db` → `trace` table (`job_start`/`job_complete`/`job_error`) | Yes (SQLite) |
| Subagent task specs | Nowhere — embedded in closure inside `schedule_task` handler | **No** |

### The closure problem

When `schedule_task` registers a job, the `execute()` function is a closure:
```typescript
scheduler.registerAndStart({
  name: taskName,
  execute: async (ctx) => {
    await runner.run({ prompt, plan, successCriteria, personality }, ctx.signal);
  },
});
```

The `prompt`, `plan`, `successCriteria`, `personality` values are captured in the closure. There's no serialized representation of what this task *does*. To persist and restore, we need to store the task spec as data.

## Design

### Approach: SQLite-backed task store

Store dynamic task specs in a `scheduled_tasks` table in `runs.db` (same database as everything else). On startup, `JobScheduler` (or a wrapper) reads the table and re-registers all persisted tasks.

**Why runs.db, not a separate file:**
- Already opened with WAL mode for concurrent reads
- `RunLogger` already manages the connection lifecycle
- Job execution events already land in `runs.db` — natural to keep specs there too
- No new file to manage

**Why not the `PersistentScheduleBackend` (OS-level scheduling):**
- OS schedulers (cron, Task Scheduler, launchd) run external processes. Dynamic tasks need the full ObsidiClaw runtime (context engine, subagent runner, MCP). Each OS-scheduled task would need to boot the entire stack.
- The current architecture is single-process — one `ContextEngine`, one `JobScheduler`, one `runs.db`. OS-level scheduling fights this.
- `PersistentScheduleBackend` is the right pattern for "run this script on a timer" — not for "run this subagent with RAG context inside the running system."
- Keep the stub for potential future use (e.g., scheduling `orchestrator/run.ts` to auto-start on boot).

### Schema

```sql
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  name        TEXT PRIMARY KEY,    -- "dynamic:monitor-ollama-releases"
  description TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  plan        TEXT NOT NULL,
  success_criteria TEXT NOT NULL,
  personality TEXT,                 -- nullable
  interval_minutes INTEGER NOT NULL,
  timeout_ms  INTEGER NOT NULL DEFAULT 600000,
  enabled     INTEGER NOT NULL DEFAULT 1,  -- 0 = disabled
  created_at  INTEGER NOT NULL,    -- epoch ms
  updated_at  INTEGER NOT NULL     -- epoch ms
);
```

No `execute` column — the execution strategy (SubagentRunner) is implicit. All persisted tasks are subagent tasks. If we later need tool-call tasks, add a `task_type` discriminator column.

### Data flow

**On `schedule_task` MCP call:**
1. Insert row into `scheduled_tasks`
2. Call `scheduler.registerAndStart(job)` as today (unchanged)

**On `unschedule_task` MCP call:**
1. Delete row from `scheduled_tasks`
2. Call `scheduler.unregister(taskName)` as today (unchanged)

**On `set_job_enabled` for a dynamic task:**
1. Update `enabled` column in `scheduled_tasks`
2. Call `scheduler.setEnabled()` as today

**On process startup (`orchestrator/run.ts`):**
1. Register built-in jobs (reindex, health-check, normalize) — unchanged
2. Read all rows from `scheduled_tasks` where `enabled = 1`
3. For each row, reconstruct a `JobDefinition` and call `scheduler.register(job)`
4. `scheduler.start()` — starts intervals for all jobs (built-in + restored dynamic)

### New components

**`scheduler/task-store.ts`** — SQLite CRUD for the `scheduled_tasks` table:
```typescript
export interface PersistedTask {
  name: string;
  description: string;
  prompt: string;
  plan: string;
  successCriteria: string;
  personality?: string;
  intervalMinutes: number;
  timeoutMs: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export class TaskStore {
  constructor(db: BetterSqlite3.Database) { ... }

  save(task: PersistedTask): void;
  remove(name: string): boolean;
  setEnabled(name: string, enabled: boolean): void;
  getAll(): PersistedTask[];
  getEnabled(): PersistedTask[];
}
```

Uses `better-sqlite3` directly (same as `RunLogger` and `SqliteGraphStore`). Table created in constructor if not exists.

**`scheduler/task-restorer.ts`** — converts persisted tasks back to `JobDefinition`:
```typescript
export function restoreDynamicTasks(
  store: TaskStore,
  scheduler: JobScheduler,
  runner: SubagentRunner,
): number;  // returns count of restored tasks
```

Reads `store.getEnabled()`, creates `JobDefinition` for each, calls `scheduler.register()`. Returns count for logging.

### Changes to existing code

**`context_engine/mcp/mcp-server.ts`** — `schedule_task` handler:
- After `scheduler.registerAndStart()`, also call `taskStore.save(...)` to persist
- `unschedule_task` handler: after `scheduler.unregister()`, call `taskStore.remove()`
- `set_job_enabled` handler: if task name starts with `dynamic:`, also call `taskStore.setEnabled()`
- Needs `TaskStore` reference — add to `McpServerOptions`

**`orchestrator/run.ts`** — startup:
- After creating `RunLogger` (which opens `runs.db`), create `TaskStore` from same DB connection
- After registering built-in jobs, call `restoreDynamicTasks(store, scheduler, runner)`
- Pass `taskStore` to `Orchestrator` → `OrchestratorSession` → MCP server

**`scheduler/scheduler.ts`** — no changes needed. The scheduler itself stays persistence-agnostic. Persistence is layered on top.

### Edge cases

**Task exists in DB but subagent runner fails to boot:**
- `restoreDynamicTasks` wraps each registration in try/catch, logs failures, continues
- Task stays in DB in case next restart succeeds

**Task in DB but same name already registered (built-in job collision):**
- Dynamic tasks are prefixed `dynamic:` — no collision with built-in names
- `restoreDynamicTasks` checks `scheduler.getStates()` and skips duplicates

**DB migration (table doesn't exist on first run):**
- `TaskStore` constructor creates table with `IF NOT EXISTS`
- Zero-migration approach, same as `RunLogger` and `SqliteGraphStore`

**Concurrent writes (scheduler thread vs MCP handler):**
- `better-sqlite3` is synchronous — no concurrent write issues in single-process
- WAL mode allows concurrent reads

## Execution order

1. Create `scheduler/task-store.ts` — `TaskStore` class with SQLite CRUD
2. Create `scheduler/task-restorer.ts` — `restoreDynamicTasks()` function
3. Update `scheduler/index.ts` — export new modules
4. Update `McpServerOptions` — add optional `taskStore` field
5. Update `schedule_task` / `unschedule_task` / `set_job_enabled` MCP handlers — persist changes
6. Update `orchestrator/run.ts` — create `TaskStore`, call `restoreDynamicTasks()` on boot, pass to orchestrator
7. Thread `taskStore` through `Orchestrator` → `OrchestratorSession` → MCP server
8. `tsc --noEmit` + manual test: schedule a task, restart process, verify task resumes

## File summary

| File | Change |
|------|--------|
| `scheduler/task-store.ts` | **NEW** — SQLite CRUD for `scheduled_tasks` table |
| `scheduler/task-restorer.ts` | **NEW** — restore persisted tasks into `JobScheduler` on boot |
| `scheduler/index.ts` | Export `TaskStore`, `restoreDynamicTasks` |
| `context_engine/mcp/mcp-server.ts` | Add `taskStore` to options, persist in schedule/unschedule/enable handlers |
| `orchestrator/run.ts` | Create `TaskStore`, call `restoreDynamicTasks()`, pass through |
| `orchestrator/orchestrator.ts` | Accept + forward `taskStore` |
| `orchestrator/session.ts` | Accept + forward `taskStore` to MCP server |
