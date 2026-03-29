/**
 * Pi SDK event → RunEvent mapper.
 *
 * Translates Pi SDK lifecycle events into structured RunEvents for SQLite logging.
 * Single source of truth for the Pi TUI path (entry/extension.ts).
 */

import type { RunEvent } from "../logger/types.js";

/**
 * Map a Pi SDK event to a RunEvent, or return null if the event
 * type is not one we log.
 */
export function mapPiEventToRunEvent(
  piEvent: { type: string; [key: string]: unknown },
  sessionId: string,
  runId: string,
): RunEvent | null {
  switch (piEvent.type) {
    case "agent_start":
      return { type: "agent_run_start", sessionId, runId, timestamp: Date.now() };

    case "agent_end":
      return {
        type: "agent_done",
        sessionId,
        runId,
        timestamp: Date.now(),
        messageCount: Array.isArray(piEvent["messages"]) ? (piEvent["messages"] as unknown[]).length : 0,
      };

    case "turn_end":
      return { type: "agent_turn_end", sessionId, runId, timestamp: Date.now() };

    case "tool_execution_start":
      return {
        type: "tool_call",
        sessionId,
        runId,
        timestamp: Date.now(),
        toolName: String(piEvent["toolName"] ?? "unknown"),
        toolCallId: typeof piEvent["toolCallId"] === "string" ? String(piEvent["toolCallId"]) : undefined,
        toolArgs: piEvent["args"],
      };

    case "tool_execution_end":
      return {
        type: "tool_result",
        sessionId,
        runId,
        timestamp: Date.now(),
        toolName: String(piEvent["toolName"] ?? "unknown"),
        toolCallId: typeof piEvent["toolCallId"] === "string" ? String(piEvent["toolCallId"]) : undefined,
        isError: Boolean(piEvent["isError"]),
        toolResult: piEvent["result"],
      };

    default:
      return null;
  }
}
