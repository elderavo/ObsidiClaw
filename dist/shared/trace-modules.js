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
// ---------------------------------------------------------------------------
// Static module names
// ---------------------------------------------------------------------------
/** User — the human at the terminal. Source for prompts, target for output. */
export const USER = "user";
/** Orchestrator — session lifecycle, prompt dispatch, event routing. */
export const ORCHESTRATOR = "orchestrator";
/** Pi session — the underlying LLM agent session (pi-coding-agent SDK). */
export const PI_SESSION = "pi_session";
/** Context engine — hybrid RAG retrieval, graph expansion, review/synthesis. */
export const CONTEXT_ENGINE = "context_engine";
/** Scheduler — in-process job scheduler (setInterval-based). */
export const SCHEDULER = "scheduler";
/** Extension — MCP extension factory (both orchestrator and standalone/Pi TUI paths). */
export const EXTENSION = "extension";
/** Subagent — child agent session spawned by SubagentRunner. */
export const SUBAGENT = "subagent";
/** Insight engine — post-session review, preference proposals, note generation. */
export const INSIGHT_ENGINE = "insight_engine";
/** Logger — SQLite event persistence (runs.db). */
export const LOGGER = "logger";
// ---------------------------------------------------------------------------
// Dynamic module names
// ---------------------------------------------------------------------------
/**
 * Tool module name — dynamic, one per tool invocation.
 * Format: `tool:<name>` (e.g., `tool:bash`, `tool:retrieve_context`).
 */
export function toolModule(toolName) {
    return `tool:${toolName}`;
}
//# sourceMappingURL=trace-modules.js.map