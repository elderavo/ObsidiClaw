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
import { resolve } from "path";
import { randomUUID } from "crypto";
import { RunLogger } from "../logger/run-logger.js";
import { ContextEngine } from "../context_engine/context-engine.js";
import { JobScheduler, createReindexJob, createHealthCheckJob, createNormalizeJob } from "../scheduler/index.js";
import { SubagentRunner } from "./agents/subagent-runner.js";
import { resolvePaths } from "./config.js";
import { WindowsTaskSchedulerBackend } from "./os/scheduling-windows.js";
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createObsidiClawStack(opts = {}) {
    const paths = resolvePaths(opts.rootDir);
    const sessionId = randomUUID();
    // ── Debug mode ──────────────────────────────────────────────────────────
    const debugExplicit = opts.debug;
    const debugFromEnv = !["0", "false"].includes((process.env["OBSIDI_CLAW_DEBUG"] ?? "").toLowerCase());
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
                sessionId: event["sessionId"] ?? sessionId,
                runId: event["runId"] ?? "",
            });
        },
    });
    // ── Persistent backend (Windows Task Scheduler) ────────────────────────
    const persistentBackend = process.platform === "win32"
        ? new WindowsTaskSchedulerBackend(paths.rootDir)
        : undefined;
    // ── JobScheduler (optional) ─────────────────────────────────────────────
    const enableScheduler = opts.enableScheduler ?? true;
    let scheduler;
    if (enableScheduler) {
        scheduler = new JobScheduler(logger, sessionId);
        scheduler.register(createReindexJob(engine));
        scheduler.register(createHealthCheckJob(engine, 24 * 60)); // run once per day
        scheduler.register(createNormalizeJob(paths.mdDbPath));
    }
    // ── SubagentRunner ──────────────────────────────────────────────────────
    const runner = new SubagentRunner({
        dbPath: paths.dbPath,
        contextEngine: engine,
        rootDir: paths.rootDir,
    });
    // ── Lifecycle ───────────────────────────────────────────────────────────
    async function initialize() {
        await engine.initialize();
        if (scheduler) {
            void scheduler.start();
        }
    }
    async function shutdown() {
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
        persistentBackend,
        initialize,
        shutdown,
    };
}
//# sourceMappingURL=stack.js.map