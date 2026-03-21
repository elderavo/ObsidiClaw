/**
 * ObsidiClaw ExtensionFactory — MCP-backed context injection + retrieve_context tool.
 *
 * Two hooks per session:
 *
 * 1. before_agent_start (every turn):
 *    - Calls MCP get_preferences → injects preferences.md into system prompt
 *    - Appends a standing instruction reminding Pi to use retrieve_context
 *
 * 2. retrieve_context tool (Pi-driven, any number of times per turn):
 *    - Pi calls this when it wants to look something up more specifically
 *    - Proxies through MCP retrieve_context → returns formattedContext as tool result
 *    - Metrics flow via onContextBuilt callback → orchestrator RunEvent → RunLogger
 *      (the extension itself is logger-free)
 *
 * Usage (custom runner — MCP server already built):
 *   createObsidiClawExtension({ mcpServer: myMcpServer })
 *
 * Usage (Pi native TUI — .pi/extensions/):
 *   createObsidiClawExtension({ mdDbPath: "/path/to/md_db" })
 */

import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { Type } from "@sinclair/typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { ContextEngine } from "../context_engine/index.js";
import { createContextEngineMcpServer } from "../context_engine/index.js";
import { resolvePaths } from "../shared/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first text block from an MCP CallToolResult.
 * callTool() returns { [x: string]: unknown; content: ContentBlock[] } but the
 * index signature widens content to unknown in TypeScript, so we cast here.
 */
function extractText(result: unknown): string {
  const blocks = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return blocks.find((c) => c.type === "text")?.text ?? "";
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
    // ── Engine + MCP server setup ────────────────────────────────────────────
    // When no server is provided, build our own engine and server (standalone path).
    let ownedEngine: ContextEngine | undefined;
    let mcpServer: McpServer;

    const paths = resolvePaths(config.rootDir);
    const mdDbPath = config.mdDbPath ?? paths.mdDbPath;

    if (config.mcpServer) {
      mcpServer = config.mcpServer;
    } else {
      ownedEngine = new ContextEngine({
        mdDbPath,
      });
      mcpServer = createContextEngineMcpServer(ownedEngine);
    }

    // Track latest transcript (updated on agent_end) for review hook
    let latestMessages: unknown[] = [];

    // Create InMemoryTransport pair and client (connected in session_start).
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "obsidi-claw-ext", version: "1.0.0" });

    // ── session_start: initialize engine (if owned) + connect MCP pair ──────
    pi.on("session_start", async () => {
      // Ensure .obsidi-claw/ directory exists for detached workers (review, subagent)
      mkdirSync(join(paths.rootDir, ".obsidi-claw"), { recursive: true });
      if (ownedEngine) await ownedEngine.initialize();
      await mcpServer.connect(serverTransport);
      await client.connect(clientTransport);
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
        const text = extractText(result);
        return {
          content: [{ type: "text" as const, text }],
          details: { query },
        };
      },
    });

    // ── before_agent_start: inject preferences + standing tool reminder ─────
    // Calls MCP get_preferences so the engine stays behind the MCP boundary.
    pi.on("before_agent_start", async (event, ctx) => {
      try {
        const result = await client.callTool({ name: "get_preferences", arguments: {} });
        const prefsContent = extractText(result);

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

    // ── agent_end: capture transcript for session review ─────────────────────
    pi.on("agent_end", (event) => {
      const messages = (event as unknown as { messages?: unknown[] })?.messages;
      if (Array.isArray(messages)) latestMessages = messages;
    });

    // ── session_shutdown ─────────────────────────────────────────────────────
    pi.on("session_shutdown", async () => {
      try {
        // Only queue review when this extension owns the engine (pi TUI path).
        if (ownedEngine) {
          const jobId = randomUUID();
          const sessionId = config.sessionId ?? randomUUID();
          const workDir = join(paths.rootDir, ".obsidi-claw", "reviews");
          const specPath = join(workDir, `${jobId}.json`);
          const resultPath = join(workDir, `${jobId}.result.json`);
          const logPath = join(workDir, `${jobId}.log`);
          const scriptPath = join(paths.rootDir, "dist", "scripts", "run_detached_subagent.js");

          mkdirSync(workDir, { recursive: true });

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

          writeFileSync(specPath, JSON.stringify(spec, null, 2), "utf8");

          const child = spawn(process.execPath, [scriptPath, specPath], {
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
        if (ownedEngine) ownedEngine.close();
      }
    });
  };
}
