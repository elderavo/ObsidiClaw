/**
 * Canonical trace module names.
 *
 * Every trace event must use one of these as `source` or `target`.
 * This is the single source of truth for module identity in the trace system.
 *
 * Actual event producers and the modules they map to:
 *
 *   OrchestratorSession.emit()       → ORCHESTRATOR
 *   OrchestratorSession.handlePiEvent() → PI_SESSION (source), ORCHESTRATOR (target)
 *   JobScheduler.emitEvent()         → SCHEDULER
 *   ContextEngine.onDebug()          → CONTEXT_ENGINE
 *   Extension factory (standalone)   → EXTENSION
 *   SubagentRunner                   → SUBAGENT
 *   insight_engine/session_review.ts → INSIGHT_ENGINE
 *   RunLogger                        → LOGGER
 *   Tool invocations                 → tool:<name> (dynamic)
 *   User input                       → USER
 */
/** User — the human at the terminal. Source for prompts, target for output. */
export declare const USER: "user";
/** Orchestrator — session lifecycle, prompt dispatch, event routing. */
export declare const ORCHESTRATOR: "orchestrator";
/** Pi session — the underlying LLM agent session (pi-coding-agent SDK). */
export declare const PI_SESSION: "pi_session";
/** Context engine — hybrid RAG retrieval, graph expansion, review/synthesis. */
export declare const CONTEXT_ENGINE: "context_engine";
/** Scheduler — in-process job scheduler (setInterval-based). */
export declare const SCHEDULER: "scheduler";
/** Extension — MCP extension factory (both orchestrator and standalone/Pi TUI paths). */
export declare const EXTENSION: "extension";
/** Subagent — child agent session spawned by SubagentRunner. */
export declare const SUBAGENT: "subagent";
/** Insight engine — post-session review, preference proposals, note generation. */
export declare const INSIGHT_ENGINE: "insight_engine";
/** Logger — SQLite event persistence (runs.db). */
export declare const LOGGER: "logger";
/**
 * Tool module name — dynamic, one per tool invocation.
 * Format: `tool:<name>` (e.g., `tool:bash`, `tool:retrieve_context`).
 */
export declare function toolModule(toolName: string): string;
/** All valid static module names. tool:* names are dynamic and not in this union. */
export type TraceModule = typeof USER | typeof ORCHESTRATOR | typeof PI_SESSION | typeof CONTEXT_ENGINE | typeof SCHEDULER | typeof EXTENSION | typeof SUBAGENT | typeof INSIGHT_ENGINE | typeof LOGGER;
/** All valid module names including dynamic tool:* pattern. */
export type TraceModuleOrTool = TraceModule | `tool:${string}`;
//# sourceMappingURL=trace-modules.d.ts.map