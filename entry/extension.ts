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
import { Type } from "@sinclair/typebox";
import { resolvePaths, getEmbedConfig } from "../core/config.js";
import { extractMcpText } from "../core/text-utils.js";
import { ensureDir, writeText, readText, listDir, fileExists } from "../core/os/fs.js";
import { spawnProcess, getExecPath } from "../core/os/process.js";
import { RunLogger } from "../logger/run-logger.js";
import { mapPiEventToRunEvent } from "../agents/pi-event-mapper.js";
import { buildDirectoryTree, stripDirectoryBlock } from "../automation/scripts/update-directory-tree.js";
import { TOOL_REMINDER, ENGINE_UNAVAILABLE_WARNING } from "../agents/prompts.js";
import { buildNoteContent, buildInboxFilename, VAULT_NOTE_TYPES, NOTE_TYPE_DESCRIPTIONS, type VaultNoteType } from "../knowledge/markdown/vault-schema.js";
import type { RunEvent } from "../logger/types.js";
import type { ToolContext } from "./tools/types.js";
import { registerRetrieveContextTool } from "./tools/retrieve-context.js";
import { registerRateContextTool } from "./tools/rate-context.js";
import { registerWorkspaceTools } from "./tools/workspace.js";
import { registerFindPathTool } from "./tools/find-path.js";


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
// Concepts index builder
// ---------------------------------------------------------------------------

/**
 * Scans md_db/concepts/ and returns a compact block listing each concept note
 * by filename + H1 title + workspace scope. Injected at session start so Pi
 * always knows which design principles exist and can retrieve the full note on demand.
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

    // Vault inbox path — set from the first active "know" workspace in ready notification
    let vaultInboxPath: string | undefined;

    // Active workspace for concept filtering. Set by /workspace command.
    let activeWorkspace: string | undefined;

    // Engine state — populated when child process sends obsidi-claw/ready
    let engineState: "ok" | "degraded" | "unavailable" = "ok";

    // Ready params — populated by child process notification
    let readyParams: ReadyParams | undefined;
    let readyResolve: ((params: ReadyParams) => void) | undefined;
    const readyPromise = new Promise<ReadyParams>((resolve) => { readyResolve = resolve; });

    // Track latest transcript (updated on agent_end) for review hook
    let latestMessages: unknown[] = [];

    // MCP client — talks to child process over stdio
    let client: Client;
    let transport: StdioClientTransport;

    // Shared mutable state for tool registrations.
    const toolCtx: ToolContext = { client: null as unknown as Client, engineState: "ok" };

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

          // Resolve vault inbox path from first active "know" workspace
          const knowWs = params.activeWorkspaces.find((w) => w.mode === "know");
          if (knowWs) {
            vaultInboxPath = join(knowWs.sourceDir, "notes", "inbox");
          }

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

          // Show startup splash
          if (ctx.hasUI) {
            const wsLabel = params.activeWorkspaces.map((w) => w.name).join(", ") || "no workspaces";
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

    // ── /workspace command ───────────────────────────────────────────────────
    pi.registerCommand("workspace", {
      description: "Pick active workspace — scopes concept injection and context",
      handler: async (_args, ctx) => {
        if (!ctx.hasUI) return;

        // Wait for ready if not yet received
        const rp = readyParams ?? await Promise.race([readyPromise, new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
        const workspaces = rp?.activeWorkspaces ?? [];

        const MAX_LISTED = 4;
        const listed = workspaces.slice(0, MAX_LISTED);
        const options = [
          ...listed.map((w) => w.name),
          "＋ Add new workspace",
        ];

        const choice = await ctx.ui.select("Active workspace", options);

        if (!choice) return;

        if (choice === "＋ Add new workspace") {
          const name = await ctx.ui.input("Workspace name", "e.g. my-app");
          if (!name) return;
          const sourceDir = await ctx.ui.input(
            "Source directory",
            "e.g. C:\\Projects\\MyApp",
          );
          if (!sourceDir) return;

          ctx.ui.setStatus("workspace", "registering…");
          try {
            await client.callTool({
              name: "register_workspace",
              arguments: { name, source_dir: sourceDir, mode: "code", languages: ["ts", "py"] },
            });
            activeWorkspace = name;
            ctx.ui.setStatus("workspace", name);
            ctx.ui.notify(`Workspace "${name}" registered`, "info");
          } catch (err) {
            ctx.ui.notify(`Registration failed: ${String(err)}`, "error");
            ctx.ui.setStatus("workspace", undefined);
          }
          return;
        }

        activeWorkspace = choice;
        ctx.ui.notify(`Active workspace: ${choice}`, "info");
        ctx.ui.setStatus("workspace", choice);
      },
    });

    // ── Note capture ─────────────────────────────────────────────────────────

    /**
     * Show the note capture modal and write the result to the vault inbox.
     * Returns a status string for tool result or notification.
     */
    async function captureNoteToInbox(
      ui: ExtensionUIContext,
      suggestedTitle?: string,
      suggestedContent?: string,
    ): Promise<string> {
      if (!vaultInboxPath) {
        return "No vault workspace registered. Use /workspace to register a 'know' workspace first.";
      }

      const title = await ui.input("Note Title", suggestedTitle ?? "Untitled");
      if (title === undefined) return "Note capture cancelled.";
      const finalTitle = title.trim() || "Untitled";

      const content = await ui.editor("Note Content", suggestedContent ?? "");
      if (content === undefined) return "Note capture cancelled.";

      const typeLabels = VAULT_NOTE_TYPES.map((t) => NOTE_TYPE_DESCRIPTIONS[t]);
      const typeChoice = await ui.select("Note Type", typeLabels);
      if (!typeChoice) return "Note capture cancelled.";
      const noteType = VAULT_NOTE_TYPES[typeLabels.indexOf(typeChoice)] ?? "permanent";

      ensureDir(vaultInboxPath);
      const filename = buildInboxFilename(finalTitle);
      const fileContent = buildNoteContent(noteType as VaultNoteType, finalTitle, content);
      writeText(join(vaultInboxPath, filename), fileContent);

      ui.notify(`Note saved to inbox: ${filename}`, "info");
      return `Note "${finalTitle}" saved to vault inbox (${filename}). The inbox pipeline will lint and suggest links shortly.`;
    }

    // ── /note command ─────────────────────────────────────────────────────────
    pi.registerCommand("note", {
      description: "Capture a note to your vault inbox — opens the note editor modal",
      handler: async (_args, ctx) => {
        if (!ctx.hasUI) {
          ctx.ui.notify("Note capture requires interactive mode", "warning");
          return;
        }
        await captureNoteToInbox(ctx.ui);
      },
    });

    // ── capture_note tool (Pi LLM-callable) ───────────────────────────────────
    pi.registerTool({
      name: "capture_note",
      label: "Capture Note",
      description:
        "Open the note capture modal so the user can save a note to their vault inbox. " +
        "Call this when the user asks to 'make a note', 'save this', or 'note that down'. " +
        "Pass suggested_title and suggested_content pre-filled from the conversation context — " +
        "the user will review and edit before submitting.",
      promptSnippet: "capture_note(suggested_title?, suggested_content?) — open note capture modal",
      parameters: Type.Object({
        suggested_title: Type.Optional(Type.String({
          description: "Pre-filled title for the note, derived from the conversation.",
        })),
        suggested_content: Type.Optional(Type.String({
          description: "Pre-filled body for the note, derived from the conversation.",
        })),
      }),
      execute: async (_toolCallId, args) => {
        const { suggested_title, suggested_content } = args as {
          suggested_title?: string;
          suggested_content?: string;
        };

        if (!latestCtxUI) {
          return {
            content: [{ type: "text" as const, text: "UI not available. Run `notetaker` from the CLI instead." }],
            details: {},
          };
        }

        const result = await captureNoteToInbox(latestCtxUI, suggested_title, suggested_content);
        return {
          content: [{ type: "text" as const, text: result }],
          details: {},
        };
      },
    });

    // Track prompt start time for prompt_complete durationMs
    let promptStartTs = 0;

    // ── before_agent_start: inject preferences + standing tool reminder ─────
    pi.on("before_agent_start", async (event, ctx) => {
      promptStartTs = Date.now();
      logger.logEvent({
        type: "prompt_received",
        sessionId,
        timestamp: promptStartTs,
        text: "(pi-tui-prompt)",
      } as RunEvent);

      // Fast path: engine is completely unavailable
      if (engineState === "unavailable") {
        const treeContent = buildDirectoryTree(paths.rootDir);
        const treeBlock = `<!-- ObsidiClaw: Project Structure -->\n\n## Project directory structure\n\n${treeContent}\n\n<!-- End ObsidiClaw Project Structure -->`;

        return {
          systemPrompt:
            event.systemPrompt +
            "\n\n" + ENGINE_UNAVAILABLE_WARNING +
            "\n\n" + treeBlock,
        };
      }

      try {
        const result = await client.callTool({ name: "get_preferences", arguments: {} });
        const prefsContent = extractMcpText(result);

        const prefsBlock = prefsContent
          ? `<!-- ObsidiClaw: Preferences -->\n\n${prefsContent}\n\n<!-- End ObsidiClaw Preferences -->`
          : "";

        const conceptsBlock = buildConceptsIndex(join(paths.mdDbPath, "concepts"), activeWorkspace);

        const treeContent = buildDirectoryTree(paths.rootDir);
        const treeBlock = `<!-- ObsidiClaw: Project Structure -->\n\n## Project directory structure\n\n${treeContent}\n\n<!-- End ObsidiClaw Project Structure -->`;

        return {
          systemPrompt:
            event.systemPrompt +
            (prefsBlock ? "\n\n" + prefsBlock : "") +
            (conceptsBlock ? "\n\n" + conceptsBlock : "") +
            "\n\n" + treeBlock +
            "\n\n" +
            TOOL_REMINDER,
        };
      } catch {
        if (ctx.hasUI) ctx.ui.notify("Context engine unavailable this turn", "warning");

        const treeContent = buildDirectoryTree(paths.rootDir);
        const treeBlock = `<!-- ObsidiClaw: Project Structure -->\n\n## Project directory structure\n\n${treeContent}\n\n<!-- End ObsidiClaw Project Structure -->`;

        return {
          systemPrompt:
            event.systemPrompt +
            "\n\n" + ENGINE_UNAVAILABLE_WARNING +
            "\n\n" + treeBlock,
        };
      }
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
