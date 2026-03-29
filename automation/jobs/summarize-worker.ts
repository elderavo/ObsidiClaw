/**
 * Summarize worker — child process entry point.
 *
 * Spawned by mirror-watcher after mirrors complete. Runs the tiered
 * summarization cascade in its own process so that synchronous file I/O
 * and LLM calls do not block the Pi TUI event loop.
 *
 * Receives a path to a JSON config file as argv[2] (written by mirror-watcher
 * to avoid Windows cmd.exe quote-mangling of inline JSON).
 * Loads WorkspaceRegistry independently from workspacesPath.
 * Exits 0 on success, 1 on error.
 *
 * Progress and errors are written to notes.db (job_runs + job_logs tables)
 * via NoteMetricsLogger — not runs.db, which is Pi agent session territory.
 *
 * Usage (internal — do not invoke directly):
 *   tsx automation/jobs/summarize-worker.ts <config-file-path>
 */

import { readFileSync, unlinkSync } from "fs";
import { NoteMetricsLogger } from "../../logger/note-metrics.js";
import { WorkspaceRegistry } from "../workspaces/workspace-registry.js";
import { runCascadeForWorkspace } from "./summarize-lib.js";

// ---------------------------------------------------------------------------
// Config type — serializable subset of WorkspaceSummarizeConfig
// ---------------------------------------------------------------------------

export interface SummarizeWorkerConfig {
  mirrorDir: string;
  mdDbPath: string;
  rootDir: string;
  workspacesPath: string;
  personalitiesDir: string;
  /** Workspace name — recorded in job_runs for filtering. */
  workspace: string;
  /** Absolute path to notes.db — job_runs / job_logs land here, not runs.db. */
  notesDbPath: string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const configPath = process.argv[2];

if (!configPath) {
  process.stderr.write("[summarize-worker] missing config path argument (argv[2])\n");
  process.exit(1);
}

let config: SummarizeWorkerConfig;
try {
  const raw = readFileSync(configPath, "utf8");
  try { unlinkSync(configPath); } catch { /* ignore */ }
  config = JSON.parse(raw) as SummarizeWorkerConfig;
} catch (err) {
  process.stderr.write(`[summarize-worker] failed to read/parse config file: ${err}\n`);
  process.exit(1);
}

const metrics = new NoteMetricsLogger(config.notesDbPath);
const jobRunId = metrics.startJob("summarize_cascade", config.workspace);

const log = (level: "info" | "warn" | "error", message: string): void => {
  metrics.logJobMessage(jobRunId, level, message);
};

const registry = new WorkspaceRegistry(config.workspacesPath, config.mdDbPath);
registry.load();

const t0 = Date.now();

runCascadeForWorkspace({
  mirrorDir: config.mirrorDir,
  mdDbPath: config.mdDbPath,
  rootDir: config.rootDir,
  workspacesPath: config.workspacesPath,
  personalitiesDir: config.personalitiesDir,
  registry,
  log,
})
  .then(() => {
    metrics.finishJob(jobRunId, "complete", {
      statsJson: { durationMs: Date.now() - t0 },
    });
    metrics.close();
    process.exit(0);
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    metrics.logJobMessage(jobRunId, "error", `fatal: ${message}`);
    metrics.finishJob(jobRunId, "error", { errorText: message });
    metrics.close();
    process.exit(1);
  });
