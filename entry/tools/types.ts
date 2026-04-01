import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Shared mutable state for Pi tools that proxy to MCP.
 *
 * Tools receive this object at registration time and read properties
 * at call time — so reassignments in extension.ts are visible to all tools.
 */
export interface ToolContext {
  /** MCP client — reassigned each session_start. */
  client: Client;
  /** Engine availability — set during session_start. */
  engineState: "ok" | "degraded" | "unavailable";
  /** Currently selected workspace — scopes retrieve_context by default. */
  activeWorkspace?: string;
}
