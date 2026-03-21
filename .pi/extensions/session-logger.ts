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
 * RunId lifecycle:
 *   A new runId is generated on the FIRST before_agent_start after session
 *   start or after the previous agent_end. This ensures one run per user
 *   prompt, not one per agent loop iteration (before_agent_start fires on
 *   every turn, including tool-call restarts within a single prompt).
 *
 * Prompt text:
 *   The Pi extension API does not expose the user's prompt text in any hook.
 *   before_agent_start receives the system prompt, not the user message.
 *   We log text: "(pi-tui)" as a sentinel so pi runs are distinguishable
 *   from orchestrator runs (which do capture prompt text).
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

  // NOTE: Main session trace logging disabled. Only subagent runs are recorded.
  const LOG_SESSION_TRACE = false;
  const logEvent = (event: Parameters<RunLogger["logEvent"]>[0]) => {
    if (!LOG_SESSION_TRACE) return;
    logger.logEvent(event);
  };

  const sessionId = randomUUID();

  // ── RunId state machine ─────────────────────────────────────────────────
  // needsNewRun starts true (session just opened). Set back to true after
  // each agent_end. before_agent_start checks it: if true, mint a new runId
  // (this is the first turn of a new user prompt); if false, this is a
  // continuation turn within the same prompt (tool-call restart).
  let currentRunId = "";
  let runStartTime = 0;
  let needsNewRun = true;

  // ── Session start ──────────────────────────────────────────────────────

  pi.on("session_start", () => {
    logEvent({ type: "session_start", sessionId, timestamp: Date.now() });
  });

  // ── Per-turn hook: before_agent_start ──────────────────────────────────
  // Fires on every agent loop iteration. Only generate a new runId on the
  // first iteration of a new user prompt.

  pi.on("before_agent_start", async () => {
    if (needsNewRun) {
      currentRunId = randomUUID();
      runStartTime = Date.now();
      needsNewRun = false;

      logEvent({
        type: "prompt_received",
        sessionId,
        runId: currentRunId,
        timestamp: Date.now(),
        text: "(pi-tui)",
        isSubagent: false,
      });

      logEvent({
        type: "agent_prompt_sent",
        sessionId,
        runId: currentRunId,
        timestamp: Date.now(),
      });
    }

    // Return undefined — do not modify system prompt
  });

  // ── Agent loop events ──────────────────────────────────────────────────

  pi.on("agent_start", () => {
    logEvent({
      type: "agent_turn_start",
      sessionId,
      runId: currentRunId,
      timestamp: Date.now(),
    });
  });

  pi.on("turn_end", () => {
    logEvent({
      type: "agent_turn_end",
      sessionId,
      runId: currentRunId,
      timestamp: Date.now(),
    });
  });

  pi.on("agent_end", (event) => {
    const messages = (event as unknown as { messages?: unknown[] })?.messages;
    const messageCount = Array.isArray(messages) ? messages.length : 0;

    logEvent({
      type: "agent_done",
      sessionId,
      runId: currentRunId,
      timestamp: Date.now(),
      messageCount,
    });

    logEvent({
      type: "prompt_complete",
      sessionId,
      runId: currentRunId,
      timestamp: Date.now(),
      durationMs: Date.now() - runStartTime,
    });

    // Next before_agent_start should start a new run
    needsNewRun = true;
  });

  // ── Tool events ────────────────────────────────────────────────────────

  pi.on("tool_execution_start", (event) => {
    const e = event as unknown as { toolName?: string; toolCallId?: string; args?: unknown };
    const toolName = String(e?.toolName ?? "unknown");

    logEvent({
      type: "tool_call",
      sessionId,
      runId: currentRunId,
      timestamp: Date.now(),
      toolName,
      toolCallId: typeof e?.toolCallId === "string" ? e.toolCallId : undefined,
      toolArgs: e?.args,
    });
  });

  pi.on("tool_execution_end", (event) => {
    const e = event as unknown as { toolName?: string; toolCallId?: string; isError?: boolean; result?: unknown };
    logEvent({
      type: "tool_result",
      sessionId,
      runId: currentRunId,
      timestamp: Date.now(),
      toolName: String(e?.toolName ?? "unknown"),
      toolCallId: typeof e?.toolCallId === "string" ? e.toolCallId : undefined,
      isError: Boolean(e?.isError),
      toolResult: e?.result,
    });
  });

  // ── Session end ────────────────────────────────────────────────────────

  pi.on("session_shutdown", () => {
    logEvent({ type: "session_end", sessionId, timestamp: Date.now() });
    logger.close();
  });
}
