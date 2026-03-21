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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ExtensionFactory } from "@mariozechner/pi-coding-agent";
export interface ObsidiClawExtensionConfig {
    /**
     * Already-built MCP server wrapping a ContextEngine (e.g. from OrchestratorSession).
     * Caller owns engine lifecycle. The extension connects/disconnects transport only.
     */
    mcpServer?: McpServer;
    /**
     * Path to the md_db directory.
     * Only used when mcpServer is not provided (standalone / Pi TUI path).
     * Defaults to process.cwd()/md_db.
     */
    mdDbPath?: string;
}
export declare function createObsidiClawExtension(config?: ObsidiClawExtensionConfig): ExtensionFactory;
//# sourceMappingURL=factory.d.ts.map