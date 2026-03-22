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

import { randomUUID } from "crypto";
import { join } from "path";
import { Type } from "@sinclair/typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { createContextEngineMcpServer } from "../context_engine/index.js";
import { resolvePaths } from "../shared/config.js";
import { extractMcpText } from "../shared/text-utils.js";
import { ensureDir, writeText } from "../shared/os/fs.js";
import { spawnProcess, getExecPath } from "../shared/os/process.js";
import { createObsidiClawStack, type ObsidiClawStack } from "../shared/stack.js";
import { mapPiEventToRunEvent } from "../shared/pi-event-mapper.js";
import type { RunEvent } from "../orchestrator/types.js";

// ---------------------------------------------------------------------------
// Shared state — lets other extensions (subagent.ts) reuse the stack's engine
// and runner instead of creating duplicates.
// ---------------------------------------------------------------------------

let _sharedStack: ObsidiClawStack | undefined;

/** Engine from the standalone stack (undefined in orchestrator mode or before init). */
export function getSharedEngine() { return _sharedStack?.engine; }

/** SubagentRunner from the standalone stack. */
export function getSharedRunner() { return _sharedStack?.runner; }

/** JobScheduler from the standalone stack. */
export function getSharedScheduler() { return _sharedStack?.scheduler; }

/** PersistentScheduleBackend from the standalone stack. */
export function getSharedBackend() { return _sharedStack?.persistentBackend; }

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

  /** Enable the in-process job scheduler (default: true). Standalone mode only. */
  enableScheduler?: boolean;
}

// ---------------------------------------------------------------------------
// Standing system-prompt instruction (appended on every before_agent_start)
// ---------------------------------------------------------------------------

const TOOL_REMINDER = `
## ObsidiClaw Knowledge Base

You have access to a \`retrieve_context\` tool that searches this project's knowledge base (notes, tools, concepts, best practices).

**Always call \`retrieve_context\` before relying on your own knowledge** for any project-specific question — tools, architecture, patterns, or concepts. The context above was auto-retrieved for this prompt; use the tool with a more targeted query if you need different or deeper information.
`.trim();

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createObsidiClawExtension(
  config: ObsidiClawExtensionConfig = {},
): ExtensionFactory {
  return async (pi) => {
    const paths = resolvePaths(config.rootDir);
    const mdDbPath = config.mdDbPath ?? paths.mdDbPath;

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
        enableScheduler: config.enableScheduler,
      });
      _sharedStack = stack;

      const sessionId = stack.sessionId;

      mcpServer = createContextEngineMcpServer({
        engine: stack.engine,
        onContextBuilt: (pkg) => {
          stack!.logger.logEvent({
            type: "context_retrieved",
            sessionId,
            runId: currentRunId,
            timestamp: Date.now(),
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
            noteHits: pkg.retrievedNotes.map((n) => ({
              noteId: n.noteId,
              score: n.score,
              depth: n.depth ?? 0,
              source: n.retrievalSource,
            })),
          } as RunEvent);
        },
        onSubagentPrepared: (pkg) => {
          stack!.logger.logEvent({
            type: "subagent_start",
            sessionId,
            runId: currentRunId,
            timestamp: Date.now(),
            prompt: pkg.input.prompt,
            plan: pkg.input.plan,
            seedCount: pkg.contextPackage.seedNoteIds?.length ?? 0,
            expandedCount: pkg.contextPackage.expandedNoteIds?.length ?? 0,
            estimatedTokens: pkg.contextPackage.estimatedTokens,
          } as RunEvent);
        },
      });
    }

    // Track latest transcript (updated on agent_end) for review hook
    let latestMessages: unknown[] = [];

    // Current run ID — updated per before_agent_start for event attribution
    let currentRunId = "";

    // Create InMemoryTransport pair and client (connected in session_start).
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "obsidi-claw-ext", version: "1.0.0" });

    // ── session_start: initialize stack + connect MCP pair ───────────────────
    pi.on("session_start", async () => {
      ensureDir(join(paths.rootDir, ".obsidi-claw"));
      if (stack) await stack.initialize();
      await mcpServer.connect(serverTransport);
      await client.connect(clientTransport);

      // Show persistent tasks on TUI startup
      if (stack?.persistentBackend) {
        try {
          const tasks = await stack.persistentBackend.list();
          const specs = await (async () => {
            try { return (await import("../jobs/persistent-tasks.js")).listTaskSpecs(paths.rootDir); } catch { return []; }
          })();
          const specNames = specs.map((s: any) => s.name);
          const lines = ["[scheduler] persistent tasks:", ...specNames.map((n: string) => ` - ${n}`)];
          console.log(lines.join("\n"));
        } catch (err) {
          console.log("[scheduler] unable to list persistent tasks", err);
        }
      }

      if (stack) {
        stack.logger.logEvent({
          type: "session_start",
          sessionId: stack.sessionId,
          timestamp: Date.now(),
        } as RunEvent);
      }
    });

    // ── retrieve_context tool: Pi calls this when it decides it needs info ──
    pi.registerTool({
      name: "retrieve_context",
      label: "Knowledge Base Retrieval",
      description:
        "Search the ObsidiClaw project knowledge base for relevant notes, tools, " +
        "concepts, and best practices. Returns markdown-formatted context from the " +
        "md_db knowledge graph. Call this before relying on your own knowledge for " +
        "any project-specific question.",
      promptSnippet: "retrieve_context(query) — search the project knowledge base",
      parameters: Type.Object({
        query: Type.String({
          description: "What to search for in the knowledge base.",
        }),
      }),
      execute: async (_toolCallId, { query }, _signal, _onUpdate, _ctx) => {
        const result = await client.callTool({ name: "retrieve_context", arguments: { query } });
        const text = extractMcpText(result);
        return {
          content: [{ type: "text" as const, text }],
          details: { query },
        };
      },
    });

    // ── before_agent_start: inject preferences + standing tool reminder ─────
    // Calls MCP get_preferences so the engine stays behind the MCP boundary.
    pi.on("before_agent_start", async (event, ctx) => {
      // Generate new runId for this prompt (standalone mode logging)
      if (stack) {
        currentRunId = randomUUID();
        stack.logger.logEvent({
          type: "prompt_received",
          sessionId: stack.sessionId,
          runId: currentRunId,
          timestamp: Date.now(),
          text: "(pi-tui-prompt)",
          isSubagent: false,
          runKind: "core",
        } as RunEvent);
      }

      try {
        const result = await client.callTool({ name: "get_preferences", arguments: {} });
        const prefsContent = extractMcpText(result);

        const contextBlock = prefsContent
          ? `<!-- ObsidiClaw: Preferences -->\n\n${prefsContent}\n\n<!-- End ObsidiClaw Preferences -->`
          : "";

        return {
          systemPrompt:
            event.systemPrompt +
            (contextBlock ? "\n\n" + contextBlock : "") +
            "\n\n" +
            TOOL_REMINDER,
        };
      } catch {
        // Fail open — Pi still runs without injected context.
        if (ctx.hasUI) ctx.ui.setWorkingMessage();
        return;
      }
    });

    // ── Pi event logging (standalone mode only) ──────────────────────────────
    // Uses shared mapper from shared/pi-event-mapper.ts.
    if (stack) {
      const s = stack;
      const logPiEvent = (event: unknown) => {
        const mapped = mapPiEventToRunEvent(
          event as { type: string; [key: string]: unknown },
          s.sessionId,
          currentRunId,
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
          currentRunId,
        );
        if (mapped) stack.logger.logEvent(mapped);
      }
    });

    // ── session_shutdown ─────────────────────────────────────────────────────
    pi.on("session_shutdown", async () => {
      try {
        // Only queue review when this extension owns the stack (Pi TUI path).
        if (stack) {
          const jobId = randomUUID();
          const sessionId = config.sessionId ?? stack.sessionId;
          const workDir = join(paths.rootDir, ".obsidi-claw", "reviews");
          const specPath = join(workDir, `${jobId}.json`);
          const resultPath = join(workDir, `${jobId}.result.json`);
          const logPath = join(workDir, `${jobId}.log`);
          const scriptPath = join(paths.rootDir, "dist", "scripts", "run_session_review.js");

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
          stack.logger.logEvent({ type: "diagnostic", sessionId: stack.sessionId, runId: currentRunId, timestamp: Date.now(), module: "extension", level: "error", message: `session_review enqueue failed: ${err instanceof Error ? err.message : String(err)}` } as RunEvent);
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
