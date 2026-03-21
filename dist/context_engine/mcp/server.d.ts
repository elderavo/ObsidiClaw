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
import type { ContextEngine } from "../context-engine.js";
import type { ContextPackage } from "../types.js";
export type OnContextBuilt = (pkg: ContextPackage) => void;
export declare function createContextEngineMcpServer(engine: ContextEngine, onContextBuilt?: OnContextBuilt): McpServer;
//# sourceMappingURL=server.d.ts.map