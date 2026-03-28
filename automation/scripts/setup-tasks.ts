/**
 * setup-tasks — one-time schtasks registration for all out-of-runtime scripts.
 *
 * Registers ObsidiClaw's offline automation scripts as Windows Task Scheduler
 * entries. No Pi dependency — uses schtasks directly via WindowsTaskSchedulerBackend.
 *
 * Usage:
 *   npx tsx --env-file=.env automation/scripts/setup-tasks.ts
 *   npx tsx --env-file=.env automation/scripts/setup-tasks.ts --uninstall
 *
 * After installation, verify with:
 *   schtasks /Query /TN "ObsidiClaw" /FO LIST
 */

import { resolve } from "path";
import { WindowsTaskSchedulerBackend } from "../../core/os/scheduling-windows.js";

// ---------------------------------------------------------------------------
// Task definitions
// ---------------------------------------------------------------------------

interface TaskDef {
  /** schtasks task name under ObsidiClaw\ */
  name: string;
  /** Script path relative to rootDir */
  script: string;
  /** Extra CLI args to pass to the script */
  args?: string[];
  /** Interval in milliseconds */
  intervalMs: number;
}

const TASKS: TaskDef[] = [
  {
    name: "ObsidiClaw\\force-summarize",
    script: "automation/scripts/force-summarize.ts",
    intervalMs: 20 * 60_000, // every 20 min
  },
  {
    name: "ObsidiClaw\\mirror-codebase-ts",
    script: "automation/scripts/mirror-codebase.ts",
    args: ["--force"],
    intervalMs: 30 * 60_000, // every 30 min
  },
  {
    name: "ObsidiClaw\\mirror-codebase-py",
    script: "automation/scripts/mirror-codebase-py.ts",
    args: ["--force"],
    intervalMs: 30 * 60_000, // every 30 min
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const rootDir = resolve(import.meta.dirname, "..", "..");
const envFile = resolve(rootDir, ".env");
const uninstall = process.argv.includes("--uninstall");

// Resolve tsx binary (tsx.cmd on Windows for shell resolution)
const tsxBin = resolve(rootDir, "node_modules", ".bin", "tsx");

const backend = new WindowsTaskSchedulerBackend(rootDir);

if (uninstall) {
  console.log("[setup-tasks] uninstalling tasks...");
  for (const task of TASKS) {
    try {
      await backend.uninstall(task.name);
      console.log(`  removed: ${task.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Ignore "task not found" errors
      if (!msg.includes("cannot find") && !msg.includes("The system cannot find")) {
        console.warn(`  warning: ${task.name}: ${msg}`);
      } else {
        console.log(`  skipped (not found): ${task.name}`);
      }
    }
  }
  console.log("[setup-tasks] uninstall complete");
} else {
  console.log("[setup-tasks] installing tasks...");
  for (const task of TASKS) {
    const scriptAbs = resolve(rootDir, task.script);
    const args = [
      `--env-file=${envFile}`,
      scriptAbs,
      ...(task.args ?? []),
    ];
    try {
      await backend.install(task.name, task.intervalMs, tsxBin, args);
      const minutes = Math.round(task.intervalMs / 60_000);
      console.log(`  installed: ${task.name} (every ${minutes} min)`);
    } catch (err) {
      console.error(`  failed: ${task.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("[setup-tasks] installation complete");
  console.log(`\nVerify with: schtasks /Query /TN "ObsidiClaw" /FO LIST`);
}
