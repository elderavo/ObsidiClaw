/**
 * JobScheduler — OS-delegated job scheduler with startup reconciliation.
 *
 * On start(), installs each job as a persistent OS task via PersistentScheduleBackend,
 * then reconciles registered jobs against actual OS state.
 * All jobs run as: node dist/jobs/run-job.js <job-name>
 * Nothing executes in-process. Jobs survive process restarts.
 */

import { join } from "path";
import { randomUUID } from "crypto";
import { RunLogger } from "../logger/run-logger.js";
import type { PersistentScheduleBackend, ScheduledJob } from "../shared/os/scheduling.js";
import type { JobDefinition, JobState, ReconciliationStatus } from "./types.js";

interface ReconciliationEntry {
  reconciliation: ReconciliationStatus;
  osJob?: ScheduledJob;
}

export class JobScheduler {
  private readonly jobs = new Map<string, JobDefinition>();
  private readonly installErrors = new Map<string, string>();
  private readonly reconciliationState = new Map<string, ReconciliationEntry>();
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
   * Install all registered jobs as OS-level scheduled tasks,
   * then reconcile against actual OS state.
   * No-op if already installed this process lifetime.
   */
  async start(): Promise<void> {
    if (this.installed) return;
    this.installed = true;

    const runnerScript = join(this.rootDir, "dist", "jobs", "run-job.js");

    // Install all jobs in parallel — each schtasks call is independent.
    const installPromises: Promise<void>[] = [];
    for (const job of this.jobs.values()) {
      const intervalMs = this.scheduleToMs(job.schedule);
      if (intervalMs < 60_000) {
        console.warn(`[scheduler] "${job.name}" interval <1m — skipped (OS minimum is 1 minute)`);
        continue;
      }
      const taskName = `ObsidiClaw\\${job.name}`;
      installPromises.push(
        this.backend.install(taskName, intervalMs, process.execPath, [runnerScript, job.name]).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.installErrors.set(job.name, msg);
          console.error(`[scheduler] failed to install "${taskName}":`, msg);
        }),
      );
    }
    await Promise.all(installPromises);

    await this.reconcile();
  }

  /** No-op — OS tasks run independently and persist after process exit. */
  async stop(): Promise<void> {}

  /** Trigger a job immediately via schtasks /run. */
  async runNow(jobName: string): Promise<void> {
    if (!this.jobs.has(jobName)) throw new Error(`Job "${jobName}" is not registered.`);
    await this.backend.run?.(`ObsidiClaw\\${jobName}`);
  }

  /**
   * Unified view: registered jobs + orphaned OS tasks, merged with
   * run history from runs.db and reconciliation state from startup.
   */
  getStates(): JobState[] {
    const history = this.logger.getLastJobRuns();
    const states: JobState[] = [];

    // Registered jobs (with reconciliation + OS info)
    for (const job of this.jobs.values()) {
      const last = history.get(job.name);
      const recon = this.reconciliationState.get(job.name);
      states.push({
        name: job.name,
        status: (last?.status ?? "idle") as JobState["status"],
        lastRunAt: last?.startTime ?? null,
        lastDurationMs: last?.durationMs ?? null,
        lastError: last?.error ?? null,
        runCount: last?.runCount ?? 0,
        installError: this.installErrors.get(job.name),
        reconciliation: recon?.reconciliation ?? "unknown",
        osEnabled: recon?.osJob?.enabled,
        osStatus: recon?.osJob?.status,
        osScheduleDescription: recon?.osJob?.scheduleDescription,
        osLastRunTime: recon?.osJob?.lastRunTime,
        osLastResult: recon?.osJob?.lastResult,
      });
    }

    // Orphaned OS tasks (installed but not registered in code)
    for (const [name, recon] of this.reconciliationState) {
      if (recon.reconciliation === "orphaned") {
        states.push({
          name,
          status: "idle",
          lastRunAt: null,
          lastDurationMs: null,
          lastError: null,
          runCount: 0,
          reconciliation: "orphaned",
          osEnabled: recon.osJob?.enabled,
          osStatus: recon.osJob?.status,
          osScheduleDescription: recon.osJob?.scheduleDescription,
          osLastRunTime: recon.osJob?.lastRunTime,
          osLastResult: recon.osJob?.lastResult,
        });
      }
    }

    return states;
  }

  // ---------------------------------------------------------------------------
  // Reconciliation
  // ---------------------------------------------------------------------------

  /**
   * Query the OS for actually-installed tasks, compare against registered
   * jobs, and cache the result. Called once at the end of start().
   */
  private async reconcile(): Promise<void> {
    let osTasks: ScheduledJob[];
    try {
      osTasks = await this.backend.list();
    } catch (err) {
      console.warn(
        "[scheduler] reconciliation skipped — backend.list() failed:",
        err instanceof Error ? err.message : String(err),
      );
      for (const job of this.jobs.values()) {
        this.reconciliationState.set(job.name, { reconciliation: "unknown" });
      }
      return;
    }

    // Build lookup: strip "ObsidiClaw\" prefix from OS task names
    const osTaskMap = new Map<string, ScheduledJob>();
    for (const task of osTasks) {
      const shortName = task.jobName.replace(/^ObsidiClaw\\/, "");
      osTaskMap.set(shortName, task);
    }

    const runnerScript = join(this.rootDir, "dist", "jobs", "run-job.js");

    // Check each registered job against OS state
    for (const job of this.jobs.values()) {
      const osJob = osTaskMap.get(job.name);
      if (osJob) {
        // Registered + installed
        const recon: ReconciliationStatus = this.installErrors.has(job.name)
          ? "install_failed"
          : "ok";
        this.reconciliationState.set(job.name, { reconciliation: recon, osJob });
        osTaskMap.delete(job.name);
      } else {
        // Registered but NOT in OS — attempt reinstall
        console.warn(`[scheduler] "${job.name}" not found in OS — attempting reinstall`);
        const intervalMs = this.scheduleToMs(job.schedule);
        const taskName = `ObsidiClaw\\${job.name}`;
        try {
          await this.backend.install(taskName, intervalMs, process.execPath, [runnerScript, job.name]);
          this.installErrors.delete(job.name);
          this.reconciliationState.set(job.name, { reconciliation: "ok" });
          console.log(`[scheduler] reinstalled "${taskName}" successfully`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.installErrors.set(job.name, msg);
          this.reconciliationState.set(job.name, { reconciliation: "install_failed" });
          console.error(`[scheduler] reinstall of "${taskName}" failed:`, msg);
        }
      }
    }

    // Remaining entries are orphaned (in OS but not registered)
    for (const [shortName, osJob] of osTaskMap) {
      console.warn(`[scheduler] orphaned OS task: "${osJob.jobName}" (not registered in code)`);
      this.reconciliationState.set(shortName, { reconciliation: "orphaned", osJob });
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private scheduleToMs(schedule: JobDefinition["schedule"]): number {
    return (
      (schedule.hours ?? 0) * 3_600_000 +
      (schedule.minutes ?? 0) * 60_000 +
      (schedule.seconds ?? 0) * 1_000
    );
  }
}
