/**
 * Scheduler type definitions.
 *
 * Jobs are defined in code and registered with the JobScheduler.
 * The scheduler delegates execution to the OS (Windows Task Scheduler)
 * via a PersistentScheduleBackend.
 */

// ---------------------------------------------------------------------------
// Job definition
// ---------------------------------------------------------------------------

export interface JobDefinition {
  /** Unique job name (e.g., "reindex-md-db"). */
  name: string;

  /** Human-readable description. */
  description: string;

  /**
   * Interval specification. At least one field must be set.
   * Total interval = hours*3600000 + minutes*60000 + seconds*1000.
   */
  schedule: {
    hours?: number;
    minutes?: number;
    seconds?: number;
  };

  /** If true, skip this run if the previous run is still in progress. */
  skipIfRunning?: boolean;

  /** Maximum runtime in ms before the job is considered stuck. Default: none. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Job context (kept for compatibility — not passed to scripts)
// ---------------------------------------------------------------------------

export interface JobContext {
  /** Name of the job being executed. */
  jobName: string;

  /** Unique ID for this execution. */
  runId: string;

  /** Abort signal for timeout/cancellation. */
  signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// Job state
// ---------------------------------------------------------------------------

export type JobStatus = "idle" | "running" | "error" | "disabled";

/**
 * Reconciliation status — result of comparing code-registered jobs
 * against actually-installed OS tasks on startup.
 */
export type ReconciliationStatus =
  | "ok"              // registered + installed in OS
  | "missing"         // registered, not found in OS after install attempt
  | "install_failed"  // registered, install/reinstall threw an error
  | "orphaned"        // found in OS, not registered in code
  | "unknown";        // backend.list() failed, OS state unknown

export interface JobState {
  name: string;
  status: JobStatus;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  runCount: number;
  /** Set when start() failed to install the OS task via the persistent backend. */
  installError?: string;
  /** Result of startup reconciliation against OS state. */
  reconciliation?: ReconciliationStatus;
  /** Whether the OS task is enabled (from schtasks query). */
  osEnabled?: boolean;
  /** OS task status string (e.g. "Ready", "Running"). */
  osStatus?: string;
  /** Human-readable schedule from OS (e.g. "Every 30m"). */
  osScheduleDescription?: string;
  /** OS-reported last run time. */
  osLastRunTime?: string;
  /** OS-reported last result code (e.g. "0x0", "0x800710E0"). */
  osLastResult?: string;
}
