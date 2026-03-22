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
        scheduler: stack.scheduler,
        subagentRunner: stack.runner,
        persistentBackend: stack.persistentBackend,
        rootDir: paths.rootDir,
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
            try { return (await import("../scheduler/persistent-tasks.js")).listTaskSpecs(paths.rootDir); } catch { return []; }
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

    // ── Scheduler tools: forward MCP scheduler/persistent-task tools ────────
    // These tools are available when the MCP server was created with a scheduler
    // or persistent backend. We forward directly to the MCP server.
    pi.registerTool({
      name: "list_jobs",
      label: "List Scheduled Jobs",
      description: "List all scheduled jobs (in-process + persistent).",
      promptSnippet: "list_jobs() — show scheduler state",
      parameters: Type.Object({}),
      async execute() {
        try {
          const result = await client.callTool({ name: "list_jobs", arguments: {} });
          const text = extractMcpText(result);
          return { content: [{ type: "text" as const, text }], details: { tool: "list_jobs", error: "" } };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text" as const, text: `list_jobs failed: ${msg}` }], details: { tool: "list_jobs", error: msg } };
        }
      },
    });

    pi.registerTool({
      name: "run_job",
      label: "Run Job Now",
      description: "Trigger a scheduled job immediately.",
      promptSnippet: "run_job(job_name) — run a scheduler job now",
      parameters: Type.Object({
        job_name: Type.String({ description: "Job name (e.g., reindex-md-db)." }),
      }),
      async execute(_id, { job_name }) {
        try {
          const result = await client.callTool({ name: "run_job", arguments: { job_name } });
          const text = extractMcpText(result);
          return { content: [{ type: "text" as const, text }], details: { job_name, error: "" } };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text" as const, text: `run_job failed: ${msg}` }], details: { job_name, error: msg } };
        }
      },
    });

    pi.registerTool({
      name: "set_job_enabled",
      label: "Enable/Disable Job",
      description: "Enable or disable a scheduled job.",
      promptSnippet: "set_job_enabled(job_name, enabled)",
      parameters: Type.Object({
        job_name: Type.String({ description: "Job name." }),
        enabled: Type.Boolean({ description: "True to enable, false to disable." }),
      }),
      async execute(_id, { job_name, enabled }) {
        try {
          const result = await client.callTool({ name: "set_job_enabled", arguments: { job_name, enabled } });
          const text = extractMcpText(result);
          return { content: [{ type: "text" as const, text }], details: { job_name, enabled, error: "" } };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text" as const, text: `set_job_enabled failed: ${msg}` }], details: { job_name, enabled, error: msg } };
        }
      },
    });

    pi.registerTool({
      name: "schedule_task",
      label: "Schedule Persistent Task",
      description: "Register a recurring detached subagent task (persistent backend).",
      promptSnippet: "schedule_task(name, description, prompt, plan, success_criteria, interval_minutes, ...)",
      parameters: Type.Object({
        name: Type.String({ description: "Unique task name (no 'task-' prefix)." }),
        description: Type.String({ description: "What the task does." }),
        prompt: Type.String({ description: "Prompt/context sent each run." }),
        plan: Type.String({ description: "Implementation plan for the subagent." }),
        success_criteria: Type.String({ description: "How to measure success." }),
        personality: Type.Optional(Type.String({ description: "Personality name (optional)." })),
        interval_minutes: Type.Number({ description: "Interval in minutes.", minimum: 1 }),
        run_immediately: Type.Optional(Type.Boolean({ description: "Run once right now." })),
      }),
      async execute(_id, params) {
        try {
          const result = await client.callTool({ name: "schedule_task", arguments: params });
          const text = extractMcpText(result);
          return { content: [{ type: "text" as const, text }], details: { name: params.name, interval_minutes: params.interval_minutes, error: "" } };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text" as const, text: `schedule_task failed: ${msg}` }], details: { name: params.name, interval_minutes: params.interval_minutes, error: msg } };
        }
      },
    });

    pi.registerTool({
      name: "unschedule_task",
      label: "Unschedule Persistent Task",
      description: "Remove/disable a persistent task schedule (spec retained).",
      promptSnippet: "unschedule_task(name)",
      parameters: Type.Object({
        name: Type.String({ description: "Task name (without 'task-' prefix)." }),
      }),
      async execute(_id, { name }) {
        try {
          const result = await client.callTool({ name: "unschedule_task", arguments: { name } });
          const text = extractMcpText(result);
          return { content: [{ type: "text" as const, text }], details: { name, error: "" } };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text" as const, text: `unschedule_task failed: ${msg}` }], details: { name, error: msg } };
        }
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
    // Mirrors OrchestratorSession.handlePiEvent from orchestrator/session.ts.
    if (stack) {
      const s = stack; // capture for closures

      pi.on("agent_start", () => {
        s.logger.logEvent({
          type: "agent_turn_start",
          sessionId: s.sessionId,
          runId: currentRunId,
          timestamp: Date.now(),
        } as RunEvent);
      });

      pi.on("turn_end", () => {
        s.logger.logEvent({
          type: "agent_turn_end",
          sessionId: s.sessionId,
          runId: currentRunId,
          timestamp: Date.now(),
        } as RunEvent);
      });

      pi.on("tool_execution_start", (event) => {
        const e = event as unknown as Record<string, unknown>;
        s.logger.logEvent({
          type: "tool_call",
          sessionId: s.sessionId,
          runId: currentRunId,
          timestamp: Date.now(),
          toolName: String(e["toolName"] ?? "unknown"),
          toolCallId: typeof e["toolCallId"] === "string" ? String(e["toolCallId"]) : undefined,
          toolArgs: e["args"],
        } as RunEvent);
      });

      pi.on("tool_execution_end", (event) => {
        const e = event as unknown as Record<string, unknown>;
        s.logger.logEvent({
          type: "tool_result",
          sessionId: s.sessionId,
          runId: currentRunId,
          timestamp: Date.now(),
          toolName: String(e["toolName"] ?? "unknown"),
          toolCallId: typeof e["toolCallId"] === "string" ? String(e["toolCallId"]) : undefined,
          isError: Boolean(e["isError"]),
          toolResult: e["result"],
        } as RunEvent);
      });
    }

    // ── agent_end: capture transcript + log event ────────────────────────────
    pi.on("agent_end", (event) => {
      const messages = (event as unknown as { messages?: unknown[] })?.messages;
      if (Array.isArray(messages)) latestMessages = messages;

      if (stack) {
        stack.logger.logEvent({
          type: "agent_done",
          sessionId: stack.sessionId,
          runId: currentRunId,
          timestamp: Date.now(),
          messageCount: messages?.length ?? 0,
        } as RunEvent);
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
          const scriptPath = join(paths.rootDir, "dist", "scripts", "run_detached_subagent.js");

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
        console.error("[session_review] enqueue failed in extension:", err);
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
