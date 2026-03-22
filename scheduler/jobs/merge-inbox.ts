/**
 * Merge preferences inbox → preferences.md
 *
 * Scheduled job that reads md_db/preferences_inbox.md, compares against
 * the current preferences.md, and asks Ollama which items to promote.
 * Strong items get merged, weak items get dropped, moderate items accumulate
 * until they appear in multiple sessions.
 *
 * After merging, the inbox is cleared (processed items removed).
 */

import { join, dirname } from "path";
import axios from "axios";
import { getOllamaConfig } from "../../shared/config.js";
import { readText, writeText, fileExists, ensureDir } from "../../shared/os/fs.js";
import type { JobDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// Job factory
// ---------------------------------------------------------------------------

export function createMergeInboxJob(mdDbPath: string): JobDefinition {
  return {
    name: "merge-preferences-inbox",
    description: "Review preferences inbox and merge strong directives into preferences.md",
    schedule: { hours: 6 },
    skipIfRunning: true,
    timeoutMs: 120_000,
    async execute() {
      await mergeInbox(mdDbPath);
    },
  };
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function mergeInbox(mdDbPath: string): Promise<void> {
  const inboxPath = join(mdDbPath, "preferences_inbox.md");
  const prefsPath = join(mdDbPath, "preferences.md");

  if (!fileExists(inboxPath)) return;

  const inboxContent = readText(inboxPath);
  // Skip if inbox is just the header with no sessions
  if (!inboxContent.includes("## Session")) return;

  const currentPrefs = fileExists(prefsPath) ? readText(prefsPath) : "(no preferences.md yet)";

  const result = await callOllama(inboxContent, currentPrefs);
  if (!result) return;

  if (result.additions.length === 0 && result.modifications.length === 0) {
    // Nothing to merge — clear processed items from inbox
    clearInbox(inboxPath);
    return;
  }

  // Apply changes to preferences.md
  let updatedPrefs = currentPrefs;

  for (const mod of result.modifications) {
    // Try to find and replace the section
    if (updatedPrefs.includes(mod.find)) {
      updatedPrefs = updatedPrefs.replace(mod.find, mod.replace);
    }
  }

  // Append new rules at the end (before closing ---)
  if (result.additions.length > 0) {
    const additionBlock = [
      "",
      "---",
      "",
      "## Auto-Merged Preferences",
      "",
      ...result.additions.map((a) => `- ${a.rule}\n  _(Source: ${a.evidence})_`),
      "",
    ].join("\n");

    // If there's already an Auto-Merged section, append to it
    if (updatedPrefs.includes("## Auto-Merged Preferences")) {
      const insertPoint = updatedPrefs.lastIndexOf("## Auto-Merged Preferences");
      const sectionEnd = updatedPrefs.indexOf("\n---", insertPoint + 1);
      const before = sectionEnd > -1 ? updatedPrefs.slice(0, sectionEnd) : updatedPrefs;
      const after = sectionEnd > -1 ? updatedPrefs.slice(sectionEnd) : "";
      updatedPrefs = before + "\n" + result.additions.map((a) => `- ${a.rule}\n  _(Source: ${a.evidence})_`).join("\n") + after;
    } else {
      updatedPrefs += additionBlock;
    }
  }

  writeText(prefsPath, updatedPrefs);
  clearInbox(inboxPath);
}

// ---------------------------------------------------------------------------
// Ollama call
// ---------------------------------------------------------------------------

interface MergeResult {
  additions: Array<{ rule: string; evidence: string }>;
  modifications: Array<{ find: string; replace: string; reason: string }>;
  dropped: Array<{ item: string; reason: string }>;
}

const SYSTEM_PROMPT = `You help maintain an AI agent's preferences.md file.

You receive:
1. A "preferences inbox" containing signals and synthesized preferences from recent sessions
2. The current preferences.md file

Your job:
- Decide which inbox items should be **added** to preferences.md as new rules
- Decide which inbox items should **modify** existing rules in preferences.md
- Decide which inbox items should be **dropped** (too weak, already covered, or contradictory)

Rules for promotion:
- **Strong** items: always promote (explicit user instruction)
- **Moderate** items: promote if they appear in 2+ sessions, or if they reinforce an existing preference
- **Weak** items: drop unless they form a pattern with other signals
- Never add duplicate rules — if the preference is already covered, skip it
- Never contradict existing strong preferences without noting the conflict
- Keep rules concise and actionable

Respond with JSON only:
{
  "additions": [
    { "rule": "concise rule for preferences.md", "evidence": "which session/signal this came from" }
  ],
  "modifications": [
    { "find": "exact text to find in preferences.md", "replace": "replacement text", "reason": "why" }
  ],
  "dropped": [
    { "item": "what was dropped", "reason": "why" }
  ]
}

If nothing needs to change, return {"additions": [], "modifications": [], "dropped": []}`;

async function callOllama(inbox: string, currentPrefs: string): Promise<MergeResult | null> {
  const ollama = getOllamaConfig();
  const host = ollama.baseUrl.replace(/\/v1\/?$/, "");

  const userPrompt = [
    "## Current preferences.md",
    currentPrefs.slice(0, 6000),
    "",
    "## Preferences Inbox (pending items)",
    inbox.slice(0, 6000),
  ].join("\n");

  const response = await axios.post(
    `${host}/api/chat`,
    {
      model: ollama.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      stream: false,
      options: { num_ctx: 16384, temperature: 0.1 },
    },
    { timeout: 120_000, signal: AbortSignal.timeout(120_000) },
  );

  const raw = response.data?.message?.content ?? "";
  if (!raw.trim()) return null;

  const jsonStr = extractJson(raw);
  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr) as MergeResult;
    if (!parsed.additions) parsed.additions = [];
    if (!parsed.modifications) parsed.modifications = [];
    if (!parsed.dropped) parsed.dropped = [];
    return parsed;
  } catch {
    return null;
  }
}

function extractJson(txt: string): string | null {
  try { JSON.parse(txt); return txt; } catch {}
  const match = txt.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// Inbox cleanup
// ---------------------------------------------------------------------------

function clearInbox(inboxPath: string) {
  // Keep the header, remove all session entries
  const header = `---\ntype: concept\n---\n\n# Preferences Inbox\n\nAuto-derived from session reviews. Strong items should be merged into preferences.md.\n`;
  writeText(inboxPath, header);
}
