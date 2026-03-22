/**
 * JobScheduler — in-process job scheduler using setInterval.
 *
 * Runs registered jobs at configured intervals. Each execution:
 *   - Gets an AbortController for timeout enforcement
 *   - Emits job_start / job_complete / job_error RunEvents to the logger
 *   - Respects skipIfRunning to prevent overlapping runs
 *
 * For persistent scheduling (surviving process restarts), see the
 * PersistentScheduleBackend interface in shared/os/scheduling.ts.
 */
import { RunLogger } from "../logger/run-logger.js";
import type { JobDefinition, JobState } from "./types.js";
export declare class JobScheduler {
    private readonly jobs;
    private readonly logger;
    private readonly sessionId;
    private running;
    constructor(logger: RunLogger, sessionId?: string);
    /**
     * Register a job definition. Does not start it.
     * Throws if a job with the same name is already registered.
     */
    register(job: JobDefinition): void;
    /**
     * Start all registered jobs.
     * Sets up intervals and runs runOnStart jobs immediately.
     */
    start(): Promise<void>;
    /**
     * Stop all jobs. Clears intervals and aborts running jobs.
     */
    stop(): Promise<void>;
    /**
     * Run a single job immediately (outside its schedule).
     */
    runNow(jobName: string): Promise<void>;
    /**
     * Get current state of all registered jobs.
     */
    getStates(): JobState[];
    /**
     * Unregister a job. Stops its interval and removes it entirely.
     * No-op if the job doesn't exist.
     */
    unregister(jobName: string): boolean;
    /**
     * Register a job and start its interval immediately (if scheduler is running).
     */
    registerAndStart(job: JobDefinition): void;
    /**
     * Disable or enable a job.
     */
    setEnabled(jobName: string, enabled: boolean): void;
    private executeJob;
    private scheduleToMs;
    private emitEvent;
}
//# sourceMappingURL=scheduler.d.ts.map