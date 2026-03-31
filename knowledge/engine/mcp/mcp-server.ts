/**
 * ObsidiClaw MCP server — wraps ContextEngine behind MCP.
 *
 * Context tools:
 *   retrieve_context     — hybrid RAG query
 *   get_preferences      — returns preferences.md content
 *   find_path            — graph path between two concepts
 *   build/list/get/update_prune_* — note deduplication management
 *
 * Transport-agnostic: wire via InMemoryTransport or StdioServerTransport.
 * Scheduler tools live in .pi/extensions/scheduler.ts — not here.
 */

import fs from "fs";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ContextEngine } from "../context-engine.js";
import type { ContextPackage, PruneMemberStatus } from "../types.js";
import type { PruneClusterStorage } from "../prune/prune-storage.js";
import type { WorkspaceRegistry } from "../../../automation/workspaces/workspace-registry.js";
import { RATE_CONTEXT_REMINDER } from "../../../agents/prompts.js";
import { processInboxNote } from "./process-inbox-note.js";

export type OnContextBuilt = (pkg: ContextPackage) => void;
export type OnContextRated = (rating: { query: string; score: number; missing: string; helpful: string }) => void;

export interface McpServerOptions {
  engine: ContextEngine;
  onContextBuilt?: OnContextBuilt;
  onContextRated?: OnContextRated;
  /** Shared prune cluster storage (from notes.db). Falls back to engine.buildPruneClusters() for build. */
  pruneStorage?: PruneClusterStorage;
  /** Workspace registry for register/list/unregister workspace tools. */
  workspaceRegistry?: WorkspaceRegistry;
  /** Called when a fire-and-forget background operation fails (e.g. incremental reindex). Routes to runs.db. */
  onBackgroundError?: (context: string, err: unknown) => void;
  /** Absolute path to md_db root — required for create_concept_note. */
  mdDbPath?: string;
  /**
   * Map of know workspace name → vault source dir.
   * Required for process_inbox_note / list_inbox_notes tools.
   */
  knowVaults?: Map<string, string>;
}

export function createContextEngineMcpServer(opts: McpServerOptions): McpServer {
  return _createMcpServer(opts);
}

function _createMcpServer(opts: McpServerOptions): McpServer {
  const { engine, onContextBuilt, onContextRated, pruneStorage, workspaceRegistry, onBackgroundError, mdDbPath, knowVaults } = opts;
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
        "Call this before relying on your own knowledge for any project-specific question.",
      inputSchema: {
        query: z.string().describe("What to search for in the knowledge base."),
        workspace: z.string().optional().describe("Limit retrieval to a specific registered workspace by name. Omit to search all workspaces."),
      },
    },
    async ({ query, workspace }) => {
      const pkg = await engine.build(query, workspace);
      onContextBuilt?.(pkg);
      const budget = DEFAULT_MAX_CHARS;
      let text = pkg.formattedContext.length <= budget
        ? pkg.formattedContext
        : pkg.formattedContext.slice(0, budget) + "\n\n_(context truncated to fit budget)_\n<!-- End ObsidiClaw Context -->";
      text += "\n\n" + RATE_CONTEXT_REMINDER;
      return { content: [{ type: "text" as const, text }] };
    },
  );

  // ── find_path ───────────────────────────────────────────────────────────

  server.registerTool(
    "find_path",
    {
      description:
        "Find the shortest path between two concepts in the knowledge graph. " +
        "Use this when you need to understand how two parts of the codebase relate — " +
        "e.g. how the logger connects to context retrieval. Endpoints can be note " +
        "paths (e.g. 'code/obsidi-claw/logger/run-logger.ts.md') or natural language " +
        "(e.g. 'logger subsystem'). Returns the chain of notes and edge types connecting them.",
      inputSchema: {
        start: z.string().describe("Starting concept, note path, or search query."),
        end: z.string().describe("Ending concept, note path, or search query."),
        edge_types: z.array(z.string()).optional().describe(
          "Edge types to traverse. Default: all. Options: CALLS, DEFINED_IN, BELONGS_TO, CONTAINS, CONTAINS_SYMBOL, IMPORTS, LINKS_TO"
        ),
        max_depth: z.number().optional().describe("Maximum path length in hops (default: 8)."),
      },
    },
    async ({ start, end, edge_types, max_depth }) => {
      const result = await engine.findPath(start, end, {
        edgeTypes: edge_types,
        maxDepth: max_depth,
      });
      if (result.noPath) {
        const parts = [`No path found between "${start}" and "${end}" in the knowledge graph.`];
        if (result.startId) parts.push(`Start resolved to: ${result.startId} (${result.startResolvedBy})`);
        else parts.push(`Could not resolve start: "${start}"`);
        if (result.endId) parts.push(`End resolved to: ${result.endId} (${result.endResolvedBy})`);
        else parts.push(`Could not resolve end: "${end}"`);
        return { content: [{ type: "text" as const, text: parts.join("\n") }] };
      }
      let text = result.formattedContext;
      if (text.length > DEFAULT_MAX_CHARS) {
        text = text.slice(0, DEFAULT_MAX_CHARS) + "\n\n_(path context truncated)_\n<!-- End ObsidiClaw Path Context -->";
      }
      // Prepend resolution info so the agent can verify endpoint matching
      const header = `_Start: "${start}" → ${result.startId} (${result.startResolvedBy}) | End: "${end}" → ${result.endId} (${result.endResolvedBy})_\n\n`;
      text = header + text;
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
        // Returns immediately; Python background thread does the actual work.
        if (notePaths.length > 0) {
          engine.incrementalUpdate(notePaths).catch((err) => {
            onBackgroundError?.("incremental update after register_workspace", err);
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

  // ── create_concept_note ───────────────────────────────────────────────────

  server.registerTool(
    "create_concept_note",
    {
      description:
        "Write a new concept note to md_db. Use this after investigating the codebase to answer " +
        "a question that retrieve_context could not answer — capturing what you learned makes it " +
        "available to all future retrieve_context queries for this workspace. " +
        "The note is picked up by the reindex watcher within seconds.",
      inputSchema: {
        title: z.string().describe("Human-readable title (becomes the filename slug)."),
        body: z.string().describe("Markdown body of the note. Do not include frontmatter — it is generated automatically."),
        workspace: z.string().describe("Workspace name this note belongs to (e.g. 'obsidi-claw'). Must match a registered workspace."),
        tags: z.array(z.string()).optional().describe("Additional tags to apply. The workspace name is always added automatically."),
      },
    },
    async ({ title, body, workspace, tags }) => {
      if (!mdDbPath) {
        return { content: [{ type: "text" as const, text: "create_concept_note: mdDbPath not configured on server." }] };
      }

      // Validate workspace exists
      if (workspaceRegistry) {
        const workspaces = workspaceRegistry.list();
        if (!workspaces.find((w) => w.name === workspace)) {
          const names = workspaces.map((w) => w.name).join(", ") || "none";
          return { content: [{ type: "text" as const, text: `Workspace "${workspace}" not found. Registered: ${names}` }] };
        }
      }

      // Slug: lowercase, replace spaces+special chars with hyphens, collapse repeats
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

      const noteDir = path.join(mdDbPath, "concepts", workspace);
      const notePath = path.join(noteDir, `${slug}.md`);
      const noteId = `concepts/${workspace}/${slug}`;

      // Don't overwrite existing notes silently
      if (fs.existsSync(notePath)) {
        return { content: [{ type: "text" as const, text: `Note already exists: ${noteId}\nTo update it, edit the file directly.` }] };
      }

      const allTags = [workspace, ...(tags ?? [])];
      const created = new Date().toISOString();
      const frontmatter = [
        "---",
        `type: concept`,
        `title: ${title}`,
        `workspace: ${workspace}`,
        `source: agent`,
        `created: ${created}`,
        `tags:`,
        ...allTags.map((t) => `  - ${t}`),
        "---",
        "",
      ].join("\n");

      fs.mkdirSync(noteDir, { recursive: true });
      fs.writeFileSync(notePath, frontmatter + body.trimStart(), "utf8");

      return {
        content: [{
          type: "text" as const,
          text: `Concept note created: ${noteId}\nPath: ${notePath}\nThe reindex watcher will pick this up within ~2 seconds.`,
        }],
      };
    },
  );

  // ── list_inbox_notes ────────────────────────────────────────────────────────

  server.registerTool(
    "list_inbox_notes",
    {
      description:
        "List pending .md files in the inbox for a know workspace. " +
        "Call at session start to find notes awaiting pipeline processing.",
      inputSchema: {
        workspace: z.string().describe("Name of a registered know workspace."),
      },
    },
    async ({ workspace }) => {
      const vaultDir = knowVaults?.get(workspace);
      if (!vaultDir) {
        return {
          content: [{
            type: "text" as const,
            text: `No know workspace named "${workspace}" found. Use list_workspaces to see registered workspaces.`,
          }],
        };
      }

      const inboxDir = path.join(vaultDir, "notes", "inbox");
      let files: string[];
      try {
        files = fs.readdirSync(inboxDir).filter((f) => f.endsWith(".md"));
      } catch {
        return { content: [{ type: "text" as const, text: `Inbox directory not found: ${inboxDir}` }] };
      }

      if (files.length === 0) {
        return { content: [{ type: "text" as const, text: "Inbox is empty." }] };
      }

      return {
        content: [{
          type: "text" as const,
          text: `${files.length} note(s) pending in inbox:\n` + files.map((f) => `- ${f}`).join("\n"),
        }],
      };
    },
  );

  // ── process_inbox_note ───────────────────────────────────────────────────────

  server.registerTool(
    "process_inbox_note",
    {
      description:
        "Run the inbox pipeline on a single note: resolve #TODOs, suggest tags, check atomicity, promote to notes/permanent or notes/synthesized. " +
        "Call after list_inbox_notes or when the inbox watcher fires.",
      inputSchema: {
        workspace: z.string().describe("Name of the know workspace the note belongs to."),
        filename: z.string().describe("Filename only (e.g. attention-transformers.md), not a full path."),
      },
    },
    async ({ workspace, filename }) => {
      const vaultDir = knowVaults?.get(workspace);
      if (!vaultDir) {
        return {
          content: [{
            type: "text" as const,
            text: `No know workspace named "${workspace}" found.`,
          }],
        };
      }

      const filePath = path.join(vaultDir, "notes", "inbox", filename);
      if (!fs.existsSync(filePath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${filePath}` }],
        };
      }

      const result = await processInboxNote({
        vaultDir,
        filePath,
        workspace,
        retrieveContext: async (query, ws) => {
          try {
            const pkg = await engine.build(query, ws);
            return pkg.formattedContext;
          } catch {
            return "## Nothing Found\n\nContext engine unavailable.";
          }
        },
      });

      const stepLines = result.steps.map(
        (s) => `**${s.step}** [${s.status}]: ${s.detail}`,
      );

      const summary = result.promoted
        ? `✓ Promoted to: ${result.destination}`
        : `✗ Not promoted — review the note and re-run process_inbox_note.`;

      return {
        content: [{
          type: "text" as const,
          text: [summary, "", ...stepLines].join("\n"),
        }],
      };
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


