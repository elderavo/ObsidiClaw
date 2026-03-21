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
import { JobScheduler, createReindexJob, createHealthCheckJob, createNormalizeJob } from "../scheduler/index.js";
import { SubagentRunner } from "./agents/subagent-runner.js";
import { resolvePaths, type ObsidiClawPaths } from "./config.js";
import type { RunEvent } from "../orchestrator/types.js";

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

  // ── JobScheduler (optional) ─────────────────────────────────────────────
  const enableScheduler = opts.enableScheduler ?? true;
  let scheduler: JobScheduler | undefined;

  if (enableScheduler) {
    scheduler = new JobScheduler(logger, sessionId);
    scheduler.register(createReindexJob(engine));
    scheduler.register(createHealthCheckJob(engine));
    scheduler.register(createNormalizeJob(paths.mdDbPath));
  }

  // ── SubagentRunner ──────────────────────────────────────────────────────
  const runner = new SubagentRunner({
    dbPath: paths.dbPath,
    contextEngine: engine,
    rootDir: paths.rootDir,
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async function initialize(): Promise<void> {
    await engine.initialize();
    if (scheduler) {
      void scheduler.start();
    }
  }

  async function shutdown(): Promise<void> {
    if (scheduler) {
      await scheduler.stop();
    }
    engine.close();
    logger.close();
  }

  return {
    engine,
    logger,
    scheduler,
    runner,
    sessionId,
    paths,
    initialize,
    shutdown,
  };
}
