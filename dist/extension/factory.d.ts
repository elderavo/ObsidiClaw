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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ExtensionFactory } from "@mariozechner/pi-coding-agent";
/** Engine from the standalone stack (undefined in orchestrator mode or before init). */
export declare function getSharedEngine(): import("../context_engine/context-engine.js").ContextEngine | undefined;
/** SubagentRunner from the standalone stack. */
export declare function getSharedRunner(): import("../shared/agents/subagent-runner.js").SubagentRunner | undefined;
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
export declare function createObsidiClawExtension(config?: ObsidiClawExtensionConfig): ExtensionFactory;
//# sourceMappingURL=factory.d.ts.map