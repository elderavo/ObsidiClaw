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
import { randomUUID } from "crypto";
// ---------------------------------------------------------------------------
// JobScheduler
// ---------------------------------------------------------------------------
export class JobScheduler {
    jobs = new Map();
    logger;
    sessionId;
    running = false;
    constructor(logger, sessionId) {
        this.logger = logger;
        this.sessionId = sessionId ?? `scheduler-${randomUUID()}`;
    }
    /**
     * Register a job definition. Does not start it.
     * Throws if a job with the same name is already registered.
     */
    register(job) {
        if (this.jobs.has(job.name)) {
            throw new Error(`Job "${job.name}" is already registered.`);
        }
        this.jobs.set(job.name, {
            def: job,
            state: {
                name: job.name,
                status: "idle",
                lastRunAt: null,
                lastDurationMs: null,
                lastError: null,
                runCount: 0,
            },
            timer: null,
            controller: null,
        });
    }
    /**
     * Start all registered jobs.
     * Sets up intervals and runs runOnStart jobs immediately.
     */
    async start() {
        if (this.running)
            return;
        this.running = true;
        for (const entry of this.jobs.values()) {
            const intervalMs = this.scheduleToMs(entry.def.schedule);
            if (intervalMs <= 0)
                continue;
            // Set up the interval
            entry.timer = setInterval(() => {
                void this.executeJob(entry);
            }, intervalMs);
            // Don't keep the process alive just for scheduled jobs
            if (entry.timer.unref)
                entry.timer.unref();
            // Run immediately if configured
            if (entry.def.runOnStart) {
                void this.executeJob(entry);
            }
        }
    }
    /**
     * Stop all jobs. Clears intervals and aborts running jobs.
     */
    async stop() {
        this.running = false;
        for (const entry of this.jobs.values()) {
            if (entry.timer) {
                clearInterval(entry.timer);
                entry.timer = null;
            }
            if (entry.controller) {
                entry.controller.abort();
                entry.controller = null;
            }
        }
    }
    /**
     * Run a single job immediately (outside its schedule).
     */
    async runNow(jobName) {
        const entry = this.jobs.get(jobName);
        if (!entry) {
            throw new Error(`Job "${jobName}" is not registered.`);
        }
        await this.executeJob(entry);
    }
    /**
     * Get current state of all registered jobs.
     */
    getStates() {
        return [...this.jobs.values()].map((e) => ({ ...e.state }));
    }
    /**
     * Unregister a job. Stops its interval and removes it entirely.
     * No-op if the job doesn't exist.
     */
    unregister(jobName) {
        const entry = this.jobs.get(jobName);
        if (!entry)
            return false;
        if (entry.timer) {
            clearInterval(entry.timer);
            entry.timer = null;
        }
        if (entry.controller) {
            entry.controller.abort();
            entry.controller = null;
        }
        this.jobs.delete(jobName);
        return true;
    }
    /**
     * Register a job and start its interval immediately (if scheduler is running).
     */
    registerAndStart(job) {
        this.register(job);
        if (this.running) {
            const entry = this.jobs.get(job.name);
            const intervalMs = this.scheduleToMs(entry.def.schedule);
            if (intervalMs > 0) {
                entry.timer = setInterval(() => {
                    void this.executeJob(entry);
                }, intervalMs);
                if (entry.timer.unref)
                    entry.timer.unref();
            }
        }
    }
    /**
     * Disable or enable a job.
     */
    setEnabled(jobName, enabled) {
        const entry = this.jobs.get(jobName);
        if (!entry) {
            throw new Error(`Job "${jobName}" is not registered.`);
        }
        if (enabled && entry.state.status === "disabled") {
            entry.state.status = "idle";
        }
        else if (!enabled) {
            // Cancel if running
            if (entry.controller) {
                entry.controller.abort();
                entry.controller = null;
            }
            entry.state.status = "disabled";
        }
    }
    // ── Private ──────────────────────────────────────────────────────────────
    async executeJob(entry) {
        const { def, state } = entry;
        // Skip if disabled
        if (state.status === "disabled")
            return;
        // Skip if already running and configured to not overlap
        if (state.status === "running" && def.skipIfRunning)
            return;
        const runId = randomUUID();
        const startTime = Date.now();
        // Set up abort controller
        const controller = new AbortController();
        entry.controller = controller;
        if (def.timeoutMs) {
            const timer = setTimeout(() => controller.abort(), def.timeoutMs);
            if (timer.unref)
                timer.unref();
        }
        state.status = "running";
        const ctx = {
            jobName: def.name,
            runId,
            signal: controller.signal,
        };
        // Create a run row so job executions appear alongside prompt-based runs
        this.logger.insertJobRun(runId, this.sessionId, startTime, def.name);
        this.emitEvent({
            type: "job_start",
            sessionId: this.sessionId,
            timestamp: startTime,
            jobName: def.name,
            runId,
        });
        try {
            await def.execute(ctx);
            const durationMs = Date.now() - startTime;
            state.status = "idle";
            state.lastRunAt = startTime;
            state.lastDurationMs = durationMs;
            state.lastError = null;
            state.runCount++;
            this.logger.finalizeRun(runId, "done", Date.now());
            this.emitEvent({
                type: "job_complete",
                sessionId: this.sessionId,
                timestamp: Date.now(),
                jobName: def.name,
                runId,
                durationMs,
            });
        }
        catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            state.status = "error";
            state.lastRunAt = startTime;
            state.lastDurationMs = Date.now() - startTime;
            state.lastError = error;
            state.runCount++;
            this.logger.finalizeRun(runId, "error", Date.now());
            this.emitEvent({
                type: "job_error",
                sessionId: this.sessionId,
                timestamp: Date.now(),
                jobName: def.name,
                runId,
                error,
            });
        }
        finally {
            entry.controller = null;
        }
    }
    scheduleToMs(schedule) {
        return ((schedule.hours ?? 0) * 3_600_000 +
            (schedule.minutes ?? 0) * 60_000 +
            (schedule.seconds ?? 0) * 1_000);
    }
    emitEvent(event) {
        this.logger.logEvent(event);
    }
}
//# sourceMappingURL=scheduler.js.map