/**
 * Scheduler extension — Pi tools for inspecting and controlling scheduled jobs.
 *
 * These tools operate directly on the shared JobScheduler and
 * PersistentScheduleBackend from the ObsidiClawStack — no MCP round-trip needed.
 *
 * Tools:
 *   list_jobs         — unified view of registered + OS job state
 *   run_job           — trigger a built-in job immediately
 *   set_job_enabled   — enable/disable an OS task
 *   uninstall_job     — remove an orphaned OS task
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
    description:
      "List all scheduled jobs with unified view: code registration, OS state, " +
      "reconciliation status, and last-run info from runs.db. " +
      "For detailed usage, use retrieve_context with 'scheduler'.",
    promptSnippet: "list_jobs() — show scheduler state",
    parameters: Type.Object({}),
    async execute() {
      const scheduler = getSharedScheduler();
      if (!scheduler) {
        return {
          content: [{
            type: "text" as const,
            text: "Scheduler not initialized (no persistent backend available — Windows only).",
          }],
          details: {},
        };
      }

      const states = scheduler.getStates();
      if (states.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No jobs registered." }],
          details: {},
        };
      }

      const lines = states.map((s) => {
        const parts: string[] = [`**${s.name}**`];

        // Reconciliation badge
        if (s.reconciliation === "orphaned") {
          parts.push("ORPHANED");
        } else if (s.reconciliation === "install_failed") {
          parts.push("INSTALL FAILED");
        } else if (s.reconciliation === "missing") {
          parts.push("MISSING FROM OS");
        } else if (s.reconciliation === "unknown") {
          parts.push("OS state unknown");
        }

        // Schedule
        if (s.osScheduleDescription) {
          parts.push(`schedule: ${s.osScheduleDescription}`);
        }

        // runs.db status
        const lastRun = s.lastRunAt ? new Date(s.lastRunAt).toISOString() : "never";
        const dur = s.lastDurationMs != null ? ` (${s.lastDurationMs}ms)` : "";
        parts.push(`db status: ${s.status}`);
        parts.push(`db last run: ${lastRun}${dur}`);

        // OS state
        if (s.osEnabled !== undefined) {
          parts.push(`os: ${s.osEnabled ? "enabled" : "DISABLED"}/${s.osStatus ?? "?"}`);
        }
        if (s.osLastResult && s.osLastResult !== "0x0") {
          parts.push(`os last result: ${s.osLastResult} (FAILED)`);
        } else if (s.osLastResult === "0x0") {
          parts.push(`os last result: 0x0 (ok)`);
        }
        if (s.osLastRunTime) {
          parts.push(`os last run: ${s.osLastRunTime}`);
        }

        // Errors
        if (s.lastError) parts.push(`error: ${s.lastError}`);
        if (s.installError) parts.push(`install error: ${s.installError}`);

        return `- ${parts.join(" | ")}`;
      });

      // Warnings section
      const warnings: string[] = [];
      const orphaned = states.filter((s) => s.reconciliation === "orphaned");
      const failed = states.filter((s) => s.reconciliation === "install_failed");
      const osFailed = states.filter((s) => s.osLastResult && s.osLastResult !== "0x0");

      if (orphaned.length) {
        warnings.push(
          `${orphaned.length} orphaned OS task(s) not registered in code. ` +
          `Use \`uninstall_job\` to remove: ${orphaned.map((s) => s.name).join(", ")}`,
        );
      }
      if (failed.length) {
        warnings.push(
          `${failed.length} job(s) failed to install in OS: ${failed.map((s) => s.name).join(", ")}`,
        );
      }
      if (osFailed.length) {
        warnings.push(
          `${osFailed.length} job(s) have non-zero OS result codes (last execution failed): ` +
          osFailed.map((s) => `${s.name} (${s.osLastResult})`).join(", "),
        );
      }

      const warningBlock = warnings.length
        ? "\n\n**Warnings:**\n" + warnings.map((w) => `- ${w}`).join("\n")
        : "";

      const text = `## Scheduled Jobs (${states.length})\n${lines.join("\n")}${warningBlock}`;
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  // ── run_job ───────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "run_job",
    label: "Run Job Now",
    description:
      "Trigger a scheduled job to run immediately (outside its normal interval). " +
      "For detailed usage, use retrieve_context with 'scheduler'.",
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

  // ── uninstall_job ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "uninstall_job",
    label: "Uninstall OS Task",
    description:
      "Remove an OS scheduled task. Use this to clean up orphaned tasks that are " +
      "installed in Windows Task Scheduler but no longer registered in code.",
    promptSnippet: "uninstall_job(job_name) — remove orphaned OS task",
    promptGuidelines: [
      "Only use this for tasks flagged as 'orphaned' by list_jobs",
      "Ask the user before uninstalling — this deletes the OS task permanently",
    ],
    parameters: Type.Object({
      job_name: Type.String({ description: "Job name to uninstall from OS (e.g., 'old-job-name')." }),
    }),
    async execute(_id, { job_name }) {
      try {
        const backend = getSharedBackend();
        if (!backend) throw new Error("No persistent backend available.");
        await backend.uninstall(`ObsidiClaw\\${job_name}`);
        return {
          content: [{ type: "text" as const, text: `Uninstalled OS task "ObsidiClaw\\${job_name}".` }],
          details: { job_name },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `uninstall_job failed: ${msg}` }], details: { job_name, error: msg } };
      }
    },
  });
};

export default extension;
