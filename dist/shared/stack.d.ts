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
import { RunLogger } from "../logger/run-logger.js";
import { ContextEngine } from "../context_engine/context-engine.js";
import { JobScheduler } from "../scheduler/index.js";
import { SubagentRunner } from "./agents/subagent-runner.js";
import { type ObsidiClawPaths } from "./config.js";
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
export declare function createObsidiClawStack(opts?: StackOptions): ObsidiClawStack;
//# sourceMappingURL=stack.d.ts.map