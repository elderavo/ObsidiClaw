/**
 * ObsidiClawStack — shared infrastructure factory.
 *
 * Creates and manages the core runtime components (ContextEngine, RunLogger,
 * JobScheduler, SubagentRunner) that all entry points need. Each process
 * creates its own stack instance; SQLite WAL mode handles concurrent access.
 *
 * Consumers:
 *   - extension/factory.ts   (Pi TUI path)
 *   - orchestrator/run.ts    (headless/scripting path)
 *   - gateway/*              (future: Telegram, etc.)
 */

import { join, relative, resolve } from "path";
import { randomUUID } from "crypto";

import chokidar, { type FSWatcher } from "chokidar";
import { RunLogger } from "../logger/run-logger.js";
import { NoteMetricsLogger } from "../logger/note-metrics.js";
import { ContextEngine } from "../knowledge/engine/context-engine.js";
import { JobScheduler, createHealthCheckJob, createNormalizeJob, createMergeInboxJob, createSummarizeCodeJob } from "../automation/jobs/index.js";
import { SubagentRunner } from "../agents/subagent/subagent-runner.js";
import { resolvePaths, type ObsidiClawPaths } from "../core/config.js";
import type { RunEvent } from "../agents/orchestrator/types.js";
import { WindowsTaskSchedulerBackend } from "../core/os/scheduling-windows.js";
import { startMdDbLintWatcher } from "../automation/jobs/watchers/md-db-lint-watcher.js";
import { startMirrorWatcher } from "../automation/jobs/watchers/mirror-watcher.js";
import { runMirrorTs } from "../automation/scripts/mirror-codebase.js";
import { runMirrorPy } from "../automation/scripts/mirror-codebase-py.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface StackOptions {
  /** Project root directory. Falls back to process.cwd(). */
  rootDir?: string;
  /** Enable the in-process job scheduler (default: true). */
  enableScheduler?: boolean;
  /**
   * Enable debug JSONL. Default: ON (set OBSIDI_CLAW_DEBUG=0 to disable).
   * When true, all events are also written to .obsidi-claw/debug/{sessionId}.jsonl.
   */
  debug?: boolean;
}

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

export interface ObsidiClawStack {
  readonly engine: ContextEngine;
  readonly logger: RunLogger;
  readonly noteMetrics: NoteMetricsLogger;
  readonly scheduler: JobScheduler | undefined;
  readonly runner: SubagentRunner;
  readonly sessionId: string;
  readonly paths: ObsidiClawPaths;
  readonly persistentBackend?: import("../core/os/scheduling.js").PersistentScheduleBackend;

  /** Initialize the context engine and start the scheduler. */
  initialize(): Promise<void>;
  /** Graceful shutdown: stop scheduler, close engine + logger. */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createObsidiClawStack(opts: StackOptions = {}): ObsidiClawStack {
  const paths = resolvePaths(opts.rootDir);
  const sessionId = randomUUID();

  // ── Debug mode ──────────────────────────────────────────────────────────
  const debugExplicit = opts.debug;
  const debugFromEnv = !["0", "false"].includes(
    (process.env["OBSIDI_CLAW_DEBUG"] ?? "").toLowerCase(),
  );
  const debugEnabled = debugExplicit ?? debugFromEnv;

  // ── RunLogger ───────────────────────────────────────────────────────────
  const logger = new RunLogger({
    dbPath: paths.dbPath,
    ...(debugEnabled
      ? { debugDir: resolve(paths.rootDir, ".obsidi-claw/debug") }
      : {}),
    onRetrievalError: (sessionId, runId, timestamp, errorPayload) => {
      noteMetrics.logRetrievalError({ sessionId, runId: runId ?? undefined, timestamp, errorPayload });
    },
  });

  // ── NoteMetricsLogger ──────────────────────────────────────────────────
  const noteMetrics = new NoteMetricsLogger(paths.notesDbPath);

  // ── ContextEngine ───────────────────────────────────────────────────────
  const engine = new ContextEngine({
    mdDbPath: paths.mdDbPath,
    onDebug: (event) => {
      logger.logEvent({
        ...event,
        sessionId: (event as Record<string, unknown>)["sessionId"] as string ?? sessionId,
        runId: (event as Record<string, unknown>)["runId"] as string ?? "",
      } as RunEvent);
    },
  });

  // ── Persistent backend (Windows Task Scheduler) ────────────────────────
  const persistentBackend = process.platform === "win32"
    ? new WindowsTaskSchedulerBackend(paths.rootDir)
    : undefined;

  // ── JobScheduler (optional) ─────────────────────────────────────────────
  const enableScheduler = opts.enableScheduler ?? true;
  let scheduler: JobScheduler | undefined;

  if (enableScheduler && persistentBackend) {
    scheduler = new JobScheduler(logger, persistentBackend, paths.rootDir, sessionId);
    scheduler.register(createHealthCheckJob());
    scheduler.register(createNormalizeJob());
    scheduler.register(createMergeInboxJob());
    scheduler.register(createSummarizeCodeJob());
  } else if (enableScheduler && !persistentBackend) {
    console.warn("[obsidi-claw] no persistent schedule backend available — scheduler disabled");
  }

  // ── md_db watcher (lint on change) ───────────────────────────────────────
  let mdDbWatcher: ReturnType<typeof startMdDbLintWatcher> | undefined;

  // ── md_db reindex watcher (incremental update on change) ────────────────
  let reindexWatcher: FSWatcher | undefined;

  // ── mirror watcher (regenerate code notes on source change) ──────────────
  let mirrorWatcher: ReturnType<typeof startMirrorWatcher> | undefined;

  // ── SubagentRunner ──────────────────────────────────────────────────────
  const runner = new SubagentRunner({
    dbPath: paths.dbPath,
    contextEngine: engine,
    noteMetrics,
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async function initialize(): Promise<void> {
    const mirrorDir = join(paths.mdDbPath, "code");

    // Engine is the only thing that must finish before accepting prompts.
    // Scheduler install and mirror pass are independent — run in parallel,
    // fire-and-forget so they don't block prompt readiness.
    const schedulerReady = scheduler
      ? scheduler.start().catch((err: unknown) => {
          console.warn("[obsidi-claw] scheduler.start() failed:", err);
        })
      : Promise.resolve();

    const mirrorReady = (async () => {
      try {
        await Promise.all([
          runMirrorTs({ scanDir: paths.rootDir, mirrorDir, omitPatterns: ["dist", "node_modules", "_legacy", ".claude", "*.d.ts"], force: false }),
          runMirrorPy({ scanDir: join(paths.rootDir, "knowledge", "graph"), mirrorDir, omitPatterns: ["__pycache__", "*.pyi", ".venv", "env", "venv", "dist"], force: false }),
        ]);
      } catch (err) {
        console.warn("[obsidi-claw] initial mirror run failed", err);
      }
    })();

    // All three run concurrently; we only await the engine.
    await Promise.all([
      engine.initialize(),
      schedulerReady,
      mirrorReady,
    ]);

    // Watchers are cheap — start after everything else is up.
    mdDbWatcher = startMdDbLintWatcher(paths.mdDbPath);
    mirrorWatcher = startMirrorWatcher(paths.rootDir, mirrorDir);
    reindexWatcher = startMdDbReindexWatcher(paths.mdDbPath, engine);
  }

  async function shutdown(): Promise<void> {
    if (reindexWatcher) {
      await reindexWatcher.close();
      reindexWatcher = undefined;
    }
    if (mirrorWatcher) {
      await mirrorWatcher.close();
      mirrorWatcher = undefined;
    }
    if (mdDbWatcher) {
      await mdDbWatcher.close();
      mdDbWatcher = undefined;
    }
    if (scheduler) {
      await scheduler.stop();
    }
    await engine.close();
    noteMetrics.close();
    logger.close();
  }

  return {
    engine,
    logger,
    noteMetrics,
    scheduler,
    runner,
    sessionId,
    paths,
    persistentBackend,
    initialize,
    shutdown,
  };
}

// ---------------------------------------------------------------------------
// md_db reindex watcher — incremental update on file change
// ---------------------------------------------------------------------------

const REINDEX_DEBOUNCE_MS = 1500;

/**
 * Watch md_db for .md file changes and trigger incremental engine updates.
 * Batches rapid changes (debounce) and sends only the changed/deleted paths.
 */
function startMdDbReindexWatcher(mdDbPath: string, engine: ContextEngine): FSWatcher {
  const pendingChanged = new Set<string>();
  const pendingDeleted = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function toRelPath(absPath: string): string {
    return relative(mdDbPath, absPath).replace(/\\/g, "/");
  }

  function scheduleFlush(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void flush();
    }, REINDEX_DEBOUNCE_MS);
  }

  async function flush(): Promise<void> {
    const changed = [...pendingChanged];
    const deleted = [...pendingDeleted];
    pendingChanged.clear();
    pendingDeleted.clear();

    // Don't send files that are in both changed and deleted — only delete
    const changedFiltered = changed.filter((p) => !deleted.includes(p));

    if (changedFiltered.length === 0 && deleted.length === 0) return;

    try {
      await engine.incrementalUpdate(changedFiltered, deleted);
    } catch (err) {
      // Engine might not be initialized yet or subprocess crashed — swallow
    }
  }

  const watcher = chokidar.watch(mdDbPath, {
    ignored: [/\.obsidian/, /\.obsidi-claw/],
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  function handleChange(absPath: string): void {
    if (!absPath.endsWith(".md")) return;
    const rel = toRelPath(absPath);
    pendingChanged.add(rel);
    pendingDeleted.delete(rel); // un-delete if re-created
    scheduleFlush();
  }

  function handleUnlink(absPath: string): void {
    if (!absPath.endsWith(".md")) return;
    const rel = toRelPath(absPath);
    pendingDeleted.add(rel);
    pendingChanged.delete(rel); // don't try to update a deleted file
    scheduleFlush();
  }

  watcher.on("add", handleChange);
  watcher.on("change", handleChange);
  watcher.on("unlink", handleUnlink);

  return watcher;
}
