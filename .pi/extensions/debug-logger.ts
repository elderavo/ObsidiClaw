/**
 * Debug Logger Extension
 *
 * When OBSIDI_CLAW_DEBUG=1, writes all observable Pi session events to
 * .obsidi-claw/debug/pi-{sessionId}.jsonl — one JSON line per event.
 *
 * This is the Pi TUI counterpart to the orchestrator's debug toggle.
 * The orchestrator path (run.ts) writes the same format via RunLogger.
 *
 * Files from both paths land in the same directory and share the same
 * JSONL format, so they can be read/compared with the same tooling.
 *
 * Usage:
 *   OBSIDI_CLAW_DEBUG=1 pi
 */

import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function debugLoggerExtension(pi: ExtensionAPI) {
  const debugEnabled = ["1", "true"].includes(
    (process.env["OBSIDI_CLAW_DEBUG"] ?? "").toLowerCase(),
  );
  if (!debugEnabled) return;

  const debugDir = join(process.cwd(), ".obsidi-claw", "debug");
  mkdirSync(debugDir, { recursive: true });

  // Generate session ID here — Pi TUI doesn't surface one to extensions
  const sessionId = randomUUID();
  const filePath = join(debugDir, `pi-${sessionId}.jsonl`);

  function log(type: string, data: Record<string, unknown> = {}): void {
    const entry = { type, sessionId, timestamp: Date.now(), source: "pi-tui", ...data };
    appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
  }

  // Write file header so the session is identifiable without parsing JSONL
  appendFileSync(
    filePath,
    `# pi-tui  session: ${sessionId}  started: ${new Date().toISOString()}\n`,
    "utf8",
  );

  pi.on("session_start", (event) => {
    log("session_start", { raw: event ?? {} });
  });

  // before_agent_start fires on every turn — log turn boundaries + prompt snippet
  pi.on("before_agent_start", async (event) => {
    log("before_agent_start", {
      systemPromptLength: event?.systemPrompt?.length ?? 0,
    });
    // Return nothing so we don't interfere with other extensions modifying the prompt
  });

  pi.on("session_shutdown", () => {
    log("session_shutdown");
  });
}
