/**
 * Orchestrator type definitions.
 *
 * TODO: Phase 1 — migrate to shared/types.ts and shared/events.ts once stable.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Unique ID for a single pi agent session. UUIDv4. */
export type SessionId = string;

/**
 * Discriminates run type in the runs table.
 *   core      — interactive user prompt via OrchestratorSession
 *   subagent  — child agent spawned by SubagentRunner
 *   reviewer  — post-session review subagent (insight_engine)
 *   job       — scheduler job execution
 */
export type RunKind = "core" | "subagent" | "reviewer" | "job";

/**
 * Unique ID for a single prompt/response round-trip within a session.
 * A session has one or more runs (one per prompt).
 */
export type RunId = string;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Lifecycle stages within a single prompt round-trip.
 *
 * prompt_received  → prompt arrived at orchestrator
 * context_inject   → context engine running (first prompt only)
 * pi_ready         → pi session created and ready
 * agent_running    → prompt sent to agent, waiting for response
 * done             → round-trip complete
 * error            → round-trip failed
 */
export type RunStage =
  | "prompt_received"
  | "context_inject"
  | "pi_ready"
  | "agent_running"
  | "done"
  | "error";

// ---------------------------------------------------------------------------
// Session config
// ---------------------------------------------------------------------------

export interface SessionConfig {
  /** System prompt override for the pi agent. */
  systemPrompt?: string;

  /** Ollama model override. Defaults to OLLAMA_MODEL env / "llama3". */
  model?: string;

  /**
   * Called with streaming text delta from the agent.
   * Use this to print agent output in real time.
   */
  onOutput?: (delta: string) => void;

  /**
   * What kind of run this session produces. Defaults to "core".
   * @deprecated Use runKind instead of isSubagent.
   */
  isSubagent?: boolean;

  /** Discriminates run type. Defaults to "core". Takes precedence over isSubagent. */
  runKind?: RunKind;

  /** Run ID of the parent that spawned this session (for subagent/reviewer linking). */
  parentRunId?: RunId;

  /** Session ID of the parent session (for cross-session parent/child trees). */
  parentSessionId?: SessionId;
}

// ---------------------------------------------------------------------------
// Run config (single-shot compat)
// ---------------------------------------------------------------------------

export interface RunConfig extends SessionConfig {
  prompt: string;
}

// ---------------------------------------------------------------------------
// Run result (single-shot compat)
// ---------------------------------------------------------------------------

export interface RunResult {
  sessionId: SessionId;
  runId: RunId;
  stage: RunStage;
  durationMs: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Events — emitted at every interface boundary, consumed by RunLogger
//
// Convention:
//   - Session-level events: { sessionId, timestamp }
//   - Prompt-level events: { sessionId, runId, timestamp }
//
// TODO: Phase 1 — migrate to shared/events.ts as named interfaces + union
// ---------------------------------------------------------------------------

export type RunEvent =
  // ── Session lifecycle ────────────────────────────────────────────────────
  | { type: "session_start";       sessionId: SessionId; timestamp: number }
  | { type: "session_end";         sessionId: SessionId; timestamp: number }

  // ── Prompt lifecycle (one per prompt, reused across session) ─────────────
  | { type: "prompt_received";     sessionId: SessionId; runId: RunId; timestamp: number; text: string; isSubagent?: boolean; runKind?: RunKind; parentRunId?: RunId; parentSessionId?: SessionId }
  | { type: "prompt_complete";     sessionId: SessionId; runId: RunId; timestamp: number; durationMs: number }
  | { type: "prompt_error";        sessionId: SessionId; runId: RunId; timestamp: number; error: string }

  // ── Context injection (first prompt only) ────────────────────────────────
  | { type: "context_inject_start"; sessionId: SessionId; runId: RunId; timestamp: number }
  | { type: "context_built";        sessionId: SessionId; runId: RunId; timestamp: number; noteCount: number; toolCount: number; retrievalMs: number }
  | { type: "context_inject_end";   sessionId: SessionId; runId: RunId; timestamp: number }

  // ── Pi session creation (first prompt only) ──────────────────────────────
  | { type: "pi_session_created";  sessionId: SessionId; runId: RunId; timestamp: number; contextInjected: boolean }

  // ── Context retrieval (fired by MCP server via onContextBuilt callback) ──
  | { type: "context_retrieved"; sessionId: SessionId; runId: RunId; timestamp: number; query: string; seedCount: number; expandedCount: number; toolCount: number; retrievalMs: number; rawChars: number; strippedChars: number; estimatedTokens: number; reviewMs?: number; reviewSkipped?: boolean }

  // ── Subagent preparation (fired by MCP server via onSubagentPrepared callback) ──
  | { type: "subagent_start"; sessionId: SessionId; runId: RunId; timestamp: number; prompt: string; plan: string; seedCount: number; expandedCount: number; estimatedTokens: number }

  // ── Agent interaction ────────────────────────────────────────────────────
  | { type: "agent_prompt_sent";   sessionId: SessionId; runId: RunId; timestamp: number }
  | { type: "agent_turn_start";    sessionId: SessionId; runId: RunId; timestamp: number }
  | { type: "agent_turn_end";      sessionId: SessionId; runId: RunId; timestamp: number }
  | { type: "agent_done";          sessionId: SessionId; runId: RunId; timestamp: number; messageCount: number }
  | { type: "tool_call";           sessionId: SessionId; runId: RunId; timestamp: number; toolName: string; toolCallId?: string; toolArgs?: unknown }
  | { type: "tool_result";         sessionId: SessionId; runId: RunId; timestamp: number; toolName: string; toolCallId?: string; isError: boolean; toolResult?: unknown }

  // ── Scheduled job lifecycle ────────────────────────────────────────────
  | { type: "job_start";           sessionId: SessionId; timestamp: number; jobName: string; runId: string }
  | { type: "job_complete";        sessionId: SessionId; timestamp: number; jobName: string; runId: string; durationMs: number }
  | { type: "job_error";           sessionId: SessionId; timestamp: number; jobName: string; runId: string; error: string }

  // ── Context engine debug events (ce_*) ──────────────────────────────────
  // Emitted via ContextEngine.onDebug callback for full internal visibility.
  | { type: "ce_init_start";       sessionId: SessionId; runId: RunId; timestamp: number; path: "fast" | "slow" }
  | { type: "ce_init_end";         sessionId: SessionId; runId: RunId; timestamp: number; path: "fast" | "slow"; durationMs: number; noteCount?: number }
  | { type: "ce_retrieval_start";  sessionId: SessionId; runId: RunId; timestamp: number; query: string; topK: number }
  | { type: "ce_vector_done";      sessionId: SessionId; runId: RunId; timestamp: number; seedCount: number; durationMs: number }
  | { type: "ce_graph_done";       sessionId: SessionId; runId: RunId; timestamp: number; expandedCount: number; durationMs: number }
  | { type: "ce_review_start";     sessionId: SessionId; runId: RunId; timestamp: number; noteCount: number; avgScore: number }
  | { type: "ce_review_done";      sessionId: SessionId; runId: RunId; timestamp: number; skipped: boolean; skipReason?: string; reviewMs: number; inputChars: number; outputChars?: number }
  | { type: "ce_reindex_start";    sessionId: SessionId; runId: RunId; timestamp: number }
  | { type: "ce_reindex_done";     sessionId: SessionId; runId: RunId; timestamp: number; durationMs: number; noteCount: number };
