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
import type { ContextPackage } from "../types.js";

export type OnContextBuilt = (pkg: ContextPackage) => void;

export function createContextEngineMcpServer(
  engine: ContextEngine,
  onContextBuilt?: OnContextBuilt,
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

  return server;
}
