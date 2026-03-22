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
 *   schedule_task     — register a new recurring subagent task
 *   unschedule_task   — remove a dynamic task schedule
 */

import { join } from "path";
import { fileURLToPath } from "url";
import { Type } from "@sinclair/typebox";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { getSharedScheduler, getSharedBackend } from "../../extension/factory.js";
import { resolvePaths } from "../../shared/config.js";
import { getExecPath } from "../../shared/os/process.js";
import { writeTaskSpec, listTaskSpecs } from "../../scheduler/persistent-tasks.js";

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
      const backend = getSharedBackend();
      const lines = ["# Scheduled Jobs", ""];

      if (scheduler) {
        const states = scheduler.getStates();
        for (const s of states) {
          const lastRun = s.lastRunAt ? new Date(s.lastRunAt).toISOString() : "never";
          lines.push(`- **${s.name}** | last run: ${lastRun} | status: ${s.status}${s.lastError ? ` | error: ${s.lastError}` : ""}`);
        }
      }

      const paths = resolvePaths(rootDir);
      const specs = listTaskSpecs(paths.rootDir);
      const installed = backend ? await backend.list() : [];
      const installedMap = new Map(installed.map((j) => [j.jobName, j]));

      if (specs.length > 0) {
        lines.push("", "## Persistent Tasks");
        for (const spec of specs) {
          const taskName = spec.name;
          const job = installedMap.get(taskName);
          const status = job ? (job.enabled === false ? "disabled" : "enabled") : "not installed";
          lines.push(`- **${taskName}** | every ${spec.intervalMinutes}m | ${status} | desc: ${spec.description}`);
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

  // ── schedule_task ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "schedule_task",
    label: "Schedule Persistent Task",
    description: "Register a new recurring detached subagent task (persistent OS schedule).",
    promptSnippet: "schedule_task(name, description, prompt, plan, success_criteria, interval_minutes, ...)",
    parameters: Type.Object({
      name: Type.String({ description: "Unique task name (no 'task-' prefix)." }),
      description: Type.String({ description: "What the task does." }),
      prompt: Type.String({ description: "Prompt/context sent to subagent each run." }),
      plan: Type.String({ description: "Implementation plan for the subagent." }),
      success_criteria: Type.String({ description: "How to measure success." }),
      personality: Type.Optional(Type.String({ description: "Personality name (optional)." })),
      interval_minutes: Type.Number({ description: "Interval in minutes.", minimum: 1 }),
      run_immediately: Type.Optional(Type.Boolean({ description: "Run once right now." })),
    }),
    async execute(_id, params) {
      try {
        const backend = getSharedBackend();
        if (!backend) return { content: [{ type: "text" as const, text: "Persistent scheduling backend not available on this platform." }], details: { name: params.name } };

        const paths = resolvePaths(rootDir);
        const taskName = `task-${params.name}`;
        const spec = {
          name: taskName,
          description: params.description,
          prompt: params.prompt,
          plan: params.plan,
          successCriteria: params.success_criteria,
          personality: params.personality,
          intervalMinutes: params.interval_minutes,
          rootDir: paths.rootDir,
          createdAt: Date.now(),
          context: params.prompt,
        };

        const specPath = writeTaskSpec(paths.rootDir, spec);
        const scriptPath = join(paths.rootDir, "dist", "scripts", "run_detached_subagent.js");

        await backend.install(taskName, params.interval_minutes * 60_000, getExecPath(), [scriptPath, specPath]);

        const lines = [
          `Scheduled persistent task "${taskName}" — every ${params.interval_minutes} minute(s).`,
          `Spec: ${specPath}`,
        ];

        if (params.run_immediately && backend.run) {
          try {
            await backend.run(taskName);
            lines.push("First run triggered.");
          } catch (err) {
            lines.push(`First run failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { name: params.name, interval_minutes: params.interval_minutes } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `schedule_task failed: ${msg}` }], details: { name: params.name, error: msg } };
      }
    },
  });

  // ── unschedule_task ───────────────────────────────────────────────────────
  pi.registerTool({
    name: "unschedule_task",
    label: "Unschedule Persistent Task",
    description: "Remove/disable a persistent task schedule. Spec file is retained.",
    promptSnippet: "unschedule_task(name) — remove a dynamic task schedule",
    parameters: Type.Object({
      name: Type.String({ description: "Task name (without 'task-' prefix)." }),
    }),
    async execute(_id, { name }) {
      try {
        const backend = getSharedBackend();
        if (!backend) return { content: [{ type: "text" as const, text: "Persistent backend not available." }], details: { name } };
        const taskName = `task-${name}`;
        await backend.uninstall(taskName);
        return { content: [{ type: "text" as const, text: `Task "${taskName}" unscheduled (spec retained).` }], details: { name } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `unschedule_task failed: ${msg}` }], details: { name, error: msg } };
      }
    },
  });
};

export default extension;
