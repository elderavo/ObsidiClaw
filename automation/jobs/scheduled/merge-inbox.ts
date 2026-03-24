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

import { join } from "path";
import { llmChat, isLlmReachable } from "../../../core/llm-client.js";
import { readText, writeText, fileExists } from "../../../core/os/fs.js";
import { MERGE_INBOX_SYSTEM_PROMPT } from "../../../agents/prompts.js";
import type { JobDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// Job factory
// ---------------------------------------------------------------------------

export function createMergeInboxJob(): JobDefinition {
  return {
    name: "merge-preferences-inbox",
    description: "Review preferences inbox and merge strong directives into preferences.md",
    schedule: { hours: 6 },
    skipIfRunning: true,
    timeoutMs: 120_000,
  };
}

// ---------------------------------------------------------------------------
// Core logic (used by the standalone run-merge-inbox.ts script)
// ---------------------------------------------------------------------------

export async function run(paths: import("../../../core/config.js").ObsidiClawPaths): Promise<void> {
  await mergeInbox(paths.mdDbPath);
}

export async function mergeInbox(mdDbPath: string): Promise<void> {
  const inboxPath = join(mdDbPath, "preferences_inbox.md");
  const prefsPath = join(mdDbPath, "preferences.md");

  if (!fileExists(inboxPath)) return;

  const inboxContent = readText(inboxPath);
  // Skip if inbox is just the header with no sessions
  if (!inboxContent.includes("## Session")) return;

  // Early-out if LLM provider is unreachable
  if (!await isLlmReachable()) {
    console.log("[merge-inbox] LLM unavailable, deferring");
    return;
  }

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

const SYSTEM_PROMPT = MERGE_INBOX_SYSTEM_PROMPT;

async function callOllama(inbox: string, currentPrefs: string): Promise<MergeResult | null> {
  const userPrompt = [
    "## Current preferences.md",
    currentPrefs.slice(0, 6000),
    "",
    "## Preferences Inbox (pending items)",
    inbox.slice(0, 6000),
  ].join("\n");

  const result = await llmChat(
    [
    // TODO: This is getting interpreted by the llm as everything being from the user, it should be a conversation pattern.
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    { temperature: 0.1, numCtx: 16384, timeout: 120_000 },
  );

  const raw = result.content;
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
