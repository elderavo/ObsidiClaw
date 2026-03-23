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
import { join } from "path";
import Database from "better-sqlite3";
import type { ContextEngine } from "../context-engine.js";
import type { ContextPackage, SubagentPackage, PruneMemberStatus } from "../types.js";
import { PruneClusterStorage } from "../prune/prune-storage.js";
import { resolvePaths } from "../../../core/config.js";
import { RATE_CONTEXT_REMINDER } from "../../../agents/prompts.js";

export type OnContextBuilt = (pkg: ContextPackage) => void;
export type OnSubagentPrepared = (pkg: SubagentPackage) => void;
export type OnContextRated = (rating: { query: string; score: number; missing: string; helpful: string }) => void;

export interface McpServerOptions {
  engine: ContextEngine;
  onContextBuilt?: OnContextBuilt;
  onSubagentPrepared?: OnSubagentPrepared;
  onContextRated?: OnContextRated;
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
  const { engine, onContextBuilt, onSubagentPrepared, onContextRated } = opts;
  const server = new McpServer({ name: "obsidi-claw-context", version: "1.0.0" });

  // ── retrieve_context ──────────────────────────────────────────────────────

  // Default budget: ~750 tokens. Keeps total prompt well under 4k context models.
  const DEFAULT_MAX_CHARS = 3000;

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
        max_chars: z.number().optional().describe("Maximum characters to return (default: 3000). Use a smaller value for tighter context."),
      },
    },
    async ({ query, max_chars }) => {
      const pkg = await engine.build(query);
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

  return server;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPruneStorage(_engine: ContextEngine): PruneClusterStorage {
  const paths = resolvePaths();
  const pruneDbPath = join(paths.rootDir, ".obsidi-claw", "prune.db");
  const db = new Database(pruneDbPath);
  return new PruneClusterStorage(db);
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


