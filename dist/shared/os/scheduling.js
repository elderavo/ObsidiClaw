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
export {};
//# sourceMappingURL=scheduling.js.map