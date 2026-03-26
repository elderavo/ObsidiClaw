/**
 * ObsidiClaw MCP server — wraps ContextEngine behind MCP.
 *
 * Context tools:
 *   retrieve_context     — hybrid RAG query
 *   get_preferences      — returns preferences.md content
 *   prepare_subagent     — build context-enriched system prompt for subagents
 *   build/list/get/update_prune_* — note deduplication management
 *
 * Transport-agnostic: wire via InMemoryTransport or StdioServerTransport.
 * Scheduler tools live in .pi/extensions/scheduler.ts — not here.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ContextEngine } from "../context-engine.js";
import type { ContextPackage, SubagentPackage, PruneMemberStatus } from "../types.js";
import type { PruneClusterStorage } from "../prune/prune-storage.js";
import type { WorkspaceRegistry } from "../../../automation/workspaces/workspace-registry.js";
import { RATE_CONTEXT_REMINDER } from "../../../agents/prompts.js";

export type OnContextBuilt = (pkg: ContextPackage) => void;
export type OnSubagentPrepared = (pkg: SubagentPackage) => void;
export type OnContextRated = (rating: { query: string; score: number; missing: string; helpful: string }) => void;

export interface McpServerOptions {
  engine: ContextEngine;
  onContextBuilt?: OnContextBuilt;
  onSubagentPrepared?: OnSubagentPrepared;
  onContextRated?: OnContextRated;
  /** Shared prune cluster storage (from notes.db). Falls back to engine.buildPruneClusters() for build. */
  pruneStorage?: PruneClusterStorage;
  /** Workspace registry for register/list/unregister workspace tools. */
  workspaceRegistry?: WorkspaceRegistry;
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
  const { engine, onContextBuilt, onSubagentPrepared, onContextRated, pruneStorage, workspaceRegistry } = opts;
  const server = new McpServer({ name: "obsidi-claw-context", version: "1.0.0" });

  // ── retrieve_context ──────────────────────────────────────────────────────

  // Default budget: ~2500 tokens. Generous enough for multi-tier symbol + call context.
  const DEFAULT_MAX_CHARS = 10000;

  server.registerTool(
    "retrieve_context",
    {
      description:
        "Search the ObsidiClaw knowledge base for relevant notes, tools, concepts, and best " +
        "practices. Returns markdown-formatted context from the md_db knowledge graph. " +
        "Call this before relying on your own knowledge for any project-specific question. " +
        "For detailed tool usage examples, search for the tool name (e.g. 'spawn_subagent').",
      inputSchema: {
        query: z.string().describe("What to search for in the knowledge base."),
        max_chars: z.number().optional().describe("Maximum characters to return (default: 10000). Use a smaller value for tighter context."),
        workspace: z.string().optional().describe("Limit retrieval to a specific registered workspace by name. Omit to search all workspaces."),
      },
    },
    async ({ query, max_chars, workspace }) => {
      const pkg = await engine.build(query, workspace);
      onContextBuilt?.(pkg);
      const budget = max_chars ?? DEFAULT_MAX_CHARS;
      let text = pkg.formattedContext.length <= budget
        ? pkg.formattedContext
        : pkg.formattedContext.slice(0, budget) + "\n\n_(context truncated to fit budget)_\n<!-- End ObsidiClaw Context -->";
      text += "\n\n" + RATE_CONTEXT_REMINDER;
      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── rate_context ─────────────────────────────────────────────────────────

  server.registerTool(
    "rate_context",
    {
      description:
        "Rate how well the last retrieve_context result answered your query. " +
        "Call this AFTER you've used the retrieved context to answer or act. " +
        "Your rating helps the knowledge base improve over time.",
      inputSchema: {
        query: z.string().describe("The original query you searched for."),
        score: z
          .number()
          .int()
          .min(1)
          .max(5)
          .describe(
            "1 = completely irrelevant, 2 = mostly unhelpful, 3 = partially useful, " +
            "4 = good coverage, 5 = exactly what was needed."
          ),
        missing: z
          .string()
          .describe("What information was missing or would have been more useful? Empty string if nothing."),
        helpful: z
          .string()
          .describe("Which notes or sections were most useful? Empty string if none."),
      },
    },
    async ({ query, score, missing, helpful }) => {
      onContextRated?.({ query, score, missing, helpful });
      return {
        content: [{
          type: "text" as const,
          text: `Rating recorded: ${score}/5. Thank you — this helps the knowledge base improve.`,
        }],
      };
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
        personality: z.string().optional().describe("Personality profile name (e.g., 'deep-researcher', 'code-reviewer', 'context-synthesizer')."),
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
      }, pruneStorage);
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
      if (!pruneStorage) return { content: [{ type: "text" as const, text: "Prune storage not available." }] };
      const storage = pruneStorage;
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
      if (!pruneStorage) return { content: [{ type: "text" as const, text: "Prune storage not available." }] };
      const storage = pruneStorage;
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
      if (!pruneStorage) return { content: [{ type: "text" as const, text: "Prune storage not available." }] };
      const storage = pruneStorage;
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

  // ── Workspace tools ────────────────────────────────────────────────────

  server.registerTool(
    "register_workspace",
    {
      description:
        "Register a source directory as a workspace for code mirroring. " +
        "Runs an initial mirror pass and starts a file watcher for continuous updates. " +
        "Mirrored notes become available via retrieve_context.",
      inputSchema: {
        name: z.string().describe("Unique slug (lowercase alphanumeric + hyphens, 2-64 chars). Used as folder name in md_db."),
        source_dir: z.string().describe("Absolute path to the source directory to mirror."),
        mode: z.enum(["code", "know"]).default("code").describe("'code' = mirror pipeline; 'know' = conversational knowledge (future)."),
        languages: z.array(z.enum(["ts", "py"])).default(["ts"]).describe("Which languages to mirror. Default: TypeScript only."),
      },
    },
    async ({ name, source_dir, mode, languages }) => {
      if (!workspaceRegistry) {
        return { content: [{ type: "text" as const, text: "Workspace registry not available." }] };
      }
      try {
        const { entry, notesGenerated, notePaths } = await workspaceRegistry.register({
          name,
          sourceDir: source_dir,
          mode: mode as "code" | "know",
          languages: languages as ("ts" | "py")[],
          active: true,
        });

        // Fire-and-forget incremental update — index only the new notes.
        // Does NOT block the MCP response; Pi stays responsive immediately.
        // Retrieval queries during indexing queue behind it on the Python pipe.
        if (notePaths.length > 0) {
          engine.incrementalUpdate(notePaths).catch((err) => {
            console.warn("[mcp] background incremental update failed:", err);
          });
        }

        return {
          content: [{
            type: "text" as const,
            text: `Workspace "${entry.name}" registered.\n` +
              `Source: ${entry.sourceDir}\n` +
              `Mode: ${entry.mode}\n` +
              `Languages: ${entry.languages.join(", ")}\n` +
              `Notes generated: ${notesGenerated}\n` +
              `Indexing: running in background\n` +
              `Watcher: active`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed to register workspace: ${err}` }] };
      }
    },
  );

  server.registerTool(
    "list_workspaces",
    {
      description: "List all registered workspaces and their status.",
      inputSchema: {},
    },
    async () => {
      if (!workspaceRegistry) {
        return { content: [{ type: "text" as const, text: "Workspace registry not available." }] };
      }
      const entries = workspaceRegistry.list();
      if (entries.length === 0) {
        return { content: [{ type: "text" as const, text: "No workspaces registered." }] };
      }
      const lines = [
        "| Name | Mode | Languages | Source | Active | Registered |",
        "|------|------|-----------|--------|--------|------------|",
        ...entries.map((e) =>
          `| ${e.name} | ${e.mode} | ${e.languages.join(", ")} | ${e.sourceDir} | ${e.active ? "yes" : "no"} | ${e.registeredAt.slice(0, 10)} |`,
        ),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "unregister_workspace",
    {
      description:
        "Unregister a workspace: stops watcher, optionally deletes mirrored notes, and removes from registry.",
      inputSchema: {
        name: z.string().describe("Workspace name to remove."),
        delete_notes: z.boolean().default(true).describe("Delete mirrored notes from md_db (default: true)."),
      },
    },
    async ({ name, delete_notes }) => {
      if (!workspaceRegistry) {
        return { content: [{ type: "text" as const, text: "Workspace registry not available." }] };
      }
      try {
        const { removed, deletedPaths } = await workspaceRegistry.unregister(name, { deleteNotes: delete_notes });
        if (!removed) {
          return { content: [{ type: "text" as const, text: `Workspace "${name}" not found.` }] };
        }

        // Trigger incremental update with deleted paths
        if (deletedPaths.length > 0) {
          try {
            await engine.incrementalUpdate([], deletedPaths);
          } catch {
            // Non-fatal
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: `Workspace "${name}" unregistered.\n` +
              `Notes deleted: ${deletedPaths.length}\n` +
              `Watcher: stopped`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed to unregister workspace: ${err}` }] };
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


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


