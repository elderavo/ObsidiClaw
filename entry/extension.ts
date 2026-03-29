/**
 * ObsidiClaw ExtensionFactory — MCP-backed context injection + retrieve_context tool.
 *
 * Two modes:
 *
 * 1. **Standalone / Pi TUI** (no mcpServer provided):
 *    Creates a full ObsidiClawStack (engine, logger, scheduler, runner) and
 *    manages its lifecycle via session_start / session_shutdown. This gives
 *    Pi the same capabilities as the headless orchestrator path.
 *
 * 2. **Orchestrator / headless** (mcpServer provided):
 *    Connects to the caller's MCP server. Caller owns engine lifecycle.
 *    The extension connects/disconnects transport only.
 *
 * Hooks registered in both modes:
 *   - before_agent_start: inject preferences.md + tool reminder
 *   - retrieve_context tool: proxy to MCP retrieve_context
 *
 * Additional hooks in standalone mode:
 *   - Pi event logging (prompt_received, agent_turn_start/end, tool_call/result, etc.)
 *   - Scheduler start/stop
 *   - Session review on shutdown
 */

import "dotenv/config";
import { randomUUID } from "crypto";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ExtensionFactory, type ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { createContextEngineMcpServer } from "../knowledge/engine/index.js";
import { resolvePaths, getEmbedConfig } from "../core/config.js";
import { extractMcpText } from "../core/text-utils.js";
import { ensureDir, writeText, readText, listDir, fileExists } from "../core/os/fs.js";
import { spawnProcess, getExecPath } from "../core/os/process.js";
import { createObsidiClawStack, type ObsidiClawStack } from "./stack.js";
import { mapPiEventToRunEvent } from "../agents/pi-event-mapper.js";
import { buildDirectoryTree, stripDirectoryBlock } from "../automation/scripts/update-directory-tree.js";
import { TOOL_REMINDER, ENGINE_UNAVAILABLE_WARNING } from "../agents/prompts.js";
import type { RunEvent } from "../logger/types.js";
import type { ToolContext } from "./tools/types.js";
import { registerRetrieveContextTool } from "./tools/retrieve-context.js";
import { registerRateContextTool } from "./tools/rate-context.js";
import { registerWorkspaceTools } from "./tools/workspace.js";
import { registerFindPathTool } from "./tools/find-path.js";
import type { WorkspaceEntry } from "../automation/workspaces/workspace-registry.js";

// ---------------------------------------------------------------------------
// Shared state — lets other extensions reuse the stack's engine.
// ---------------------------------------------------------------------------

let _sharedStack: ObsidiClawStack | undefined;

/** Engine from the standalone stack (undefined in orchestrator mode or before init). */
export function getSharedEngine() { return _sharedStack?.engine; }


// ---------------------------------------------------------------------------
// TUI helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape sequences to measure visible string length. */
function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

async function showStartupSplash(
  ui: ExtensionUIContext,
  stats: { noteCount: number; edgeCount: number; indexLoaded: boolean },
  activeWs: readonly WorkspaceEntry[],
): Promise<void> {
  await ui.custom(
    (_tui, theme, _keybindings, done) => {
      const W = 52; // inner content width (border chars excluded from visible measure)

      const engineStatus = stats.indexLoaded
        ? theme.fg("success", "● OK")
        : theme.fg("warning", "● degraded (keyword-only)");

      const wsLines =
        activeWs.length === 0
          ? ["  none registered"]
          : activeWs.map((w) => `  ${w.name}  (${w.mode}, ${w.languages.join("+")})`);

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
          `  Graph       ${theme.fg("text", String(stats.noteCount))} notes` +
          `  ·  ${theme.fg("text", String(stats.edgeCount))} edges`,
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
   * Already-built MCP server wrapping a ContextEngine (e.g. from OrchestratorSession).
   * Caller owns engine lifecycle. The extension connects/disconnects transport only.
   */
  mcpServer?: McpServer;

  /**
   * Path to the md_db directory.
   * Only used when mcpServer is not provided (standalone / Pi TUI path).
   * Defaults to resolvePaths().mdDbPath.
   */
  mdDbPath?: string;

  /**
   * Project root directory. Used to resolve paths for review worker scripts, etc.
   * Defaults to resolvePaths().rootDir (which falls back to process.cwd()).
   */
  rootDir?: string;

  /**
   * Explicit session ID. When provided, used for review job metadata instead of
   * generating a random one.
   */
  sessionId?: string;

}

// ---------------------------------------------------------------------------
// Standing system-prompt instruction (appended on every before_agent_start)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Concepts index builder
// ---------------------------------------------------------------------------

/**
 * Scans md_db/concepts/ and returns a compact block listing each concept note
 * by filename + H1 title + workspace scope. Injected at session start so Pi
 * always knows which design principles exist and can retrieve the full note on demand.
 *
 * activeWorkspace filters workspace-specific concepts: a note with workspace: X
 * only appears when X is the active workspace. Notes with no workspace field are
 * always included (general principles).
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

    // Filter: include general (no workspace) always; workspace-specific only when active
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

    // Tracks the current session's UI handle so the index progress listener
    // (registered once per factory) can update the status bar.
    let latestCtxUI: { setStatus(key: string, text: string | undefined): void } | undefined;

    // Active workspace for concept filtering. Set by /workspace command.
    // undefined = show only general (workspace-agnostic) concepts.
    let activeWorkspace: string | undefined;

    // ── Engine + MCP server setup ────────────────────────────────────────────

    let stack: ObsidiClawStack | undefined;
    let mcpServer: McpServer;

    if (config.mcpServer) {
      // Orchestrator path — caller owns everything.
      mcpServer = config.mcpServer;
    } else {
      // Standalone / Pi TUI path — create the full stack.
      stack = createObsidiClawStack({
        rootDir: paths.rootDir,
      });
      _sharedStack = stack;

      const sessionId = stack.sessionId;

      mcpServer = createContextEngineMcpServer({
        engine: stack.engine,
        pruneStorage: stack.noteMetrics.pruneStorage,
        workspaceRegistry: stack.workspaceRegistry,
        onContextBuilt: (pkg) => {
          const noteHits = pkg.retrievedNotes.map((n) => ({
            noteId: n.noteId,
            score: n.score,
            depth: n.depth ?? 0,
            source: n.retrievalSource,
            tier: n.tier,
            noteType: n.type,
            symbolKind: n.symbolKind,
          }));
          const ts = Date.now();
          stack!.logger.logEvent({
            type: "context_retrieved",
            sessionId,
            runId: toolCtx.currentRunId,
            timestamp: ts,
            query: pkg.query,
            seedCount: pkg.seedNoteIds?.length ?? 0,
            expandedCount: pkg.expandedNoteIds?.length ?? 0,
            toolCount: pkg.suggestedTools.length,
            retrievalMs: pkg.retrievalMs,
            rawChars: pkg.rawChars,
            strippedChars: pkg.strippedChars,
            estimatedTokens: pkg.estimatedTokens,
            reviewMs: pkg.reviewResult?.reviewMs,
            reviewSkipped: pkg.reviewResult?.skipped,
            noteHits,
          } as RunEvent);
          stack!.noteMetrics.logRetrieval({
            sessionId,
            runId: toolCtx.currentRunId,
            timestamp: ts,
            query: pkg.query,
            seedCount: pkg.seedNoteIds?.length ?? 0,
            expandedCount: pkg.expandedNoteIds?.length ?? 0,
            toolCount: pkg.suggestedTools.length,
            retrievalMs: pkg.retrievalMs,
            rawChars: pkg.rawChars,
            strippedChars: pkg.strippedChars,
            estimatedTokens: pkg.estimatedTokens,
            noteHits,
          });
        },
        onContextRated: (rating) => {
          const ts = Date.now();
          stack!.logger.logEvent({
            type: "context_rated",
            sessionId,
            runId: toolCtx.currentRunId,
            timestamp: ts,
            query: rating.query,
            score: rating.score,
            missing: rating.missing,
            helpful: rating.helpful,
          } as RunEvent);
          stack!.noteMetrics.logRating({
            sessionId,
            runId: toolCtx.currentRunId,
            timestamp: ts,
            query: rating.query,
            score: rating.score,
            missing: rating.missing,
            helpful: rating.helpful,
          });
        },
        onBackgroundError: (context, err) => {
          stack!.logger.logEvent({
            type: "diagnostic",
            sessionId,
            runId: toolCtx.currentRunId,
            timestamp: Date.now(),
            module: "mcp_server",
            level: "error",
            message: `${context}: ${err instanceof Error ? err.message : String(err)}`,
          });
        },
      });
    }

    // ── Index progress bar (standalone mode only) ────────────────────────────
    // Python emits index_progress notifications during incremental_update.
    // We render a status bar entry so the user sees progress on large workspaces.
    if (stack) {
      stack.engine.on("indexProgress", (done: number, total: number) => {
        if (!latestCtxUI) return;
        if (done >= total) {
          latestCtxUI.setStatus("indexing", undefined);
        } else {
          const filled = Math.round((done / total) * 20);
          const bar = "█".repeat(filled) + "░".repeat(20 - filled);
          latestCtxUI.setStatus("indexing", `Indexing ${done}/${total} [${bar}]`);
        }
      });
    }

    // Track latest transcript (updated on agent_end) for review hook
    let latestMessages: unknown[] = [];

    // MCP client — reassigned each session_start so transport is always fresh.
    let client = new Client({ name: "obsidi-claw-ext", version: "1.0.0" });

    // Shared mutable state for extracted tool files. Tools read properties at
    // call time, so mutations here are visible to all registered tools.
    const toolCtx: ToolContext = { client, currentRunId: "", engineState: "ok" };

    // ── session_start: initialize stack + connect MCP pair ───────────────────
    pi.on("session_start", async (_event, ctx) => {
      latestCtxUI = ctx.hasUI ? ctx.ui : undefined;
      ensureDir(join(paths.rootDir, ".obsidi-claw"));

      // One-time migration: strip directory tree block from preferences.md if present.
      try { stripDirectoryBlock(join(mdDbPath, "preferences.md")); } catch { /* ignore */ }

      // Connect MCP FIRST — before stack.initialize() — so any engine init
      // failure surfaces as "ContextEngine not initialized" rather than the
      // opaque "Not connected" error that results from client never connecting.
      // Also recreate transport+client each session so shutdown→new-session works.
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      client = new Client({ name: "obsidi-claw-ext", version: "1.0.0" });
      toolCtx.client = client;
      await mcpServer.connect(serverTransport);
      await client.connect(clientTransport);

      if (stack) {
        try {
          await stack.initialize();

          // Engine started but without embeddings — keyword + graph still work
          if (stack.engine.isDegraded) {
            toolCtx.engineState = "degraded";
            const reason = stack.engine.degradedReasonMessage || "embedding provider unavailable";
            stack.logger.logEvent({ type: "diagnostic", sessionId: stack.sessionId, runId: "", timestamp: Date.now(), module: "extension", level: "warn", message: `context engine degraded: ${reason}` });
            if (ctx.hasUI) {
              ctx.ui.notify(
                `Context engine running in keyword-only mode: ${reason}`,
                "warning",
              );
            }
          }
        } catch (err) {
          toolCtx.engineState = "unavailable";
          const reason = err instanceof Error ? err.message : String(err);
          stack.logger.logEvent({ type: "diagnostic", sessionId: stack.sessionId, runId: "", timestamp: Date.now(), module: "extension", level: "error", message: `context engine failed to initialize: ${reason}` });
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Context engine unavailable: ${reason}`,
              "warning",
            );
          }
        }
      }

      // Warn when embed host falls back to default (easy misconfiguration)
      if (stack && ctx.hasUI) {
        const embedCfg = getEmbedConfig();
        if (embedCfg.provider !== "local" && !process.env["OBSIDI_EMBED_HOST"]) {
          ctx.ui.notify(
            `OBSIDI_EMBED_HOST not set — embedding provider defaulting to ${embedCfg.host}`,
            "warning",
          );
        }
      }

      // ── Window title + startup splash ─────────────────────────────────────
      if (stack && ctx.hasUI) {
        const stats = await stack.engine.getGraphStats().catch(() => ({
          noteCount: 0, edgeCount: 0, indexLoaded: false,
        }));
        const activeWs = stack.workspaceRegistry.list().filter((w) => w.active);
        const wsLabel = activeWs.map((w) => w.name).join(", ") || "no workspaces";
        ctx.ui.setTitle(`ObsidiClaw — ${wsLabel} — ${stats.noteCount} notes`);
        showStartupSplash(ctx.ui, stats, activeWs).catch(() => {});
      }

      if (stack) {
        stack.logger.logEvent({
          type: "session_start",
          sessionId: stack.sessionId,
          timestamp: Date.now(),
        } as RunEvent);
      }
    });

    // ── Tool registrations (extracted to entry/tools/) ──────────────────────
    registerRetrieveContextTool(pi, toolCtx);
    registerRateContextTool(pi, toolCtx);
    registerWorkspaceTools(pi, toolCtx);
    registerFindPathTool(pi, toolCtx);

    // ── /workspace command ───────────────────────────────────────────────────
    pi.registerCommand("workspace", {
      description: "Pick active workspace — scopes concept injection and context",
      handler: async (_args, ctx) => {
        if (!ctx.hasUI) return;

        // Load workspace registry
        const registry = stack?.workspaceRegistry;
        const workspaces = registry?.list().filter((w) => w.active) ?? [];

        const MAX_LISTED = 4;
        const listed = workspaces.slice(0, MAX_LISTED);
        const options = [
          ...listed.map((w) => w.name),
          "＋ Add new workspace",
        ];

        const choice = await ctx.ui.select("Active workspace", options);

        if (!choice) return; // dismissed

        if (choice === "＋ Add new workspace") {
          const name = await ctx.ui.input("Workspace name", "e.g. my-app");
          if (!name) return;
          const sourceDir = await ctx.ui.input(
            "Source directory",
            "e.g. C:\\Projects\\MyApp",
          );
          if (!sourceDir) return;

          if (!stack) {
            ctx.ui.notify("Stack not available — cannot register workspace", "error");
            return;
          }

          ctx.ui.setStatus("workspace", "registering…");
          try {
            await stack.workspaceRegistry.register({
              name,
              sourceDir,
              mode: "code",
              languages: ["ts", "py"],
              active: true,
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

        // Set the active workspace
        activeWorkspace = choice;
        ctx.ui.notify(`Active workspace: ${choice}`, "info");
        ctx.ui.setStatus("workspace", choice);
      },
    });

    // ── before_agent_start: inject preferences + standing tool reminder ─────
    // Calls MCP get_preferences so the engine stays behind the MCP boundary.
    pi.on("before_agent_start", async (event, ctx) => {
      // Generate new runId for this prompt (standalone mode logging)
      if (stack) {
        toolCtx.currentRunId = randomUUID();
        stack.logger.logEvent({
          type: "prompt_received",
          sessionId: stack.sessionId,
          runId: toolCtx.currentRunId,
          timestamp: Date.now(),
          text: "(pi-tui-prompt)",
        } as RunEvent);
      }

      // Fast path: engine is completely unavailable — inject warning, skip MCP calls
      if (toolCtx.engineState === "unavailable") {
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
        // MCP call failed unexpectedly — inject warning for this turn
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

    // ── Pi event logging (standalone mode only) ──────────────────────────────
    // Uses shared mapper from agents/pi-event-mapper.ts.
    if (stack) {
      const s = stack;
      const logPiEvent = (event: unknown) => {
        const mapped = mapPiEventToRunEvent(
          event as { type: string; [key: string]: unknown },
          s.sessionId,
          toolCtx.currentRunId,
        );
        if (mapped) s.logger.logEvent(mapped);
      };
      pi.on("agent_start", logPiEvent);
      pi.on("turn_end", logPiEvent);
      pi.on("tool_execution_start", logPiEvent);
      pi.on("tool_execution_end", logPiEvent);
    }

    // ── agent_end: capture transcript + log event ────────────────────────────
    pi.on("agent_end", (event) => {
      const messages = (event as unknown as { messages?: unknown[] })?.messages;
      if (Array.isArray(messages)) latestMessages = messages;

      if (stack) {
        const mapped = mapPiEventToRunEvent(
          event as unknown as { type: string; [key: string]: unknown },
          stack.sessionId,
          toolCtx.currentRunId,
        );
        if (mapped) stack.logger.logEvent(mapped);
      }
    });

    // ── session_shutdown ─────────────────────────────────────────────────────
    pi.on("session_shutdown", async () => {
      latestCtxUI?.setStatus("indexing", undefined);
      latestCtxUI = undefined;
      try {
        // Only queue review when this extension owns the stack (Pi TUI path).
        if (stack) {
          const jobId = randomUUID();
          const sessionId = config.sessionId ?? stack.sessionId;
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
        }
      } catch (err) {
        if (stack) {
          stack.logger.logEvent({ type: "diagnostic", sessionId: stack.sessionId, runId: toolCtx.currentRunId, timestamp: Date.now(), module: "extension", level: "error", message: `session_review enqueue failed: ${err instanceof Error ? err.message : String(err)}` } as RunEvent);
        }
      } finally {
        void client.close();
        void mcpServer.close();
        if (stack) {
          stack.logger.logEvent({
            type: "session_end",
            sessionId: stack.sessionId,
            timestamp: Date.now(),
          } as RunEvent);
          await stack.shutdown();
          _sharedStack = undefined;
        }
      }
    });
  };
}
