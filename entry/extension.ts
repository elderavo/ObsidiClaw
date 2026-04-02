/**
 * ObsidiClaw ExtensionFactory — Pi TUI entry point.
 *
 * Spawns a child process (mcp-process.ts) that owns the full stack (ContextEngine,
 * Python subprocess, WorkspaceRegistry). The TUI communicates with it over
 * StdioClientTransport — the standard MCP SDK child-process pattern.
 *
 * This process owns:
 *   - RunLogger for TUI-side events (prompt, agent, tool lifecycle)
 *   - Pi SDK hooks (session_start, before_agent_start, agent_start, etc.)
 *   - Tool registrations (call through to MCP client)
 *   - Session review job spawning
 *
 * The child process owns:
 *   - ContextEngine + Python subprocess
 *   - WorkspaceRegistry + file watchers
 *   - MCP server (tool implementations)
 *   - RunLogger for CE events (context_retrieved, ce_*, diagnostic)
 */

import "dotenv/config";
import { randomUUID } from "crypto";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type ExtensionFactory, type ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { resolvePaths, getEmbedConfig } from "../core/config.js";
import { extractMcpText } from "../core/text-utils.js";
import { ensureDir, writeText, readText, listDir, fileExists } from "../core/os/fs.js";
import { spawnProcess, getExecPath } from "../core/os/process.js";
import { RunLogger } from "../logger/run-logger.js";
import { mapPiEventToRunEvent } from "../agents/pi-event-mapper.js";
import { buildDirectoryTree, stripDirectoryBlock } from "../automation/scripts/update-directory-tree.js";
import { TOOL_REMINDER, ENGINE_UNAVAILABLE_WARNING } from "../agents/prompts.js";
import { buildNoteContent, buildNoteFilename, VAULT_NOTE_TYPES, NOTE_TYPE_DESCRIPTIONS, type VaultNoteType } from "../knowledge/markdown/vault-schema.js";
import type { RunEvent } from "../logger/types.js";
import type { ToolContext } from "./tools/types.js";
import { registerRetrieveContextTool } from "./tools/retrieve-context.js";
import { registerRateContextTool } from "./tools/rate-context.js";
import { registerWorkspaceTools } from "./tools/workspace.js";
import { registerFindPathTool } from "./tools/find-path.js";
import { registerCaptureNoteTool } from "./tools/capture-note.js";


// ---------------------------------------------------------------------------
// Active workspace persistence
// ---------------------------------------------------------------------------

const ACTIVE_WS_FILE = ".obsidi-claw/active-workspace.json";

function saveActiveWorkspace(rootDir: string, name: string | undefined): void {
  try {
    writeText(join(rootDir, ACTIVE_WS_FILE), JSON.stringify({ workspace: name ?? null }));
  } catch { /* non-fatal */ }
}

function loadActiveWorkspace(rootDir: string): string | undefined {
  try {
    const raw = readText(join(rootDir, ACTIVE_WS_FILE));
    const parsed = JSON.parse(raw) as { workspace?: string | null };
    return parsed.workspace ?? undefined;
  } catch { return undefined; }
}

const WORKSPACE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

function validateWorkspaceName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 64) {
    return "Workspace name must be 2-64 characters long.";
  }
  if (!WORKSPACE_NAME_RE.test(trimmed)) {
    return "Workspace name must be lowercase alphanumeric with optional hyphens (no leading or trailing hyphen).";
  }
  return null;
}

// ---------------------------------------------------------------------------
// TUI helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape sequences to measure visible string length. */
function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

interface ReadyParams {
  engineState: "ok" | "degraded" | "unavailable";
  degradedReason: string | null;
  noteCount: number;
  edgeCount: number;
  indexLoaded: boolean;
  activeWorkspaces: { name: string; mode: string; languages: string[]; sourceDir: string }[];
}

async function showStartupSplash(
  ui: ExtensionUIContext,
  params: ReadyParams,
): Promise<void> {
  await ui.custom(
    (_tui, theme, _keybindings, done) => {
      const W = 52;

      const engineStatus = params.engineState === "ok"
        ? theme.fg("success", "● OK")
        : params.engineState === "degraded"
          ? theme.fg("warning", "● degraded (keyword-only)")
          : theme.fg("error", "● unavailable");

      const wsLines =
        params.activeWorkspaces.length === 0
          ? ["  none registered"]
          : params.activeWorkspaces.map((w) => `  ${w.name}  (${w.mode}, ${w.languages.join("+")})`);

      const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - visibleLen(s)));
      const border = theme.fg("border", "│");
      const line = (content: string) => `${border} ${pad(content, W)} ${border}`;
      const divider = theme.fg("border", "├" + "─".repeat(W + 2) + "┤");

      const rows = [
        theme.fg("border", "╭" + "─".repeat(W + 2) + "╮"),
        line(""),
        line(theme.bold(theme.fg("accent", "  ObsidiClaw")) + theme.fg("muted", "  memory system")),
        line(""),
        divider,
        line(""),
        line(`  Engine      ${engineStatus}`),
        line(
          `  Graph       ${theme.fg("text", String(params.noteCount))} notes` +
          `  ·  ${theme.fg("text", String(params.edgeCount))} edges`,
        ),
        line(""),
        divider,
        line(""),
        ...wsLines.map((l) => line(theme.fg("muted", "  Workspace  ") + l)),
        line(""),
        divider,
        line(""),
        line(theme.fg("dim", "  any key to dismiss · auto-closes in 4s")),
        line(""),
        theme.fg("border", "╰" + "─".repeat(W + 2) + "╯"),
      ];

      const text = new Text(rows.join("\n"), 0, 0);
      let timer: ReturnType<typeof setTimeout> | undefined;
      timer = setTimeout(() => done(undefined), 4000);

      return Object.assign(text, {
        handleInput: (_data: string) => {
          clearTimeout(timer);
          done(undefined);
        },
        dispose: () => clearTimeout(timer),
      });
    },
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: 58, margin: 1 },
    },
  );
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ObsidiClawExtensionConfig {
  /**
   * Path to the md_db directory. Defaults to resolvePaths().mdDbPath.
   */
  mdDbPath?: string;

  /**
   * Project root directory. Used to resolve paths for review worker scripts, etc.
   * Defaults to resolvePaths().rootDir (which falls back to process.cwd()).
   */
  rootDir?: string;
}

// ---------------------------------------------------------------------------
// Workspace context builder
// ---------------------------------------------------------------------------

/**
 * Builds the workspace-specific context block injected when a workspace is
 * first loaded or changes.
 *
 * - code mode: full directory tree of sourceDir
 * - know mode: file listing of permanent/ + inbox/ subdirs
 */
function buildWorkspaceContext(
  entry: { name: string; mode: string; sourceDir: string },
  mdDbPath: string,
): string {
  if (entry.mode === "code") {
    const treeContent = buildDirectoryTree(entry.sourceDir);
    return [
      `<!-- ObsidiClaw: Project Structure -->`,
      ``,
      `## Project directory structure`,
      ``,
      treeContent,
      ``,
      `<!-- End ObsidiClaw Project Structure -->`,
    ].join("\n");
  }

  // know mode — list permanent + inbox notes
  const sections: string[] = [];
  for (const subdir of ["permanent", "inbox"] as const) {
    const dir = join(mdDbPath, "know", entry.name, subdir);
    let files: string[] = [];
    try {
      files = listDir(dir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      // subdir may not exist yet
    }
    if (files.length > 0) {
      sections.push(`### ${subdir}/`);
      sections.push(...files.map((f) => `- ${f}`));
    }
  }

  if (sections.length === 0) return "";

  return [
    `<!-- ObsidiClaw: Workspace Notes -->`,
    ``,
    `## Workspace notes — ${entry.name}`,
    ``,
    ...sections,
    ``,
    `<!-- End ObsidiClaw Workspace Notes -->`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Concepts index builder
// ---------------------------------------------------------------------------

/**
 * Scans md_db/concepts/ and returns a compact block listing each concept note
 * by filename + H1 title + workspace scope. Injected when a workspace is loaded
 * so Pi always knows which design principles exist and can retrieve the full note on demand.
 */
function buildConceptsIndex(conceptsDir: string, activeWorkspace?: string): string {
  if (!fileExists(conceptsDir)) return "";

  let entries: string[];
  try {
    entries = listDir(conceptsDir).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return "";
  }

  const lines: string[] = [];
  for (const name of entries) {
    const fullPath = join(conceptsDir, name);
    let title = name.replace(/\.md$/, "").replace(/_/g, " ");
    let workspace: string | undefined;
    try {
      const content = readText(fullPath);
      const h1 = content.match(/^#\s+(.+)$/m);
      if (h1) title = h1[1]!.trim();
      const wsMatch = content.match(/^---[\s\S]*?^workspace:\s*(.+)$/m);
      if (wsMatch) workspace = wsMatch[1]!.trim();
    } catch {
      // fall back to filename stem, no workspace
    }

    if (workspace && workspace !== activeWorkspace) continue;

    const scopeLabel = workspace ? ` *(${workspace})*` : "";
    lines.push(`- **${name}** — ${title}${scopeLabel}`);
  }

  if (lines.length === 0) return "";

  return [
    "<!-- ObsidiClaw: Design Principles -->",
    "",
    "## Design Principles on file",
    "",
    "The following concept notes are in `md_db/concepts/`. When one seems relevant to",
    "the current work — or when a proposal might violate one — retrieve the full note",
    "with `retrieve_context` before proceeding.",
    "",
    ...lines,
    "",
    "<!-- End ObsidiClaw Design Principles -->",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createObsidiClawExtension(
  config: ObsidiClawExtensionConfig = {},
): ExtensionFactory {
  return async (pi) => {
    const paths = resolvePaths(config.rootDir);
    const mdDbPath = config.mdDbPath ?? paths.mdDbPath;
    const sessionId = randomUUID();

    // TUI-side RunLogger — logs Pi event lifecycle only.
    // The MCP child process has its own RunLogger for CE events.
    // Both write to the same runs.db via WAL mode.
    const logger = new RunLogger({ dbPath: paths.dbPath });

    // UI handle — full ExtensionUIContext (used for status updates + note capture modal)
    let latestCtxUI: ExtensionUIContext | undefined;

    // Active workspace for concept filtering and UI defaults. Set by /workspace command.
    let activeWorkspace: string | undefined;

    // Engine state — populated when child process sends obsidi-claw/ready
    let engineState: "ok" | "degraded" | "unavailable" = "ok";

    // Ready params — populated by child process notification
    let readyParams: ReadyParams | undefined;
    let readyResolve: ((params: ReadyParams) => void) | undefined;
    const readyPromise = new Promise<ReadyParams>((resolve) => { readyResolve = resolve; });

    // Track latest transcript (updated on agent_end) for review hook
    let latestMessages: unknown[] = [];

    // Context injection state — preferences injected once per session;
    // workspace context injected once per workspace load/change.
    let prefsInjected = false;
    let lastInjectedWorkspace: string | undefined = undefined;

    // MCP client — talks to child process over stdio
    let client: Client;
    let transport: StdioClientTransport;

    // Shared mutable state for tool registrations.
    const toolCtx: ToolContext = { client: null as unknown as Client, engineState: "ok" };

    /** Persist + apply a workspace selection. Pass undefined to clear. */
    function setActiveWorkspace(name: string | undefined, ui?: ExtensionUIContext): void {
      activeWorkspace = name;
      toolCtx.activeWorkspace = name;
      saveActiveWorkspace(paths.rootDir, name);
      ui?.setStatus("workspace", name);
    }

    /**
     * Fire-and-forget inbox sweep for a know workspace.
     * Calls list_inbox_notes then process_inbox_note for each pending file.
     */
    async function sweepInboxForWorkspace(workspace: string, ui: ExtensionUIContext): Promise<void> {
      try {
        const listResult = await client.callTool({ name: "list_inbox_notes", arguments: { workspace } });
        const listText = extractMcpText(listResult as { content: { type: string; text: string }[] });
        if (!listText || listText === "Inbox is empty.") return;

        const filenames = [...listText.matchAll(/^- (.+\.md)$/gm)].map((m) => m[1]!);
        if (filenames.length === 0) return;

        ui.notify(`Sweeping ${filenames.length} inbox note(s) for "${workspace}"…`, "info");
        for (const filename of filenames) {
          await client.callTool({ name: "process_inbox_note", arguments: { workspace, filename } });
        }
        ui.notify(`Inbox sweep complete for "${workspace}"`, "info");
      } catch {
        // Non-fatal — engine may not be ready yet
      }
    }

    // ── session_start: spawn MCP child process ──────────────────────────────
    pi.on("session_start", async (_event, ctx) => {
      latestCtxUI = ctx.hasUI ? ctx.ui : undefined;

      ensureDir(join(paths.rootDir, ".obsidi-claw"));

      // One-time migration: strip directory tree block from preferences.md if present.
      try { stripDirectoryBlock(join(mdDbPath, "preferences.md")); } catch { /* ignore */ }

      // Resolve the compiled mcp-process.js path
      const mcpProcessScript = join(paths.rootDir, "dist", "entry", "mcp-process.js");

      transport = new StdioClientTransport({
        command: getExecPath(),
        args: [mcpProcessScript],
        env: {
          ...process.env as Record<string, string>,
          OBSIDI_SESSION_ID: sessionId,
          OBSIDI_ROOT_DIR: paths.rootDir,
        },
        stderr: "pipe",
        cwd: paths.rootDir,
      });

      // Pipe child stderr to TUI logger (line-buffered)
      const childStderr = transport.stderr;
      if (childStderr && "on" in childStderr) {
        let stderrBuf = "";
        (childStderr as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
          stderrBuf += chunk.toString();
          const lines = stderrBuf.split("\n");
          stderrBuf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) {
              logger.logEvent({
                type: "ce_subprocess_log",
                sessionId,
                timestamp: Date.now(),
                message: line,
              } as RunEvent);
            }
          }
        });
      }

      client = new Client({ name: "obsidi-claw-ext", version: "1.0.0" });
      toolCtx.client = client;

      // Listen for custom notifications from child process
      client.fallbackNotificationHandler = async (notification: { method: string; params?: Record<string, unknown> }) => {
        if (notification.method === "obsidi-claw/ready") {
          const params = notification.params as unknown as ReadyParams;
          readyParams = params;
          engineState = params.engineState;
          toolCtx.engineState = params.engineState;

          if (params.engineState === "degraded" && ctx.hasUI) {
            const reason = params.degradedReason || "embedding provider unavailable";
            ctx.ui.notify(
              `Context engine running in keyword-only mode: ${reason}`,
              "warning",
            );
          } else if (params.engineState === "unavailable" && ctx.hasUI) {
            const reason = params.degradedReason || "initialization failed";
            ctx.ui.notify(
              `Context engine unavailable: ${reason}`,
              "warning",
            );
          }

          // Restore persisted workspace selection (verify it still exists)
          const persisted = loadActiveWorkspace(paths.rootDir);
          if (persisted && params.activeWorkspaces.some((w) => w.name === persisted)) {
            setActiveWorkspace(persisted, ctx.hasUI ? ctx.ui : undefined);
            // Sweep inbox if it's a know workspace
            if (ctx.hasUI) {
              const ws = params.activeWorkspaces.find((w) => w.name === persisted);
              // if (ws?.mode === "know") sweepInboxForWorkspace(persisted, ctx.ui).catch(() => {});
            }
          }

          // Show startup splash
          if (ctx.hasUI) {
            const wsLabel = activeWorkspace ?? params.activeWorkspaces.map((w) => w.name).join(", ") ?? "no workspaces";
            ctx.ui.setTitle(`ObsidiClaw — ${wsLabel} — ${params.noteCount} notes`);
            showStartupSplash(ctx.ui, params).catch(() => {});
          }

          readyResolve?.(params);
        } else if (notification.method === "notifications/progress") {
          const p = notification.params as { progressToken?: string; progress?: number; total?: number } | undefined;
          if (p?.progressToken === "index" && latestCtxUI) {
            const done = p.progress ?? 0;
            const total = p.total ?? 0;
            if (done >= total) {
              latestCtxUI.setStatus("indexing", undefined);
            } else {
              const filled = Math.round((done / total) * 20);
              const bar = "█".repeat(filled) + "░".repeat(20 - filled);
              latestCtxUI.setStatus("indexing", `Indexing ${done}/${total} [${bar}]`);
            }
          }
        }
      };

      await client.connect(transport);

      // Warn when embed host falls back to default
      if (ctx.hasUI) {
        const embedCfg = getEmbedConfig();
        if (embedCfg.provider !== "local" && !process.env["OBSIDI_EMBED_HOST"]) {
          ctx.ui.notify(
            `OBSIDI_EMBED_HOST not set — embedding provider defaulting to ${embedCfg.host}`,
            "warning",
          );
        }
      }

      logger.logEvent({
        type: "session_start",
        sessionId,
        timestamp: Date.now(),
      } as RunEvent);
    });

    // ── Tool registrations (call through to MCP client) ───────────────────
    registerRetrieveContextTool(pi, toolCtx);
    registerRateContextTool(pi, toolCtx);
    registerWorkspaceTools(pi, toolCtx);
    registerFindPathTool(pi, toolCtx);
    registerCaptureNoteTool(pi, {
      getLatestUI: () => latestCtxUI,
      captureNoteToInbox,
    });

    // ── /workspace command ───────────────────────────────────────────────────
    pi.registerCommand("workspace", {
      description: "Workspace actions: select (stub), add, or remove registered workspaces",
      handler: async (_args, ctx) => {
        if (!ctx.hasUI) return;

        // Wait for ready if not yet received
        const rp = readyParams ?? await Promise.race([readyPromise, new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
        const workspaces = rp?.activeWorkspaces ?? [];

        const action = await ctx.ui.select("Workspace action", ["Select", "Add", "Remove"]);
        if (!action) return;

        if (action === "Select") {
          if (workspaces.length === 0) {
            ctx.ui.notify("No workspaces registered.", "info");
            return;
          }
          const choice = await ctx.ui.select("Select workspace", workspaces.map((w) => `${w.name}  (${w.mode})`));
          if (!choice) return;
          const chosenName = choice.split("  ")[0]!;
          setActiveWorkspace(chosenName, ctx.ui);
          ctx.ui.notify(`Active workspace: ${chosenName}`, "info");
          // Sweep inbox if it's a know workspace
          const chosenWs = workspaces.find((w) => w.name === chosenName);
          // if (chosenWs?.mode === "know") sweepInboxForWorkspace(chosenName, ctx.ui).catch(() => {});
          return;
        }

        if (action === "Add") {
          const rawName = await ctx.ui.input("Workspace name", "e.g. my-app");
          if (!rawName) return;
          const name = rawName.trim();
          const nameError = validateWorkspaceName(name);
          if (nameError) {
            ctx.ui.notify(nameError, "error");
            return;
          }

          const sourceDir = await ctx.ui.input(
            "Source directory",
            "e.g. C:\\Projects\\MyApp",
          );
          if (!sourceDir) return;

          const languageChoice = await ctx.ui.select("Languages to mirror", [
            "TypeScript only",
            "Python only",
            "TypeScript + Python",
          ]);
          if (!languageChoice) return;

          let languages: ("ts" | "py")[];
          switch (languageChoice) {
            case "Python only":
              languages = ["py"];
              break;
            case "TypeScript + Python":
              languages = ["ts", "py"];
              break;
            case "TypeScript only":
            default:
              languages = ["ts"];
              break;
          }

          const previousWorkspaceStatus = activeWorkspace;
          ctx.ui.setStatus("workspace", "registering…");
          try {
            const result = await client.callTool({
              name: "register_workspace",
              arguments: { name, source_dir: sourceDir, mode: "code", languages },
            });
            const text = extractMcpText(result as { content: { type: string; text: string }[] }).trim();
            if (!text || /^Failed to register workspace:/i.test(text)) {
              const message = text || "Workspace registration failed.";
              ctx.ui.notify(message, "error");
              ctx.ui.setStatus("workspace", previousWorkspaceStatus ?? undefined);
              return;
            }

            setActiveWorkspace(name, ctx.ui);
            if (readyParams) {
              const existingIndex = readyParams.activeWorkspaces.findIndex((w) => w.name === name);
              const entry = { name, mode: "code", languages, sourceDir };
              if (existingIndex >= 0) readyParams.activeWorkspaces[existingIndex] = entry;
              else readyParams.activeWorkspaces.push(entry);
            }

            ctx.ui.notify(text.split("\n")[0] || `Workspace "${name}" registered`, "info");
          } catch (err) {
            ctx.ui.notify(`Registration failed: ${String(err)}`, "error");
            ctx.ui.setStatus("workspace", previousWorkspaceStatus ?? undefined);
          }
          return;
        }

        // Remove
        if (workspaces.length === 0) {
          ctx.ui.notify("No registered workspaces to remove.", "info");
          return;
        }

        const removeTarget = await ctx.ui.select(
          "Remove workspace",
          workspaces.map((w) => w.name),
        );
        if (!removeTarget) return;

        try {
          const result = await client.callTool({
            name: "unregister_workspace",
            arguments: { name: removeTarget },
          });
          const text = extractMcpText(result as { content: { type: string; text: string }[] });

          if (removeTarget === activeWorkspace) setActiveWorkspace(undefined, ctx.ui);
          ctx.ui.notify(text || `Workspace "${removeTarget}" unregistered`, "info");
        } catch (err) {
          ctx.ui.notify(`Unregister failed: ${String(err)}`, "error");
        }
      },
    });

    // ── Note capture ─────────────────────────────────────────────────────────

    /**
     * Show the note capture modal and write either a regular inbox note
     * (know workspace) or a concept note (md_db concepts workspace).
     */
    async function captureNoteToInbox(
      ui: ExtensionUIContext,
      suggestedTitle?: string,
      suggestedContent?: string,
    ): Promise<string> {
      const modeLabels = ["Regular note", "Concept note"] as const;
      const modeChoice = await ui.select("Capture Type", [...modeLabels]);
      if (!modeChoice) return "Note capture cancelled.";
      const captureMode = modeChoice === "Concept note" ? "concept" : "regular";

      const allWorkspaces = readyParams?.activeWorkspaces ?? [];
      const workspaceNames = (captureMode === "regular"
        ? allWorkspaces.filter((w) => w.mode === "know")
        : allWorkspaces
      ).map((w) => w.name);

      if (workspaceNames.length === 0) {
        return captureMode === "regular"
          ? "No know workspace registered. Use /workspace to register one first."
          : "No workspace registered. Use /workspace to register one first.";
      }

      // Only prompt for workspace if there's ambiguity.
      let selectedWorkspace: string;
      if (workspaceNames.length === 1) {
        selectedWorkspace = workspaceNames[0]!;
      } else {
        const orderedWorkspaceOptions = [
          ...(activeWorkspace && workspaceNames.includes(activeWorkspace) ? [activeWorkspace] : []),
          ...workspaceNames.filter((w) => w !== activeWorkspace),
        ];
        const choice = await ui.select("Workspace", orderedWorkspaceOptions);
        if (!choice) return "Note capture cancelled.";
        selectedWorkspace = choice;
      }

      // Shared fields
      const title = await ui.input("Note Title", suggestedTitle ?? "Untitled");
      if (title === undefined) return "Note capture cancelled.";
      const finalTitle = title.trim() || "Untitled";

      const content = await ui.editor("Note Content", suggestedContent ?? "");
      if (content === undefined) return "Note capture cancelled.";

      // Concept note path: write to md_db/concepts/<workspace>/ via MCP tool.
      if (captureMode === "concept") {
        const tagsInput = await ui.input("Concept Tags (comma-separated, optional)", "");
        if (tagsInput === undefined) return "Note capture cancelled.";
        const tags = tagsInput
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);

        const result = await client.callTool({
          name: "create_concept_note",
          arguments: {
            title: finalTitle,
            body: content,
            workspace: selectedWorkspace,
            ...(tags.length > 0 ? { tags } : {}),
          },
        });
        const text = extractMcpText(result as { content: { type: string; text: string }[] });
        ui.notify(`Concept note submitted for workspace: ${selectedWorkspace}`, "info");
        return text || `Concept note "${finalTitle}" submitted.`;
      }

      // Regular note path: write to selected know workspace inbox.
      const typeLabels = VAULT_NOTE_TYPES.map((t) => NOTE_TYPE_DESCRIPTIONS[t]);
      const typeChoice = await ui.select("Note Type", typeLabels);
      if (!typeChoice) return "Note capture cancelled.";
      const noteType = VAULT_NOTE_TYPES[typeLabels.indexOf(typeChoice)] ?? "permanent";

      const selectedLinks = await suggestLinksModal(ui, finalTitle, content, selectedWorkspace);

      const selectedInboxPath = join(mdDbPath, "know", selectedWorkspace, "inbox");
      ensureDir(selectedInboxPath);
      const filename = buildNoteFilename(finalTitle);
      const fileContent = buildNoteContent(noteType as VaultNoteType, finalTitle, content, [], selectedLinks, selectedWorkspace);
      writeText(join(selectedInboxPath, filename), fileContent);

      const linkNote = selectedLinks.length > 0 ? ` with ${selectedLinks.length} link(s)` : "";
      ui.notify(`Note saved to inbox: ${filename}`, "info");
      return `Note "${finalTitle}" saved to vault inbox (${filename}) in workspace "${selectedWorkspace}"${linkNote}. The inbox pipeline will process it shortly.`;
    }

    /**
     * Call retrieve_link_candidates, build a picker from validated note metadata.
     * Returns selected wikilinks — only titles that correspond to real notes on disk.
     */
    async function suggestLinksModal(
      ui: ExtensionUIContext,
      title: string,
      body: string,
      knowWorkspace?: string,
    ): Promise<string[]> {
      ui.notify("Fetching link suggestions…", "info");

      type Candidate = { noteId: string; path: string; filename: string; display: string; score: number; type: string };

      let candidates: Candidate[];
      try {
        const result = await Promise.race([
          client.callTool({
            name: "retrieve_link_candidates",
            arguments: {
              query: `${title} ${body.slice(0, 300)}`,
              ...(knowWorkspace ? { workspace: knowWorkspace } : {}),
            },
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
        ]);
        const raw = extractMcpText(result as { content: { type: string; text: string }[] });
        candidates = (JSON.parse(raw) as { candidates?: Candidate[] }).candidates ?? [];
      } catch {
        return [];
      }

      if (candidates.length === 0) {
        ui.notify("No related notes found — skipping link suggestions.", "info");
        return [];
      }

      // Build picker items: link target is always the filename (Obsidian canonical),
      // display label is the human-readable H1. Disambiguate on duplicate filenames with folder.
      const filenameCount = new Map<string, number>();
      for (const c of candidates) filenameCount.set(c.filename, (filenameCount.get(c.filename) ?? 0) + 1);

      const items = candidates.map((c) => {
        const isDup = (filenameCount.get(c.filename) ?? 0) > 1;
        const folder = c.path.split("/").slice(-2, -1)[0] ?? "";
        const label = `${c.display}${isDup ? `  (${folder})` : ""}`;
        return { label, link: `[[${c.filename}]]`, path: c.path };
      });

      // Looping single-select simulates multi-select
      const selected = new Set<string>();

      while (true) {
        const doneLabel = `✓ Done  (${selected.size} selected)`;
        const options = [
          doneLabel,
          ...items.map(({ label, link }) => (selected.has(link) ? `✓ ${label}` : `  ${label}`)),
        ];

        const choice = await ui.select(
          `Suggested Links  (↑↓ scroll · Enter select · pick "Done" to finish)`,
          options,
        );

        if (!choice || choice === doneLabel) break;

        const idx = options.indexOf(choice) - 1;
        const item = items[idx];
        if (item) {
          if (selected.has(item.link)) selected.delete(item.link);
          else selected.add(item.link);
        }
      }

      if (selected.size === 0) return [];

      // Validate: ensure each note file still exists before writing the link
      return [...selected].filter((link) => {
        const item = items.find((i) => i.link === link);
        return item && fileExists(join(mdDbPath, item.path));
      });
    }

    // ── /note command ─────────────────────────────────────────────────────────
    pi.registerCommand("note", {
      description: "Capture a regular inbox note or a concept note — opens interactive capture modals", 
      handler: async (_args, ctx) => {
        if (!ctx.hasUI) {
          ctx.ui.notify("Note capture requires interactive mode", "warning");
          return;
        }
        await captureNoteToInbox(ctx.ui);
      },
    });

    // Track prompt start time for prompt_complete durationMs
    let promptStartTs = 0;

    // ── before_agent_start: inject context blocks ────────────────────────────
    //
    // Injection strategy (avoids re-flooding the system prompt every turn):
    //   - preferences.md   → once per session (first turn only); already in
    //                        conversation history on subsequent turns
    //   - workspace block  → once per workspace load/change; re-injected
    //                        automatically when activeWorkspace switches
    //   - TOOL_REMINDER    → every turn (tiny, behaviorally critical)
    pi.on("before_agent_start", async (event, ctx) => {
      promptStartTs = Date.now();
      logger.logEvent({
        type: "prompt_received",
        sessionId,
        timestamp: promptStartTs,
        text: "(pi-tui-prompt)",
      } as RunEvent);

      const blocks: string[] = [];

      // Fast path: engine completely unavailable
      if (engineState === "unavailable") {
        blocks.push(ENGINE_UNAVAILABLE_WARNING);
        return { systemPrompt: event.systemPrompt + "\n\n" + blocks.join("\n\n") };
      }

      try {
        // ── preferences: first turn only ───────────────────────────────────
        if (!prefsInjected) {
          let prefsContent = "";
          if (activeWorkspace === "vaultus-sapiens") {
            try {
              prefsContent = readText(join(mdDbPath, "preferences-vaultus-sapiens.md"));
            } catch {
              prefsContent = "(workspace-specific preferences missing)";
            }
          } else {
            const result = await client.callTool({ name: "get_preferences", arguments: {} });
            prefsContent = extractMcpText(result);
          }
          if (prefsContent) {
            blocks.push(
              `<!-- ObsidiClaw: Preferences -->\n\n${prefsContent}\n\n<!-- End ObsidiClaw Preferences -->`,
            );
          }
          prefsInjected = true;
        }

        // ── workspace context: on load / change only ────────────────────────
        if (activeWorkspace !== lastInjectedWorkspace) {
          if (activeWorkspace) {
            // If switching from a previous workspace, note that prior context is superseded.
            const switchNotice = lastInjectedWorkspace
              ? `\n<!-- previous workspace context (${lastInjectedWorkspace}) in conversation history is superseded -->`
              : "";

            // Active workspace header
            blocks.push(
              `<!-- ObsidiClaw: Active Workspace -->${switchNotice}\n\nActive workspace: **${activeWorkspace}**\nAll \`retrieve_context\` calls default to this workspace. Pass an explicit \`workspace\` arg to override.\n\n<!-- End ObsidiClaw Active Workspace -->`,
            );

            // Mode-specific context (tree for code, file list for know).
            // Only mark as injected once wsEntry is resolved — guards against
            // readyParams not yet available on the first prompt.
            const wsEntry = readyParams?.activeWorkspaces.find((w) => w.name === activeWorkspace);
            if (wsEntry) {
              const wsContext = buildWorkspaceContext(wsEntry, mdDbPath);
              if (wsContext) blocks.push(wsContext);

              // Concept note headers scoped to this workspace
              const conceptsBlock = buildConceptsIndex(join(mdDbPath, "concepts"), activeWorkspace);
              if (conceptsBlock) blocks.push(conceptsBlock);

              // Mark injected only after a successful wsEntry lookup.
              // If readyParams wasn't ready, leave lastInjectedWorkspace dirty
              // so the next turn retries and gets the full context.
              lastInjectedWorkspace = activeWorkspace;
            }
          } else {
            // Workspace cleared — no context to inject, just mark clean.
            lastInjectedWorkspace = undefined;
          }
        }
      } catch {
        if (ctx.hasUI) ctx.ui.notify("Context engine unavailable this turn", "warning");
        if (!prefsInjected) blocks.push(ENGINE_UNAVAILABLE_WARNING);
      }

      // ── tool reminder: every turn ─────────────────────────────────────────
      blocks.push(TOOL_REMINDER);

      return {
        systemPrompt: event.systemPrompt + (blocks.length ? "\n\n" + blocks.join("\n\n") : ""),
      };
    });

    // ── Pi event logging ──────────────────────────────────────────────────────
    const logPiEvent = (event: unknown) => {
      const mapped = mapPiEventToRunEvent(
        event as { type: string; [key: string]: unknown },
        sessionId,
      );
      if (mapped) logger.logEvent(mapped);
    };
    pi.on("agent_start", logPiEvent);
    pi.on("turn_end", logPiEvent);
    pi.on("tool_execution_start", logPiEvent);
    pi.on("tool_execution_end", logPiEvent);

    // ── agent_end: capture transcript, log agent_done + prompt_complete ───────
    pi.on("agent_end", (event) => {
      const messages = (event as unknown as { messages?: unknown[] })?.messages;
      if (Array.isArray(messages)) latestMessages = messages;

      const mapped = mapPiEventToRunEvent(
        event as unknown as { type: string; [key: string]: unknown },
        sessionId,
      );
      if (mapped) logger.logEvent(mapped);

      logger.logEvent({
        type: "prompt_complete",
        sessionId,
        timestamp: Date.now(),
        durationMs: Date.now() - promptStartTs,
      } as RunEvent);
    });

    // ── session_shutdown ─────────────────────────────────────────────────────
    pi.on("session_shutdown", async () => {
      latestCtxUI?.setStatus("indexing", undefined);
      latestCtxUI = undefined;
      try {
        const jobId = randomUUID();
        const workDir = join(paths.rootDir, ".obsidi-claw", "reviews");
        const specPath = join(workDir, `${jobId}.json`);
        const resultPath = join(workDir, `${jobId}.result.json`);
        const logPath = join(workDir, `${jobId}.log`);
        const scriptPath = join(paths.rootDir, "dist", "automation", "scripts", "run_session_review.js");

        ensureDir(workDir);

        const spec = {
          type: "review",
          jobId,
          sessionId,
          rootDir: paths.rootDir,
          trigger: "session_end",
          messages: latestMessages,
          compactionMeta: undefined,
          mdDbPath,
          resultPath,
          logPath,
          createdAt: Date.now(),
        };

        writeText(specPath, JSON.stringify(spec, null, 2));

        const child = spawnProcess(getExecPath(), [scriptPath, specPath], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      } catch (err) {
        logger.logEvent({ type: "diagnostic", sessionId, timestamp: Date.now(), module: "extension", level: "error", message: `session_review enqueue failed: ${err instanceof Error ? err.message : String(err)}` } as RunEvent);
      } finally {
        logger.logEvent({
          type: "session_end",
          sessionId,
          timestamp: Date.now(),
        } as RunEvent);
        // Close MCP client — this kills the child process (stdin closes → child exits)
        void client?.close();
        logger.close();
      }
    });
  };
}
