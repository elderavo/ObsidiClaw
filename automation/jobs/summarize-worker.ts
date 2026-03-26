/**
 * Summarize worker — child process entry point.
 *
 * Spawned by mirror-watcher after mirrors complete. Runs the tiered
 * summarization cascade in its own process so that synchronous file I/O
 * and LLM calls do not block the Pi TUI event loop.
 *
 * Receives a JSON-serialized SummarizeWorkerConfig as argv[2].
 * Loads WorkspaceRegistry independently from workspacesPath.
 * Exits 0 on success, 1 on error.
 *
 * Usage (internal — do not invoke directly):
 *   tsx automation/jobs/summarize-worker.ts '<json>'
 */

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
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const raw = process.argv[2];

if (!raw) {
  console.error("[summarize-worker] missing config argument (argv[2])");
  process.exit(1);
}

let config: SummarizeWorkerConfig;
try {
  config = JSON.parse(raw) as SummarizeWorkerConfig;
} catch (err) {
  console.error("[summarize-worker] failed to parse config JSON:", err);
  process.exit(1);
}

const registry = new WorkspaceRegistry(config.workspacesPath, config.mdDbPath);
registry.load();

runCascadeForWorkspace({
  mirrorDir: config.mirrorDir,
  mdDbPath: config.mdDbPath,
  rootDir: config.rootDir,
  workspacesPath: config.workspacesPath,
  personalitiesDir: config.personalitiesDir,
  registry,
})
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("[summarize-worker] fatal:", err);
    process.exit(1);
  });
