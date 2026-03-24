/**
 * Persistent scheduling backend interface.
 *
 * This is a stub for future OS-native scheduling support.
 * Implementations would wrap platform-specific schedulers:
 *   - Windows: Task Scheduler (schtasks)
 *   - macOS:   launchd (launchctl)
 *   - Linux:   cron / systemd timers
 *
 * Currently ObsidiClaw uses only the in-process JobScheduler (setInterval).
 * When persistent scheduling is needed (jobs that survive process restarts),
 * implement this interface for the target platform and register it with
 * the JobScheduler.
 */

export interface ScheduledJob {
  jobName: string;
  intervalMs: number;
  command: string;
  args: string[];
  enabled?: boolean;
  status?: string;
  /** OS-reported last run time (raw string from schtasks/launchd). */
  lastRunTime?: string;
  /** OS-reported last result code (e.g. "0x0" for success). */
  lastResult?: string;
  /** Human-readable schedule (e.g. "Every 30m", "Daily"). */
  scheduleDescription?: string;
}

export interface PersistentScheduleBackend {
  /**
   * Install a persistent system-level schedule that will run even if
   * the ObsidiClaw process is not alive.
   */
  install(
    jobName: string,
    intervalMs: number,
    command: string,
    args: string[],
  ): Promise<void>;

  /**
   * Remove a previously installed persistent schedule.
   */
  uninstall(jobName: string): Promise<void>;

  /**
   * List all installed persistent schedules managed by ObsidiClaw.
   */
  list(): Promise<ScheduledJob[]>;

  /** Enable or disable a schedule (if supported). */
  setEnabled?(jobName: string, enabled: boolean): Promise<void>;

  /** Trigger a run immediately (if supported). */
  run?(jobName: string): Promise<void>;
}
