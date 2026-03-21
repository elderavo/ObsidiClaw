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

  /** True for subagent sessions spawned from a parent run. */
  isSubagent?: boolean;
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
  | { type: "prompt_received";     sessionId: SessionId; runId: RunId; timestamp: number; text: string; isSubagent?: boolean }
  | { type: "prompt_complete";     sessionId: SessionId; runId: RunId; timestamp: number; durationMs: number }
  | { type: "prompt_error";        sessionId: SessionId; runId: RunId; timestamp: number; error: string }

  // ── Context injection (first prompt only) ────────────────────────────────
  | { type: "context_inject_start"; sessionId: SessionId; runId: RunId; timestamp: number }
  | { type: "context_built";        sessionId: SessionId; runId: RunId; timestamp: number; noteCount: number; toolCount: number; retrievalMs: number }
  | { type: "context_inject_end";   sessionId: SessionId; runId: RunId; timestamp: number }

  // ── Pi session creation (first prompt only) ──────────────────────────────
  | { type: "pi_session_created";  sessionId: SessionId; runId: RunId; timestamp: number; contextInjected: boolean }

  // ── Context retrieval (fired by MCP server via onContextBuilt callback) ──
  | { type: "context_retrieved"; sessionId: SessionId; runId: RunId; timestamp: number; query: string; seedCount: number; expandedCount: number; toolCount: number; retrievalMs: number; rawChars: number; strippedChars: number; estimatedTokens: number }

  // ── Subagent preparation (fired by MCP server via onSubagentPrepared callback) ──
  | { type: "subagent_start"; sessionId: SessionId; runId: RunId; timestamp: number; prompt: string; plan: string; seedCount: number; expandedCount: number; estimatedTokens: number }

  // ── Agent interaction ────────────────────────────────────────────────────
  | { type: "agent_prompt_sent";   sessionId: SessionId; runId: RunId; timestamp: number }
  | { type: "agent_turn_start";    sessionId: SessionId; runId: RunId; timestamp: number }
  | { type: "agent_turn_end";      sessionId: SessionId; runId: RunId; timestamp: number }
  | { type: "agent_done";          sessionId: SessionId; runId: RunId; timestamp: number; messageCount: number }
  | { type: "tool_call";           sessionId: SessionId; runId: RunId; timestamp: number; toolName: string; toolCallId?: string; toolArgs?: unknown }
  | { type: "tool_result";         sessionId: SessionId; runId: RunId; timestamp: number; toolName: string; toolCallId?: string; isError: boolean; toolResult?: unknown };
