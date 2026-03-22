/**
 * Shared Pi event → RunEvent mapper.
 *
 * Both orchestrator/session.ts (headless path) and extension/factory.ts
 * (Pi TUI path) translate Pi SDK events into RunEvents. This module is
 * the single source of truth for that mapping.
 */

import type { RunEvent } from "../orchestrator/types.js";

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
      return { type: "agent_turn_start", sessionId, runId, timestamp: Date.now() };

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
