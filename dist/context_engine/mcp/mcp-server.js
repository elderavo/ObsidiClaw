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
import { join } from "path";
import Database from "better-sqlite3";
import { PruneClusterStorage } from "../prune/prune-storage.js";
import { resolvePaths } from "../../shared/config.js";
import { getExecPath } from "../../shared/os/process.js";
import { writeTaskSpec, listTaskSpecs } from "../../scheduler/persistent-tasks.js";
/**
 * @deprecated Use createContextEngineMcpServer(options: McpServerOptions) instead.
 */
export function createContextEngineMcpServer(engineOrOpts, onContextBuilt, onSubagentPrepared) {
    // Support both old positional args and new options object
    const opts = "build" in engineOrOpts
        ? { engine: engineOrOpts, onContextBuilt, onSubagentPrepared }
        : engineOrOpts;
    return _createMcpServer(opts);
}
function _createMcpServer(opts) {
    const { engine, onContextBuilt, onSubagentPrepared, scheduler, subagentRunner, persistentBackend, rootDir } = opts;
    const server = new McpServer({ name: "obsidi-claw-context", version: "1.0.0" });
    // ── retrieve_context ──────────────────────────────────────────────────────
    // Default budget: ~750 tokens. Keeps total prompt well under 4k context models.
    const DEFAULT_MAX_CHARS = 3000;
    server.registerTool("retrieve_context", {
        description: "Search the ObsidiClaw knowledge base for relevant notes, tools, concepts, and best " +
            "practices. Returns markdown-formatted context from the md_db knowledge graph. " +
            "Call this before relying on your own knowledge for any project-specific question.",
        inputSchema: {
            query: z.string().describe("What to search for in the knowledge base."),
            max_chars: z.number().optional().describe("Maximum characters to return (default: 3000). Use a smaller value for tighter context."),
        },
    }, async ({ query, max_chars }) => {
        const pkg = await engine.build(query);
        onContextBuilt?.(pkg);
        const budget = max_chars ?? DEFAULT_MAX_CHARS;
        const text = pkg.formattedContext.length <= budget
            ? pkg.formattedContext
            : pkg.formattedContext.slice(0, budget) + "\n\n_(context truncated to fit budget)_\n<!-- End ObsidiClaw Context -->";
        return { content: [{ type: "text", text }] };
    });
    // ── get_preferences ───────────────────────────────────────────────────────
    server.registerTool("get_preferences", {
        description: "Return the content of preferences.md from the knowledge base.",
        inputSchema: {},
    }, async () => {
        const content = engine.getNoteContent("preferences.md") ?? "";
        return { content: [{ type: "text", text: content }] };
    });
    // ── prepare_subagent ──────────────────────────────────────────────────────
    server.registerTool("prepare_subagent", {
        description: "Prepare a SubagentPackage: runs hybrid RAG on the implementation plan, then bundles " +
            "prompt + plan + retrieved context + success criteria into a formatted system prompt " +
            "ready for injection into a child Pi session. Call this before spawning a subagent.",
        inputSchema: {
            prompt: z.string().describe("Top-level task description for the subagent."),
            plan: z.string().describe("Detailed implementation plan from the main agent."),
            success_criteria: z.string().describe("Clear, measurable criteria for task completion."),
            personality: z.string().optional().describe("Personality profile name (e.g., 'deep-researcher', 'code-reviewer', 'context-gardener')."),
        },
    }, async ({ prompt, plan, success_criteria, personality }) => {
        const pkg = await engine.buildSubagentPackage({
            prompt,
            plan,
            successCriteria: success_criteria,
            personality,
        });
        onSubagentPrepared?.(pkg);
        return { content: [{ type: "text", text: pkg.formattedSystemPrompt }] };
    });
    // ── prune: build clusters ────────────────────────────────────────────────
    server.registerTool("build_prune_clusters", {
        description: "Compute vector-similarity prune clusters and persist them. Does not change notes or the vector store.",
        inputSchema: {
            similarity_threshold: z.number().optional().describe("Minimum similarity (0-1) to connect notes."),
            max_neighbors_per_note: z.number().optional().describe("Max neighbors to consider per note."),
            min_cluster_size: z.number().optional().describe("Minimum size for a cluster to be recorded."),
            include_note_types: z.array(z.string()).optional().describe("Note types to include (e.g. ['concept'])."),
            exclude_tags: z.array(z.string()).optional().describe("Tags to exclude from pruning (optional)."),
        },
    }, async (input) => {
        const clusters = await engine.buildPruneClusters({
            similarityThreshold: input.similarity_threshold,
            maxNeighborsPerNote: input.max_neighbors_per_note,
            minClusterSize: input.min_cluster_size,
            includeNoteTypes: input.include_note_types,
            excludeTags: input.exclude_tags,
        });
        return { content: [{ type: "text", text: formatClusterListMarkdown(clusters) }] };
    });
    // ── prune: list clusters ─────────────────────────────────────────────────
    server.registerTool("list_prune_clusters", {
        description: "List stored prune clusters (built via build_prune_clusters).",
        inputSchema: {
            min_size: z.number().optional().describe("Only return clusters with size >= this."),
            status: z.enum(["pending", "keep", "merge", "ignore"]).optional(),
        },
    }, async ({ min_size, status }) => {
        const storage = getPruneStorage(engine);
        const clusters = storage.listClusters({ minSize: min_size, status: status });
        return { content: [{ type: "text", text: formatClusterListMarkdown(clusters) }] };
    });
    // ── prune: get cluster detail ────────────────────────────────────────────
    server.registerTool("get_prune_cluster", {
        description: "Get details for a specific prune cluster (members, scores, statuses).",
        inputSchema: {
            cluster_id: z.string(),
        },
    }, async ({ cluster_id }) => {
        const storage = getPruneStorage(engine);
        const cluster = storage.getCluster(cluster_id);
        if (!cluster) {
            return { content: [{ type: "text", text: `No cluster found for id ${cluster_id}` }] };
        }
        return { content: [{ type: "text", text: formatClusterDetail(cluster) }] };
    });
    // ── prune: update member status ──────────────────────────────────────────
    server.registerTool("update_prune_member_status", {
        description: "Update review status for a note inside a prune cluster.",
        inputSchema: {
            cluster_id: z.string(),
            note_id: z.string(),
            status: z.enum(["pending", "keep", "merge", "ignore"]),
        },
    }, async ({ cluster_id, note_id, status }) => {
        const storage = getPruneStorage(engine);
        storage.updateMemberStatus(cluster_id, note_id, status);
        const cluster = storage.getCluster(cluster_id);
        return {
            content: [{
                    type: "text",
                    text: cluster ? formatClusterDetail(cluster) : `Updated ${note_id} in ${cluster_id}.`,
                }],
        };
    });
    // ── Scheduler tools (Layer 1 — inspect & control existing jobs) ─────────
    if (scheduler || persistentBackend) {
        registerSchedulerTools(server, scheduler, subagentRunner, persistentBackend, rootDir);
    }
    return server;
}
// ---------------------------------------------------------------------------
// Scheduler MCP tools
// ---------------------------------------------------------------------------
function registerSchedulerTools(server, scheduler, subagentRunner, persistentBackend, rootDir) {
    // ── list_jobs ───────────────────────────────────────────────────────────
    server.registerTool("list_jobs", {
        description: "List all scheduled jobs with their current state, including persistent tasks.",
        inputSchema: {},
    }, async () => {
        const lines = ["# Scheduled Jobs", ""];
        // In-process jobs (built-ins)
        if (scheduler) {
            const states = scheduler.getStates();
            for (const s of states) {
                const lastRun = s.lastRunAt ? new Date(s.lastRunAt).toISOString() : "never";
                const duration = s.lastDurationMs != null ? `${s.lastDurationMs}ms` : "-";
                const error = s.lastError ? ` | error: ${s.lastError}` : "";
                lines.push(`- **${s.name}** | ${s.status} | runs: ${s.runCount} | last: ${lastRun} (${duration})${error}`);
            }
        }
        // Persistent tasks (specs + backend state)
        const root = rootDir ?? resolvePaths().rootDir;
        const specs = listTaskSpecs(root);
        const installed = persistentBackend ? await persistentBackend.list() : [];
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
        if (lines.length === 2) {
            return { content: [{ type: "text", text: "No scheduled jobs registered." }] };
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
    });
    // ── run_job ─────────────────────────────────────────────────────────────
    server.registerTool("run_job", {
        description: "Trigger a scheduled job to run immediately (outside its normal interval).",
        inputSchema: {
            job_name: z.string().describe("Name of the job to run (e.g., 'reindex-md-db', 'task-foo')."),
        },
    }, async ({ job_name }) => {
        try {
            if (scheduler && scheduler.getStates().some((s) => s.name === job_name)) {
                await scheduler.runNow(job_name);
            }
            else if (persistentBackend?.run) {
                await persistentBackend.run(job_name);
            }
            else {
                throw new Error("Job not found.");
            }
            return { content: [{ type: "text", text: `Job "${job_name}" triggered successfully.` }] };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Job "${job_name}" failed: ${msg}` }] };
        }
    });
    // ── set_job_enabled ─────────────────────────────────────────────────────
    server.registerTool("set_job_enabled", {
        description: "Enable or disable a scheduled job. Disabled jobs skip their interval.",
        inputSchema: {
            job_name: z.string().describe("Name of the job."),
            enabled: z.boolean().describe("True to enable, false to disable."),
        },
    }, async ({ job_name, enabled }) => {
        try {
            if (scheduler && scheduler.getStates().some((s) => s.name === job_name)) {
                scheduler.setEnabled(job_name, enabled);
            }
            else if (persistentBackend?.setEnabled) {
                await persistentBackend.setEnabled(job_name, enabled);
            }
            else {
                throw new Error("Job not found.");
            }
            return { content: [{ type: "text", text: `Job "${job_name}" is now ${enabled ? "enabled" : "disabled"}.` }] };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Failed: ${msg}` }] };
        }
    });
    // ── schedule_task (Layer 2 — agent-initiated dynamic scheduling) ───────
    server.registerTool("schedule_task", {
        description: "Register a new recurring task (persistent). Runs a detached subagent on the given interval.",
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
    }, async ({ name, description, prompt, plan, success_criteria, personality, interval_minutes, run_immediately }) => {
        if (!persistentBackend) {
            return { content: [{ type: "text", text: "Persistent scheduling backend not available on this platform." }] };
        }
        const paths = resolvePaths(rootDir);
        const taskName = `task-${name}`;
        const spec = {
            name: taskName,
            description,
            prompt,
            plan,
            successCriteria: success_criteria,
            personality,
            intervalMinutes: interval_minutes,
            rootDir: paths.rootDir,
            createdAt: Date.now(),
            context: prompt,
        };
        const specPath = writeTaskSpec(paths.rootDir, spec);
        const scriptPath = join(paths.rootDir, "dist", "scripts", "run_detached_subagent.js");
        const nodePath = getExecPath();
        try {
            await persistentBackend.install(taskName, interval_minutes * 60_000, nodePath, [scriptPath, specPath]);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Failed to install task: ${msg}` }] };
        }
        const lines = [
            `Scheduled persistent task "${taskName}" — every ${interval_minutes} minute(s).`,
            `Spec: ${specPath}`,
        ];
        if (run_immediately) {
            try {
                if (persistentBackend.run) {
                    await persistentBackend.run(taskName);
                }
                lines.push("First run triggered.");
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                lines.push(`First run failed: ${msg}`);
            }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
    });
    // ── unschedule_task ─────────────────────────────────────────────────────
    server.registerTool("unschedule_task", {
        description: "Disable/remove a persistent task schedule. Keeps the spec file for re-enabling later.",
        inputSchema: {
            name: z.string().describe("Task name (without the 'task-' prefix)."),
        },
    }, async ({ name }) => {
        const taskName = `task-${name}`;
        try {
            if (!persistentBackend) {
                return { content: [{ type: "text", text: "Persistent backend not available." }] };
            }
            await persistentBackend.uninstall(taskName);
            return { content: [{ type: "text", text: `Task "${taskName}" unscheduled (spec retained).` }] };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `No task named "${taskName}" found or uninstall failed: ${msg}` }] };
        }
    });
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getPruneStorage(_engine) {
    const paths = resolvePaths();
    const pruneDbPath = join(paths.rootDir, ".obsidi-claw", "prune.db");
    const db = new Database(pruneDbPath);
    return new PruneClusterStorage(db);
}
function formatClusterListMarkdown(clusters) {
    if (clusters.length === 0)
        return "No prune clusters available.";
    const lines = ["# Prune Clusters", ""];
    for (const c of clusters) {
        lines.push(`- ${c.clusterId} | size ${c.stats.size} | rep ${c.representativeNoteId} | avg ${c.stats.avgSimilarity.toFixed(3)}`);
    }
    return lines.join("\n");
}
function formatClusterDetail(cluster) {
    const lines = [
        `# Cluster ${cluster.clusterId}`,
        `Representative: ${cluster.representativeNoteId}`,
        `Size: ${cluster.stats.size} | max ${cluster.stats.maxSimilarity.toFixed(3)} | min ${cluster.stats.minSimilarity.toFixed(3)} | avg ${cluster.stats.avgSimilarity.toFixed(3)}`,
        "",
        "## Members",
    ];
    for (const m of cluster.members) {
        lines.push(`- ${m.noteId} | sim ${m.similarity.toFixed(3)} | ${m.isRepresentative ? "REP" : "member"} | status: ${m.status}`);
    }
    return lines.join("\n");
}
//# sourceMappingURL=mcp-server.js.map