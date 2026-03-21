/**
 * ObsidiClaw MCP server — wraps ContextEngine behind the Model Context Protocol.
 *
 * Exposes two tools:
 *   retrieve_context  — hybrid RAG query; fires onContextBuilt callback with full
 *                       ContextPackage so the orchestrator can log metrics via events.
 *   get_preferences   — returns preferences.md content for system-prompt injection.
 *
 * The server is transport-agnostic. Callers wire it to an InMemoryTransport (same-process)
 * or a StdioServerTransport (subprocess) by calling server.connect(transport).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ContextEngine } from "../context-engine.js";
import type { ContextPackage, SubagentPackage, PruneMemberStatus } from "../types.js";
import { PruneClusterStorage } from "../prune/prune-storage.js";

export type OnContextBuilt = (pkg: ContextPackage) => void;
export type OnSubagentPrepared = (pkg: SubagentPackage) => void;

export function createContextEngineMcpServer(
  engine: ContextEngine,
  onContextBuilt?: OnContextBuilt,
  onSubagentPrepared?: OnSubagentPrepared,
): McpServer {
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

  return server;
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


