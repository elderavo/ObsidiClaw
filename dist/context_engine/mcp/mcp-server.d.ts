/**
 * ObsidiClaw MCP server — wraps ContextEngine + JobScheduler behind MCP.
 *
 * Context tools:
 *   retrieve_context     — hybrid RAG query
 *   get_preferences      — returns preferences.md content
 *   prepare_subagent     — build context-enriched system prompt for subagents
 *   build/list/get/update_prune_* — note deduplication management
 *
 * Scheduler tools (when scheduler is provided):
 *   list_jobs            — show all scheduled jobs with state
 *   run_job              — trigger a job immediately
 *   set_job_enabled      — enable/disable a job
 *   schedule_task        — register a new recurring subagent task
 *   unschedule_task      — remove a dynamically scheduled task
 *
 * Transport-agnostic: wire via InMemoryTransport or StdioServerTransport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextEngine } from "../context-engine.js";
import type { ContextPackage, SubagentPackage } from "../types.js";
import type { JobScheduler } from "../../scheduler/scheduler.js";
import type { SubagentRunner } from "../../shared/agents/subagent-runner.js";
export type OnContextBuilt = (pkg: ContextPackage) => void;
export type OnSubagentPrepared = (pkg: SubagentPackage) => void;
export interface McpServerOptions {
    engine: ContextEngine;
    onContextBuilt?: OnContextBuilt;
    onSubagentPrepared?: OnSubagentPrepared;
    scheduler?: JobScheduler;
    subagentRunner?: SubagentRunner;
    persistentBackend?: import("../../shared/os/scheduling.js").PersistentScheduleBackend;
    rootDir?: string;
}
/**
 * @deprecated Use createContextEngineMcpServer(options: McpServerOptions) instead.
 */
export declare function createContextEngineMcpServer(engineOrOpts: ContextEngine | McpServerOptions, onContextBuilt?: OnContextBuilt, onSubagentPrepared?: OnSubagentPrepared): McpServer;
//# sourceMappingURL=mcp-server.d.ts.map