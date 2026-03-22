/**
 * Scheduler extension — Pi tools for inspecting and controlling scheduled jobs.
 *
 * These tools operate directly on the shared JobScheduler and
 * PersistentScheduleBackend from the ObsidiClawStack — no MCP round-trip needed.
 *
 * Tools:
 *   list_jobs         — show all jobs + last-run state
 *   run_job           — trigger a built-in job immediately
 *   set_job_enabled   — enable/disable an OS task
 */

import { join } from "path";
import { fileURLToPath } from "url";
import { Type } from "@sinclair/typebox";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { getSharedScheduler, getSharedBackend } from "../../extension/factory.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = join(__dirname, "../..");

const extension: ExtensionFactory = async (pi) => {
  // ── list_jobs ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "list_jobs",
    label: "List Scheduled Jobs",
    description: "List all scheduled jobs with their current state and last-run info.",
    promptSnippet: "list_jobs() — show scheduler state",
    parameters: Type.Object({}),
    async execute() {
      const scheduler = getSharedScheduler();
      const lines = ["# Scheduled Jobs", ""];

      if (scheduler) {
        const states = scheduler.getStates();
        for (const s of states) {
          const lastRun = s.lastRunAt ? new Date(s.lastRunAt).toISOString() : "never";
          lines.push(`- **${s.name}** | last run: ${lastRun} | status: ${s.status}${s.lastError ? ` | error: ${s.lastError}` : ""}`);
        }
      }

      const text = lines.length === 2 ? "No scheduled jobs registered." : lines.join("\n");
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  // ── run_job ───────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "run_job",
    label: "Run Job Now",
    description: "Trigger a scheduled job to run immediately (outside its normal interval).",
    promptSnippet: "run_job(job_name) — run a scheduler job now",
    parameters: Type.Object({
      job_name: Type.String({ description: "Job name (e.g., 'reindex-md-db')." }),
    }),
    async execute(_id, { job_name }) {
      try {
        const scheduler = getSharedScheduler();
        const backend = getSharedBackend();
        if (scheduler && scheduler.getStates().some((s) => s.name === job_name)) {
          await scheduler.runNow(job_name);
        } else if (backend?.run) {
          await backend.run(job_name);
        } else {
          throw new Error("Job not found.");
        }
        return { content: [{ type: "text" as const, text: `Job "${job_name}" triggered successfully.` }], details: { job_name } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `run_job failed: ${msg}` }], details: { job_name, error: msg } };
      }
    },
  });

  // ── set_job_enabled ───────────────────────────────────────────────────────
  pi.registerTool({
    name: "set_job_enabled",
    label: "Enable/Disable Job",
    description: "Enable or disable a scheduled OS task.",
    promptSnippet: "set_job_enabled(job_name, enabled)",
    parameters: Type.Object({
      job_name: Type.String({ description: "Job name." }),
      enabled: Type.Boolean({ description: "True to enable, false to disable." }),
    }),
    async execute(_id, { job_name, enabled }) {
      try {
        const backend = getSharedBackend();
        if (!backend?.setEnabled) throw new Error("Persistent backend does not support enable/disable.");
        await backend.setEnabled(`ObsidiClaw\\${job_name}`, enabled);
        return {
          content: [{ type: "text" as const, text: `Job "${job_name}" is now ${enabled ? "enabled" : "disabled"}.` }],
          details: { job_name, enabled },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `set_job_enabled failed: ${msg}` }], details: { job_name, enabled, error: msg } };
      }
    },
  });
};

export default extension;
