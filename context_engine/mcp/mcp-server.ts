/**
 * ObsidiClaw MCP server — wraps ContextEngine + JobScheduler behind MCP.
 *
 * Context tools:
 *   retrieve_context     — hybrid RAG query
 *   get_preferences      — returns preferences.md content
 *   prepare_subagent     — build context-enriched system prompt for subagents
 *   build/list/get/update_prune_* — note deduplication management
 *
 * Scheduler tools (when scheduler is provided):
 *   list_jobs            — show all scheduled jobs with state
 *   run_job              — trigger a job immediately
 *   set_job_enabled      — enable/disable a job
 *   schedule_task        — register a new recurring subagent task
 *   unschedule_task      — remove a dynamically scheduled task
 *
 * Transport-agnostic: wire via InMemoryTransport or StdioServerTransport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ContextEngine } from "../context-engine.js";
import type { ContextPackage, SubagentPackage, PruneMemberStatus } from "../types.js";
import { PruneClusterStorage } from "../prune/prune-storage.js";
import type { JobScheduler } from "../../scheduler/scheduler.js";
import type { SubagentRunner } from "../../shared/agents/subagent-runner.js";

export type OnContextBuilt = (pkg: ContextPackage) => void;
export type OnSubagentPrepared = (pkg: SubagentPackage) => void;

export interface McpServerOptions {
  engine: ContextEngine;
  onContextBuilt?: OnContextBuilt;
  onSubagentPrepared?: OnSubagentPrepared;
  scheduler?: JobScheduler;
  subagentRunner?: SubagentRunner;
}

/**
 * @deprecated Use createContextEngineMcpServer(options: McpServerOptions) instead.
 */
export function createContextEngineMcpServer(
  engineOrOpts: ContextEngine | McpServerOptions,
  onContextBuilt?: OnContextBuilt,
  onSubagentPrepared?: OnSubagentPrepared,
): McpServer {
  // Support both old positional args and new options object
  const opts: McpServerOptions = "build" in engineOrOpts
    ? { engine: engineOrOpts, onContextBuilt, onSubagentPrepared }
    : engineOrOpts;

  return _createMcpServer(opts);
}

function _createMcpServer(opts: McpServerOptions): McpServer {
  const { engine, onContextBuilt, onSubagentPrepared, scheduler, subagentRunner } = opts;
  const server = new McpServer({ name: "obsidi-claw-context", version: "1.0.0" });

  // ── retrieve_context ──────────────────────────────────────────────────────

  server.registerTool(
    "retrieve_context",
    {
      description:
        "Search the ObsidiClaw knowledge base for relevant notes, tools, concepts, and best " +
        "practices. Returns markdown-formatted context from the md_db knowledge graph. " +
        "Call this before relying on your own knowledge for any project-specific question.",
      inputSchema: {
        query: z.string().describe("What to search for in the knowledge base."),
      },
    },
    async ({ query }) => {
      const pkg = await engine.build(query);
      onContextBuilt?.(pkg);
      return { content: [{ type: "text" as const, text: pkg.formattedContext }] };
    },
  );

  // ── get_preferences ───────────────────────────────────────────────────────

  server.registerTool(
    "get_preferences",
    {
      description: "Return the content of preferences.md from the knowledge base.",
      inputSchema: {},
    },
    async () => {
      const content = engine.getNoteContent("preferences.md") ?? "";
      return { content: [{ type: "text" as const, text: content }] };
    },
  );

  // ── prepare_subagent ──────────────────────────────────────────────────────

  server.registerTool(
    "prepare_subagent",
    {
      description:
        "Prepare a SubagentPackage: runs hybrid RAG on the implementation plan, then bundles " +
        "prompt + plan + retrieved context + success criteria into a formatted system prompt " +
        "ready for injection into a child Pi session. Call this before spawning a subagent.",
      inputSchema: {
        prompt: z.string().describe("Top-level task description for the subagent."),
        plan: z.string().describe("Detailed implementation plan from the main agent."),
        success_criteria: z.string().describe("Clear, measurable criteria for task completion."),
        personality: z.string().optional().describe("Personality profile name (e.g., 'deep-researcher', 'code-reviewer', 'context-gardener')."),
      },
    },
    async ({ prompt, plan, success_criteria, personality }) => {
      const pkg = await engine.buildSubagentPackage({
        prompt,
        plan,
        successCriteria: success_criteria,
        personality,
      });
      onSubagentPrepared?.(pkg);
      return { content: [{ type: "text" as const, text: pkg.formattedSystemPrompt }] };
    },
  );

  // ── prune: build clusters ────────────────────────────────────────────────
  server.registerTool(
    "build_prune_clusters",
    {
      description:
        "Compute vector-similarity prune clusters and persist them. Does not change notes or the vector store.",
      inputSchema: {
        similarity_threshold: z.number().optional().describe("Minimum similarity (0-1) to connect notes."),
        max_neighbors_per_note: z.number().optional().describe("Max neighbors to consider per note."),
        min_cluster_size: z.number().optional().describe("Minimum size for a cluster to be recorded."),
        include_note_types: z.array(z.string()).optional().describe("Note types to include (e.g. ['concept'])."),
        exclude_tags: z.array(z.string()).optional().describe("Tags to exclude from pruning (optional)."),
      },
    },
    async (input) => {
      const clusters = await engine.buildPruneClusters({
        similarityThreshold: input.similarity_threshold,
        maxNeighborsPerNote: input.max_neighbors_per_note,
        minClusterSize: input.min_cluster_size,
        includeNoteTypes: input.include_note_types as any,
        excludeTags: input.exclude_tags,
      });
      return { content: [{ type: "text" as const, text: formatClusterListMarkdown(clusters) }] };
    },
  );

  // ── prune: list clusters ─────────────────────────────────────────────────
  server.registerTool(
    "list_prune_clusters",
    {
      description: "List stored prune clusters (built via build_prune_clusters).",
      inputSchema: {
        min_size: z.number().optional().describe("Only return clusters with size >= this."),
        status: z.enum(["pending", "keep", "merge", "ignore"]).optional(),
      },
    },
    async ({ min_size, status }) => {
      const storage = getPruneStorage(engine);
      const clusters = storage.listClusters({ minSize: min_size, status: status as PruneMemberStatus });
      return { content: [{ type: "text" as const, text: formatClusterListMarkdown(clusters) }] };
    },
  );

  // ── prune: get cluster detail ────────────────────────────────────────────
  server.registerTool(
    "get_prune_cluster",
    {
      description: "Get details for a specific prune cluster (members, scores, statuses).",
      inputSchema: {
        cluster_id: z.string(),
      },
    },
    async ({ cluster_id }) => {
      const storage = getPruneStorage(engine);
      const cluster = storage.getCluster(cluster_id);
      if (!cluster) {
        return { content: [{ type: "text" as const, text: `No cluster found for id ${cluster_id}` }] };
      }
      return { content: [{ type: "text" as const, text: formatClusterDetail(cluster) }] };
    },
  );

  // ── prune: update member status ──────────────────────────────────────────
  server.registerTool(
    "update_prune_member_status",
    {
      description: "Update review status for a note inside a prune cluster.",
      inputSchema: {
        cluster_id: z.string(),
        note_id: z.string(),
        status: z.enum(["pending", "keep", "merge", "ignore"]),
      },
    },
    async ({ cluster_id, note_id, status }) => {
      const storage = getPruneStorage(engine);
      storage.updateMemberStatus(cluster_id, note_id, status as PruneMemberStatus);
      const cluster = storage.getCluster(cluster_id);
      return {
        content: [{
          type: "text" as const,
          text: cluster ? formatClusterDetail(cluster) : `Updated ${note_id} in ${cluster_id}.`,
        }],
      };
    },
  );

  // ── Scheduler tools (Layer 1 — inspect & control existing jobs) ─────────
  if (scheduler) {
    registerSchedulerTools(server, scheduler, subagentRunner);
  }

  return server;
}

// ---------------------------------------------------------------------------
// Scheduler MCP tools
// ---------------------------------------------------------------------------

function registerSchedulerTools(
  server: McpServer,
  scheduler: JobScheduler,
  subagentRunner?: SubagentRunner,
): void {
  // ── list_jobs ───────────────────────────────────────────────────────────
  server.registerTool(
    "list_jobs",
    {
      description:
        "List all scheduled jobs with their current state: status, last run time, " +
        "duration, error, and run count.",
      inputSchema: {},
    },
    async () => {
      const states = scheduler.getStates();
      if (states.length === 0) {
        return { content: [{ type: "text" as const, text: "No scheduled jobs registered." }] };
      }
      const lines = ["# Scheduled Jobs", ""];
      for (const s of states) {
        const lastRun = s.lastRunAt ? new Date(s.lastRunAt).toISOString() : "never";
        const duration = s.lastDurationMs != null ? `${s.lastDurationMs}ms` : "-";
        const error = s.lastError ? ` | error: ${s.lastError}` : "";
        lines.push(`- **${s.name}** | ${s.status} | runs: ${s.runCount} | last: ${lastRun} (${duration})${error}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── run_job ─────────────────────────────────────────────────────────────
  server.registerTool(
    "run_job",
    {
      description: "Trigger a scheduled job to run immediately (outside its normal interval).",
      inputSchema: {
        job_name: z.string().describe("Name of the job to run (e.g., 'reindex-md-db', 'health-check')."),
      },
    },
    async ({ job_name }) => {
      try {
        await scheduler.runNow(job_name);
        return { content: [{ type: "text" as const, text: `Job "${job_name}" completed successfully.` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Job "${job_name}" failed: ${msg}` }] };
      }
    },
  );

  // ── set_job_enabled ─────────────────────────────────────────────────────
  server.registerTool(
    "set_job_enabled",
    {
      description: "Enable or disable a scheduled job. Disabled jobs skip their interval.",
      inputSchema: {
        job_name: z.string().describe("Name of the job."),
        enabled: z.boolean().describe("True to enable, false to disable."),
      },
    },
    async ({ job_name, enabled }) => {
      try {
        scheduler.setEnabled(job_name, enabled);
        return { content: [{ type: "text" as const, text: `Job "${job_name}" is now ${enabled ? "enabled" : "disabled"}.` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed: ${msg}` }] };
      }
    },
  );

  // ── schedule_task (Layer 2 — agent-initiated dynamic scheduling) ───────
  server.registerTool(
    "schedule_task",
    {
      description:
        "Register a new recurring task on the scheduler. The task runs a subagent with " +
        "the given prompt and personality on the specified interval. Use this to set up " +
        "recurring maintenance, research, or monitoring tasks.",
      inputSchema: {
        name: z.string().describe("Unique task name (e.g., 'monitor-ollama-releases')."),
        description: z.string().describe("What this task does."),
        prompt: z.string().describe("The prompt to send to the subagent on each run."),
        plan: z.string().describe("Implementation plan for the subagent."),
        success_criteria: z.string().describe("How to know the task succeeded."),
        personality: z.string().optional().describe("Personality to use (e.g., 'deep-researcher')."),
        interval_minutes: z.number().min(1).describe("How often to run, in minutes."),
        run_immediately: z.boolean().optional().describe("Run once right now in addition to scheduling. Default: false."),
      },
    },
    async ({ name, description, prompt, plan, success_criteria, personality, interval_minutes, run_immediately }) => {
      if (!subagentRunner) {
        return { content: [{ type: "text" as const, text: "Cannot schedule tasks: subagent runner not available." }] };
      }

      const taskName = `dynamic:${name}`;

      // Check for duplicates
      const existing = scheduler.getStates().find((s) => s.name === taskName);
      if (existing) {
        return { content: [{ type: "text" as const, text: `Task "${taskName}" already exists. Unschedule it first to replace.` }] };
      }

      const runner = subagentRunner;
      scheduler.registerAndStart({
        name: taskName,
        description,
        schedule: { minutes: interval_minutes },
        skipIfRunning: true,
        timeoutMs: 600_000, // 10 min default for dynamic tasks
        async execute(ctx) {
          const result = await runner.run(
            { prompt, plan, successCriteria: success_criteria, personality },
            ctx.signal,
          );
          if (result.outcome === "error") {
            throw new Error(result.output);
          }
        },
      });

      const lines = [
        `Scheduled task "${taskName}" — runs every ${interval_minutes} minute(s).`,
        `Subagent: ${personality ?? "(default)"} | timeout: 10m`,
      ];

      if (run_immediately) {
        try {
          await scheduler.runNow(taskName);
          lines.push("First run completed successfully.");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          lines.push(`First run failed: ${msg}`);
        }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── unschedule_task ─────────────────────────────────────────────────────
  server.registerTool(
    "unschedule_task",
    {
      description:
        "Remove a dynamically scheduled task. Only tasks created via schedule_task " +
        "(prefixed with 'dynamic:') can be removed. Built-in jobs cannot be unscheduled.",
      inputSchema: {
        name: z.string().describe("Task name (without the 'dynamic:' prefix)."),
      },
    },
    async ({ name }) => {
      const taskName = `dynamic:${name}`;
      const removed = scheduler.unregister(taskName);
      if (removed) {
        return { content: [{ type: "text" as const, text: `Task "${taskName}" unscheduled and removed.` }] };
      }
      return { content: [{ type: "text" as const, text: `No task named "${taskName}" found.` }] };
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPruneStorage(engine: ContextEngine): PruneClusterStorage {
  const graph = engine.getGraphStore();
  if (!graph) throw new Error("ContextEngine not initialized. Call initialize() first.");
  return new PruneClusterStorage(graph.getDatabase());
}

function formatClusterListMarkdown(clusters: import("../types.js").PruneCluster[]): string {
  if (clusters.length === 0) return "No prune clusters available.";
  const lines: string[] = ["# Prune Clusters", ""];
  for (const c of clusters) {
    lines.push(`- ${c.clusterId} | size ${c.stats.size} | rep ${c.representativeNoteId} | avg ${c.stats.avgSimilarity.toFixed(3)}`);
  }
  return lines.join("\n");
}

function formatClusterDetail(cluster: import("../types.js").PruneCluster): string {
  const lines: string[] = [
    `# Cluster ${cluster.clusterId}`,
    `Representative: ${cluster.representativeNoteId}`,
    `Size: ${cluster.stats.size} | max ${cluster.stats.maxSimilarity.toFixed(3)} | min ${cluster.stats.minSimilarity.toFixed(3)} | avg ${cluster.stats.avgSimilarity.toFixed(3)}`,
    "",
    "## Members",
  ];

  for (const m of cluster.members) {
    lines.push(
      `- ${m.noteId} | sim ${m.similarity.toFixed(3)} | ${m.isRepresentative ? "REP" : "member"} | status: ${m.status}`,
    );
  }

  return lines.join("\n");
}


