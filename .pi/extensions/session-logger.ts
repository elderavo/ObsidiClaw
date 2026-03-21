/**
 * Session Logger Extension
 *
 * Writes all observable Pi session events to the same SQLite RunLogger that
 * the orchestrator uses. This gives `pi` TUI sessions full run/trace logging
 * identical to orchestrator-driven sessions.
 *
 * Always-on: SQLite logging fires on every session regardless of env vars.
 * Optional JSONL: Set OBSIDI_CLAW_DEBUG=1 to also write a per-session JSONL
 *   file to .obsidi-claw/debug/ for easy inspection.
 *
 * Replaces debug-logger.ts (which only captured 3 events with no SQLite
 * persistence). This extension uses the full Pi extension event API.
 *
 * Event mapping:
 *   before_agent_start (prompt) → prompt_received + agent_prompt_sent
 *   agent_start                 → agent_turn_start
 *   turn_end                    → agent_turn_end
 *   agent_end (messages)        → agent_done + prompt_complete
 *   tool_execution_start        → tool_call
 *   tool_execution_end          → tool_result
 *   session_shutdown            → session_end  (+ logger.close)
 */

import { join } from "path";
import { randomUUID } from "crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { RunLogger } from "../../logger/run-logger.js";

export default function sessionLoggerExtension(pi: ExtensionAPI) {
  const debugEnabled = ["1", "true"].includes(
    (process.env["OBSIDI_CLAW_DEBUG"] ?? "").toLowerCase(),
  );

  const dbPath = join(process.cwd(), ".obsidi-claw", "runs.db");
  const debugDir = debugEnabled
    ? join(process.cwd(), ".obsidi-claw", "debug")
    : undefined;

  const logger = new RunLogger({ dbPath, debugDir });

  // Stable session ID for this pi TUI session
  const sessionId = randomUUID();

  // Current prompt's run ID and start time — updated in before_agent_start
  let currentRunId = "";
  let runStartTime = 0;

  // ── Session start ──────────────────────────────────────────────────────────

  pi.on("session_start", () => {
    logger.logEvent({ type: "session_start", sessionId, timestamp: Date.now() });
  });

  // ── Per-prompt boundary: before_agent_start fires once per user prompt ─────
  // This is the earliest hook — generate a fresh runId here so all subsequent
  // events in this turn are attributed to the same run.

  pi.on("before_agent_start", async (event) => {
    currentRunId = randomUUID();
    runStartTime = Date.now();

    const text = (event as unknown as { prompt?: string })?.prompt ?? "";

    logger.logEvent({
      type: "prompt_received",
      sessionId,
      runId: currentRunId,
      timestamp: Date.now(),
      text,
    });

    logger.logEvent({
      type: "agent_prompt_sent",
      sessionId,
      runId: currentRunId,
      timestamp: Date.now(),
    });

    // Return undefined — do not modify system prompt
  });

  // ── Agent loop events ──────────────────────────────────────────────────────

  pi.on("agent_start", () => {
    logger.logEvent({
      type: "agent_turn_start",
      sessionId,
      runId: currentRunId,
      timestamp: Date.now(),
    });
  });

  pi.on("turn_end", () => {
    logger.logEvent({
      type: "agent_turn_end",
      sessionId,
      runId: currentRunId,
      timestamp: Date.now(),
    });
  });

  pi.on("agent_end", (event) => {
    const messages = (event as unknown as { messages?: unknown[] })?.messages;
    const messageCount = Array.isArray(messages) ? messages.length : 0;

    logger.logEvent({
      type: "agent_done",
      sessionId,
      runId: currentRunId,
      timestamp: Date.now(),
      messageCount,
    });

    logger.logEvent({
      type: "prompt_complete",
      sessionId,
      runId: currentRunId,
      timestamp: Date.now(),
      durationMs: Date.now() - runStartTime,
    });
  });

  // ── Tool events ────────────────────────────────────────────────────────────

  pi.on("tool_execution_start", (event) => {
    const toolName = String(
      (event as unknown as { toolName?: string })?.toolName ?? "unknown",
    );

    logger.logEvent({
      type: "tool_call",
      sessionId,
      runId: currentRunId,
      timestamp: Date.now(),
      toolName,
    });
  });

  pi.on("tool_execution_end", (event) => {
    const e = event as unknown as { toolName?: string; isError?: boolean };
    logger.logEvent({
      type: "tool_result",
      sessionId,
      runId: currentRunId,
      timestamp: Date.now(),
      toolName: String(e?.toolName ?? "unknown"),
      isError: Boolean(e?.isError),
    });
  });

  // ── Session end ────────────────────────────────────────────────────────────

  pi.on("session_shutdown", () => {
    logger.logEvent({ type: "session_end", sessionId, timestamp: Date.now() });
    logger.close();
  });
}
