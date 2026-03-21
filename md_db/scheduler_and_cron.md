---
id: d4e5f6a7-b8c9-0123-def0-234567890123
type: concept
created: 20260321-180000
updated: 20260321-180000
tags:
    - scheduler
    - cron
    - jobs
    - architecture
---

# Scheduler and Cron Jobs

ObsidiClaw has an in-process job scheduler (`scheduler/scheduler.ts`) that runs registered jobs on intervals using `setInterval`. It's designed for eventual migration to persistent OS-native scheduling (cron, launchd, Windows Task Scheduler) via a pluggable backend interface.

## Two-Layer Architecture

### Layer 1: OS Compat Layer (`shared/os/`)

All OS-specific operations are abstracted behind a compatibility layer:
- `shared/os/process.ts` — process spawning, signal handling, exit
- `shared/os/fs.ts` — filesystem operations (ensureDir, readText, writeText, etc.)
- `shared/os/scheduling.ts` — `PersistentScheduleBackend` interface (stub)

**No platform-specific code** (`process.platform`, `win32`, etc.) exists in any new module. The compat layer is the only place that touches Node.js `child_process`, `fs`, and `process` APIs directly.

### Layer 2: JobScheduler (`scheduler/scheduler.ts`)

The scheduler manages job registration, interval firing, and execution:

```typescript
const scheduler = new JobScheduler(logger);
scheduler.register(createReindexJob(contextEngine));
scheduler.register(createHealthCheckJob(contextEngine));
await scheduler.start();
// ... later ...
await scheduler.stop();
```

Each job execution:
- Gets an `AbortController` for timeout/cancellation
- Emits `job_start` / `job_complete` / `job_error` RunEvents to the logger
- Respects `skipIfRunning` to prevent overlapping runs
- Timers use `.unref()` so they don't keep the process alive

## Built-in Jobs

| Job | Interval | What it does |
|-----|----------|-------------|
| `reindex-md-db` | 30 min | Calls `engine.reindex()` — syncs md_db to graph + vector index |
| `health-check` | 15 min | Checks Ollama reachability and SQLite graph store health |
| `normalize-md-db` | 2 hours | Scans md_db for frontmatter inconsistencies, auto-fixes safe issues |

## Job Definition

```typescript
interface JobDefinition {
  name: string;
  description: string;
  schedule: { hours?: number; minutes?: number; seconds?: number };
  execute: (ctx: JobContext) => Promise<void>;
  runOnStart?: boolean;      // run immediately on start()
  skipIfRunning?: boolean;   // prevent overlapping runs
  timeoutMs?: number;        // abort if exceeds this
}
```

Jobs can spin up a [[subagent_runner]] directly for agent-type tasks — no parent Pi session required. This is the key integration: scheduled jobs can run autonomous subagents.

## Persistence (Future)

The `PersistentScheduleBackend` interface in `shared/os/scheduling.ts` defines:
```typescript
interface PersistentScheduleBackend {
  install(jobName, intervalMs, command, args): Promise<void>;
  uninstall(jobName): Promise<void>;
  list(): Promise<ScheduledJob[]>;
}
```

Future implementations:
- **Linux/macOS**: cron or systemd timers
- **macOS**: launchd (launchctl)
- **Windows**: Task Scheduler (schtasks)

This enables use cases like "email me a news digest at 7am" that survive process restarts.

## Wiring

The scheduler is created inside `createObsidiClawStack()` (`shared/stack.ts`) and is available to all entry points:

1. `createObsidiClawStack({ enableScheduler: true })` creates `JobScheduler` + registers built-in jobs
2. `stack.initialize()` starts the scheduler after the context engine is ready
3. `stack.shutdown()` stops the scheduler during graceful exit

**Entry points that start a scheduler:**
- **`pi` TUI**: `extension/factory.ts` creates the stack in standalone mode (on `session_start`)
- **`orchestrator/run.ts`**: creates the stack at boot
- **Future gateway**: creates its own stack (set `enableScheduler: false` to avoid duplicate job runs)

The scheduler is also exposed via MCP tools (`list_jobs`, `run_job`, `set_job_enabled`, `schedule_task`, `unschedule_task`) so Pi can inspect and control jobs interactively.

## Key Files

- `shared/stack.ts` — `createObsidiClawStack()` creates and wires the scheduler
- `scheduler/scheduler.ts` — `JobScheduler` class
- `scheduler/types.ts` — `JobDefinition`, `JobContext`, `JobState`
- `scheduler/jobs/reindex.ts` — reindex job factory
- `scheduler/jobs/health-check.ts` — health check job factory
- `scheduler/jobs/normalize.ts` — normalize-md-db job factory
- `shared/os/scheduling.ts` — persistence backend interface
- `context_engine/mcp/mcp-server.ts` — scheduler MCP tools

## Related Notes

- [[subagent_runner]] — SubagentRunner can be called from scheduled jobs
- [[os_compat_layer]] — the OS abstraction that the scheduler builds on
