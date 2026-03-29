/**
 * Maps RunEvent → structured trace fields.
 *
 * Pure function, no side effects. Used by RunLogger.logEvent() to decompose
 * domain events into the structured trace schema (source/target/action/status/phase).
 */

import type { RunEvent } from "./types.js";
import {
  USER,
  ORCHESTRATOR,
  PI_SESSION,
  CONTEXT_ENGINE,
  INSIGHT_ENGINE,
  toolModule,
  type TraceModuleOrTool,
} from "./trace-modules.js";

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export interface MappedEvent {
  source: TraceModuleOrTool;
  target?: TraceModuleOrTool;
  action: string;
  status: "started" | "returned" | "failed" | "emitted";
  phase?: "dispatch" | "retrieval" | "execution" | "review" | "logging";
  data?: Record<string, unknown>;
  summary?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

/**
 * Decompose a RunEvent into structured trace fields.
 * The common envelope (type, sessionId, runId, timestamp) is handled by the caller.
 */
export function mapRunEvent(event: RunEvent): MappedEvent {
  switch (event.type) {
    // ── Session lifecycle ──────────────────────────────────────────────────
    case "session_start":
      return { source: ORCHESTRATOR, action: "session", status: "started", phase: "dispatch" };

    case "session_end":
      return { source: ORCHESTRATOR, action: "session", status: "returned", phase: "dispatch" };

    // ── Prompt lifecycle ──────────────────────────────────────────────────
    case "prompt_received":
      return {
        source: USER, target: PI_SESSION,
        action: "prompt", status: "started", phase: "dispatch",
        data: { text: event.text },
        summary: event.text.slice(0, 120),
      };

    case "prompt_complete":
      return {
        source: PI_SESSION, target: USER,
        action: "prompt", status: "returned", phase: "dispatch",
        data: { durationMs: event.durationMs },
        summary: `completed in ${event.durationMs}ms`,
      };

    case "prompt_error":
      return {
        source: PI_SESSION,
        action: "prompt", status: "failed", phase: "dispatch",
        error: event.error,
        summary: event.error.slice(0, 120),
      };

    // ── Context retrieval (MCP tool) ──────────────────────────────────────
    case "context_retrieved":
      return {
        source: CONTEXT_ENGINE, target: toolModule("retrieve_context"),
        action: "retrieve", status: "returned", phase: "retrieval",
        data: {
          query: event.query,
          seedCount: event.seedCount,
          expandedCount: event.expandedCount,
          toolCount: event.toolCount,
          retrievalMs: event.retrievalMs,
          rawChars: event.rawChars,
          strippedChars: event.strippedChars,
          estimatedTokens: event.estimatedTokens,
          reviewMs: event.reviewMs,
          reviewSkipped: event.reviewSkipped,
          noteHits: event.noteHits,
        },
        summary: `"${event.query.slice(0, 60)}" → ${event.seedCount}+${event.expandedCount} notes in ${event.retrievalMs}ms`,
      };

    // ── Agent interaction ─────────────────────────────────────────────────
    case "agent_prompt_sent":
      return {
        source: ORCHESTRATOR, target: PI_SESSION,
        action: "agent_prompt", status: "started", phase: "execution",
      };

    case "agent_run_start":
      return {
        source: PI_SESSION,
        action: "agent_run", status: "started", phase: "execution",
      };

    case "agent_turn_end":
      return {
        source: PI_SESSION,
        action: "agent_turn", status: "returned", phase: "execution",
      };

    case "agent_done":
      return {
        source: PI_SESSION, target: ORCHESTRATOR,
        action: "agent_run", status: "returned", phase: "execution",
        data: { messageCount: event.messageCount },
        summary: `${event.messageCount} messages`,
      };

    case "tool_call":
      return {
        source: PI_SESSION, target: toolModule(event.toolName),
        action: "tool_exec", status: "started", phase: "execution",
        data: { toolName: event.toolName, toolCallId: event.toolCallId, toolArgs: event.toolArgs },
        summary: event.toolName,
      };

    case "tool_result":
      return {
        source: toolModule(event.toolName), target: PI_SESSION,
        action: "tool_exec", status: event.isError ? "failed" : "returned", phase: "execution",
        data: { toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError, toolResult: event.toolResult },
        summary: `${event.toolName}${event.isError ? " (error)" : ""}`,
        error: event.isError ? (typeof event.toolResult === "string" ? event.toolResult : JSON.stringify(event.toolResult) ?? "unknown error").slice(0, 500) : undefined,
      };

    // ── Jobs ──────────────────────────────────────────────────────────────
    case "job_start":
      return {
        source: ORCHESTRATOR,
        action: `job:${event.jobName}`, status: "started", phase: "execution",
        summary: event.jobName,
      };

    case "job_complete":
      return {
        source: ORCHESTRATOR,
        action: `job:${event.jobName}`, status: "returned", phase: "execution",
        data: { durationMs: event.durationMs },
        summary: `${event.jobName} in ${event.durationMs}ms`,
      };

    case "job_error":
      return {
        source: ORCHESTRATOR,
        action: `job:${event.jobName}`, status: "failed", phase: "execution",
        error: event.error,
        summary: `${event.jobName} failed`,
      };

    // ── Context engine debug (ce_*) ───────────────────────────────────────
    case "ce_init_start":
      return {
        source: CONTEXT_ENGINE,
        action: "engine_init", status: "started", phase: "retrieval",
        data: { path: event.path },
      };

    case "ce_init_end":
      return {
        source: CONTEXT_ENGINE,
        action: "engine_init", status: "returned", phase: "retrieval",
        data: { path: event.path, durationMs: event.durationMs, noteCount: event.noteCount },
        summary: `${event.path} path, ${event.noteCount ?? 0} notes in ${event.durationMs}ms`,
      };

    case "ce_retrieval_start":
      return {
        source: CONTEXT_ENGINE,
        action: "vector_retrieve", status: "started", phase: "retrieval",
        data: { query: event.query, topK: event.topK },
        summary: `"${event.query.slice(0, 80)}" top_k=${event.topK}`,
      };

    case "ce_vector_done":
      return {
        source: CONTEXT_ENGINE,
        action: "vector_retrieve", status: "returned", phase: "retrieval",
        data: { seedCount: event.seedCount, durationMs: event.durationMs },
        summary: `${event.seedCount} seeds in ${event.durationMs}ms`,
      };

    case "ce_graph_done":
      return {
        source: CONTEXT_ENGINE,
        action: "graph_expand", status: "returned", phase: "retrieval",
        data: { expandedCount: event.expandedCount, durationMs: event.durationMs },
        summary: `+${event.expandedCount} expanded in ${event.durationMs}ms`,
      };

    case "ce_review_start":
      return {
        source: CONTEXT_ENGINE,
        action: "synthesis", status: "started", phase: "review",
        data: { noteCount: event.noteCount, avgScore: event.avgScore },
        summary: `${event.noteCount} notes, avg=${event.avgScore.toFixed(2)}`,
      };

    case "ce_review_done":
      return {
        source: CONTEXT_ENGINE,
        action: "synthesis", status: "returned", phase: "review",
        data: { skipped: event.skipped, skipReason: event.skipReason, reviewMs: event.reviewMs, inputChars: event.inputChars, outputChars: event.outputChars },
        summary: event.skipped ? `skipped: ${event.skipReason}` : `synthesized in ${event.reviewMs}ms`,
      };

    case "ce_reindex_start":
      return {
        source: CONTEXT_ENGINE,
        action: "reindex", status: "started", phase: "retrieval",
      };

    case "ce_reindex_done":
      return {
        source: CONTEXT_ENGINE,
        action: "reindex", status: "returned", phase: "retrieval",
        data: { durationMs: event.durationMs, noteCount: event.noteCount, skipped: event.skipped },
        summary: event.skipped ? "skipped (no changes)" : `${event.noteCount} notes in ${event.durationMs}ms`,
      };

    case "ce_subprocess_log":
      return {
        source: CONTEXT_ENGINE,
        action: "subprocess_log", status: "emitted", phase: "retrieval",
        data: { message: event.message },
        summary: event.message.slice(0, 120),
      };

    // ── Session review pipeline ───────────────────────────────────────────
    case "review_started":
      return {
        source: INSIGHT_ENGINE,
        action: "session_review", status: "started", phase: "review",
        data: { trigger: event.trigger },
      };

    case "review_llm_response":
      return {
        source: INSIGHT_ENGINE,
        action: "session_review", status: "emitted", phase: "review",
        data: { rawLength: event.rawLength, parsedOk: event.parsedOk },
        summary: `${event.rawLength} chars, parsed=${event.parsedOk}`,
      };

    case "review_proposal_applied":
      return {
        source: INSIGHT_ENGINE,
        action: "session_review", status: "returned", phase: "review",
        data: { notesWritten: event.notesWritten, prefsUpdated: event.prefsUpdated },
        summary: `${event.notesWritten} notes, ${event.prefsUpdated} prefs`,
      };

    case "review_failed":
      return {
        source: INSIGHT_ENGINE,
        action: "session_review", status: "failed", phase: "review",
        error: event.error,
        summary: `failed at ${event.stage}`,
      };

    // ── Context self-grading ──────────────────────────────────────────────
    case "context_rated":
      return {
        source: USER, target: CONTEXT_ENGINE,
        action: "rate_context", status: "emitted", phase: "retrieval",
        data: { query: event.query, score: event.score, missing: event.missing, helpful: event.helpful },
        summary: `${event.score}/5 for "${event.query.slice(0, 60)}"`,
      };

    // ── Diagnostic ────────────────────────────────────────────────────────
    case "diagnostic":
      return {
        source: event.module as TraceModuleOrTool,
        action: "diagnostic", status: "emitted", phase: "logging",
        data: { level: event.level, message: event.message },
        summary: `[${event.level}] ${event.message.slice(0, 100)}`,
        error: event.level === "error" ? event.message : undefined,
      };

    default: {
      // Catch-all for any unhandled ce_subprocess_log or future event types
      const ev = event as Record<string, unknown>;
      const { type: _t, sessionId: _s, runId: _r, timestamp: _ts, ...rest } = ev;
      return {
        source: CONTEXT_ENGINE,
        action: String(ev["type"] ?? "unknown"),
        status: "emitted" as const,
        data: Object.keys(rest).length > 0 ? rest : undefined,
      };
    }
  }
}
