/**
 * JobScheduler — OS-delegated job scheduler.
 *
 * On start(), installs each job as a persistent OS task via PersistentScheduleBackend.
 * All jobs run as: node dist/scripts/run-job.js <job-name>
 * Nothing executes in-process. Jobs survive process restarts.
 */

import { join } from "path";
import { randomUUID } from "crypto";
import { RunLogger } from "../logger/run-logger.js";
import type { PersistentScheduleBackend } from "../shared/os/scheduling.js";
import type { JobDefinition, JobState } from "./types.js";

export class JobScheduler {
  private readonly jobs = new Map<string, JobDefinition>();
  private readonly logger: RunLogger;
  private readonly backend: PersistentScheduleBackend;
  private readonly rootDir: string;
  private readonly sessionId: string;
  private installed = false;

  constructor(
    logger: RunLogger,
    backend: PersistentScheduleBackend,
    rootDir: string,
    sessionId?: string,
  ) {
    this.logger = logger;
    this.backend = backend;
    this.rootDir = rootDir;
    this.sessionId = sessionId ?? `scheduler-${randomUUID()}`;
  }

  register(job: JobDefinition): void {
    if (this.jobs.has(job.name)) {
      throw new Error(`Job "${job.name}" is already registered.`);
    }
    this.jobs.set(job.name, job);
  }

  /**
   * Install all registered jobs as OS-level scheduled tasks.
   * No-op if already installed this process lifetime.
   */
  async start(): Promise<void> {
    if (this.installed) return;
    this.installed = true;

    const runnerScript = join(this.rootDir, "dist", "scripts", "run-job.js");

    for (const job of this.jobs.values()) {
      const intervalMs = this.scheduleToMs(job.schedule);
      if (intervalMs < 60_000) {
        console.warn(`[scheduler] "${job.name}" interval <1m — skipped (OS minimum is 1 minute)`);
        continue;
      }
      const taskName = `ObsidiClaw\\${job.name}`;
      try {
        await this.backend.install(taskName, intervalMs, process.execPath, [runnerScript, job.name]);
        console.log(`[scheduler] installed OS task: ${taskName}`);
      } catch (err) {
        console.error(`[scheduler] failed to install "${taskName}":`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** No-op — OS tasks run independently and persist after process exit. */
  async stop(): Promise<void> {}

  /** Trigger a job immediately via schtasks /run. */
  async runNow(jobName: string): Promise<void> {
    if (!this.jobs.has(jobName)) throw new Error(`Job "${jobName}" is not registered.`);
    await this.backend.run?.(`ObsidiClaw\\${jobName}`);
  }

  /** Registered jobs merged with last-run data from runs.db. */
  getStates(): JobState[] {
    const history = this.logger.getLastJobRuns();
    return [...this.jobs.values()].map((job) => {
      const last = history.get(job.name);
      return {
        name: job.name,
        status: (last?.status ?? "idle") as JobState["status"],
        lastRunAt: last?.startTime ?? null,
        lastDurationMs: last?.durationMs ?? null,
        lastError: last?.error ?? null,
        runCount: last?.runCount ?? 0,
      };
    });
  }

  private scheduleToMs(schedule: JobDefinition["schedule"]): number {
    return (
      (schedule.hours ?? 0) * 3_600_000 +
      (schedule.minutes ?? 0) * 60_000 +
      (schedule.seconds ?? 0) * 1_000
    );
  }
}
