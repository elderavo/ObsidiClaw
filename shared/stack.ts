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

import { join, resolve } from "path";
import { randomUUID } from "crypto";

import { RunLogger } from "../logger/run-logger.js";
import { ContextEngine } from "../context_engine/context-engine.js";
import { JobScheduler, createReindexJob, createHealthCheckJob, createNormalizeJob, createMergeInboxJob, createSummarizeCodeJob } from "../jobs/index.js";
import { SubagentRunner } from "./agents/subagent-runner.js";
import { resolvePaths, type ObsidiClawPaths } from "./config.js";
import type { RunEvent } from "../orchestrator/types.js";
import { WindowsTaskSchedulerBackend } from "./os/scheduling-windows.js";
import { startMdDbLintWatcher } from "../jobs/watchers/md-db-lint-watcher.js";
import { startMirrorWatcher } from "../jobs/watchers/mirror-watcher.js";
import { runMirrorTs } from "../scripts/mirror-codebase.js";
import { runMirrorPy } from "../scripts/mirror-codebase-py.js";

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
  readonly scheduler: JobScheduler | undefined;
  readonly runner: SubagentRunner;
  readonly sessionId: string;
  readonly paths: ObsidiClawPaths;
  readonly persistentBackend?: import("./os/scheduling.js").PersistentScheduleBackend;

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
  });

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
    scheduler.register(createReindexJob());
    scheduler.register(createHealthCheckJob());
    scheduler.register(createNormalizeJob());
    scheduler.register(createMergeInboxJob());
    scheduler.register(createSummarizeCodeJob());
  } else if (enableScheduler && !persistentBackend) {
    console.warn("[obsidi-claw] no persistent schedule backend available — scheduler disabled");
  }

  // ── md_db watcher (lint on change) ───────────────────────────────────────
  let mdDbWatcher: ReturnType<typeof startMdDbLintWatcher> | undefined;

  // ── mirror watcher (regenerate code notes on source change) ──────────────
  let mirrorWatcher: ReturnType<typeof startMirrorWatcher> | undefined;

  // ── SubagentRunner ──────────────────────────────────────────────────────
  const runner = new SubagentRunner({
    dbPath: paths.dbPath,
    contextEngine: engine,
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
          runMirrorPy({ scanDir: join(paths.rootDir, "knowledge_graph"), mirrorDir, omitPatterns: ["__pycache__", "*.pyi", ".venv", "env", "venv", "dist"], force: false }),
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
  }

  async function shutdown(): Promise<void> {
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
    logger.close();
  }

  return {
    engine,
    logger,
    scheduler,
    runner,
    sessionId,
    paths,
    persistentBackend,
    initialize,
    shutdown,
  };
}
