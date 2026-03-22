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

export interface JobState {
  name: string;
  status: JobStatus;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  runCount: number;
}
