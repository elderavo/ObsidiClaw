/**
 * Core event and identifier types for the ObsidiClaw logger.
 *
 * Previously lived in agents/orchestrator/types.ts alongside the headless
 * orchestrator machinery. Moved here so the logger and entry paths can import
 * types without pulling in the (now-deleted) orchestrator.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Unique ID for a single pi agent session. UUIDv4. */
export type SessionId = string;

/**
 * Correlation ID for a single prompt round-trip within a session.
 * Stored in trace.run_id as a loose grouping key — no backing table.
 */
export type RunId = string;

// ---------------------------------------------------------------------------
// Lifecycle stages
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Events — emitted at every interface boundary, consumed by RunLogger
//
// Convention:
//   - Session-level events: { sessionId, timestamp }
//   - Prompt-level events:  { sessionId, runId, timestamp }
// ---------------------------------------------------------------------------

export type RunEvent =
  // ── Session lifecycle ────────────────────────────────────────────────────
  | { type: "session_start";       sessionId: SessionId; timestamp: number }
  | { type: "session_end";         sessionId: SessionId; timestamp: number }

  // ── Prompt lifecycle (one per prompt, reused across session) ─────────────
  | { type: "prompt_received";     sessionId: SessionId; runId: RunId; timestamp: number; text: string }
  | { type: "prompt_complete";     sessionId: SessionId; runId: RunId; timestamp: number; durationMs: number }
  | { type: "prompt_error";        sessionId: SessionId; runId: RunId; timestamp: number; error: string }

  // ── Context retrieval (fired by MCP server via onContextBuilt callback) ──
  | { type: "context_retrieved"; sessionId: SessionId; runId: RunId; timestamp: number; query: string; seedCount: number; expandedCount: number; toolCount: number; retrievalMs: number; rawChars: number; strippedChars: number; estimatedTokens: number; reviewMs?: number; reviewSkipped?: boolean; noteHits?: Array<{ noteId: string; score: number; depth: number; source: string; tier?: string; noteType?: string; symbolKind?: string; edgeLabel?: string }> }

  // ── Agent interaction ────────────────────────────────────────────────────
  | { type: "agent_prompt_sent";   sessionId: SessionId; runId: RunId; timestamp: number }
  | { type: "agent_run_start";     sessionId: SessionId; runId: RunId; timestamp: number }
  | { type: "agent_turn_end";      sessionId: SessionId; runId: RunId; timestamp: number }
  | { type: "agent_done";          sessionId: SessionId; runId: RunId; timestamp: number; messageCount: number }
  | { type: "tool_call";           sessionId: SessionId; runId: RunId; timestamp: number; toolName: string; toolCallId?: string; toolArgs?: unknown }
  | { type: "tool_result";         sessionId: SessionId; runId: RunId; timestamp: number; toolName: string; toolCallId?: string; isError: boolean; toolResult?: unknown }

  // ── Scheduled job lifecycle ────────────────────────────────────────────
  | { type: "job_start";           sessionId: SessionId; timestamp: number; jobName: string; runId: string }
  | { type: "job_complete";        sessionId: SessionId; timestamp: number; jobName: string; runId: string; durationMs: number }
  | { type: "job_error";           sessionId: SessionId; timestamp: number; jobName: string; runId: string; error: string }

  // ── Automation pipeline (mirror watcher, summarizer, reindex watcher) ──
  | { type: "mirror_run_start";    sessionId: SessionId; timestamp: number; workspace: string; trigger: "file_change" | "startup" }
  | { type: "mirror_run_done";     sessionId: SessionId; timestamp: number; workspace: string; durationMs: number; tsNotesUpdated: number; pyNotesUpdated: number }
  | { type: "mirror_run_error";    sessionId: SessionId; timestamp: number; workspace: string; error: string }
  | { type: "summarizer_spawned";  sessionId: SessionId; timestamp: number; workspace: string }
  | { type: "summarizer_done";     sessionId: SessionId; timestamp: number; workspace: string; durationMs: number; exitCode: number }
  | { type: "reindex_queued";      sessionId: SessionId; timestamp: number; changedCount: number; deletedCount: number }
  | { type: "reindex_deferred";    sessionId: SessionId; timestamp: number; changedCount: number; deletedCount: number; reason: string }

  // ── Context engine debug events (ce_*) ──────────────────────────────────
  | { type: "ce_init_start";       sessionId: SessionId; runId: RunId; timestamp: number; path: "fast" | "slow" }
  | { type: "ce_init_end";         sessionId: SessionId; runId: RunId; timestamp: number; path: "fast" | "slow"; durationMs: number; noteCount?: number }
  | { type: "ce_retrieval_start";  sessionId: SessionId; runId: RunId; timestamp: number; query: string; topK: number }
  | { type: "ce_vector_done";      sessionId: SessionId; runId: RunId; timestamp: number; seedCount: number; durationMs: number }
  | { type: "ce_graph_done";       sessionId: SessionId; runId: RunId; timestamp: number; expandedCount: number; durationMs: number }
  | { type: "ce_review_start";     sessionId: SessionId; runId: RunId; timestamp: number; noteCount: number; avgScore: number }
  | { type: "ce_review_done";      sessionId: SessionId; runId: RunId; timestamp: number; skipped: boolean; skipReason?: string; reviewMs: number; inputChars: number; outputChars?: number }
  | { type: "ce_reindex_start";    sessionId: SessionId; runId: RunId; timestamp: number; path?: string }
  | { type: "ce_reindex_done";     sessionId: SessionId; runId: RunId; timestamp: number; durationMs: number; noteCount: number; skipped?: boolean }
  | { type: "ce_subprocess_log";   sessionId: SessionId; runId: RunId; timestamp: number; message: string }

  // ── Session review pipeline ──────────────────────────────────────────────
  | { type: "review_started";          sessionId: SessionId; runId: RunId; timestamp: number; trigger: string }
  | { type: "review_llm_response";     sessionId: SessionId; runId: RunId; timestamp: number; rawLength: number; parsedOk: boolean }
  | { type: "review_proposal_applied"; sessionId: SessionId; runId: RunId; timestamp: number; notesWritten: number; prefsUpdated: number }
  | { type: "review_failed";           sessionId: SessionId; runId: RunId; timestamp: number; error: string; stage: string }

  // ── Context self-grading ─────────────────────────────────────────────────
  | { type: "context_rated"; sessionId: SessionId; runId: RunId; timestamp: number; query: string; score: number; missing: string; helpful: string }

  // ── Diagnostic ───────────────────────────────────────────────────────────
  | { type: "diagnostic"; sessionId: SessionId; runId: RunId; timestamp: number; module: string; level: "info" | "warn" | "error"; message: string };
