/**
 * summarize-code — generate a technical summary + tags for each code mirror note.
 *
 * Runs every 20 minutes via OS scheduler. For every mirror markdown under
 * md_db/code/ whose source file is newer than the mirror:
 *   1. Read the source code
 *   2. Read the mirror markdown (imports, exports, call graph)
 *   3. Send both to the code-summarizer personality with existing tag list
 *   4. Parse response for summary text + tags
 *   5. Write the summary as `## Summary` and update `tags:` in frontmatter
 *
 * Staleness is determined purely by filesystem mtime:
 *   source mtime > mirror mtime  →  needs (re-)summary
 *
 * Writing the summary updates the mirror's mtime, so the next run skips it.
 * No tracking files, no database — the filesystem IS the state.
 */

import { join } from "path";
import { statSync } from "fs";
import { llmChat, isLlmReachable } from "../../../core/llm-client.js";
import type { JobDefinition } from "../types.js";
import type { ObsidiClawPaths } from "../../../core/config.js";
import { loadPersonality, resolvePersonalityChatOptions } from "../../../agents/subagent/personality-loader.js";
import { SUMMARIZE_CODE_SYSTEM_PROMPT } from "../../../agents/prompts.js";
import { readText, writeText, fileExists, listDir } from "../../../core/os/fs.js";
import { WorkspaceRegistry } from "../../workspaces/workspace-registry.js";

const SUMMARY_HEADER = "## Summary";

// ---------------------------------------------------------------------------
// Job definition
// ---------------------------------------------------------------------------

export function createSummarizeCodeJob(intervalMinutes = 20): JobDefinition {
  return {
    name: "summarize-code",
    description: "Write AI technical summaries and tags for stale code mirror notes",
    schedule: { minutes: intervalMinutes },
    skipIfRunning: true,
    timeoutMs: 600_000,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function run(paths: ObsidiClawPaths): Promise<void> {
  if (!await isLlmReachable()) {
    console.log("[summarize-code] LLM unavailable, skipping");
    return;
  }

  const mirrorDir = join(paths.mdDbPath, "code");
  if (!fileExists(mirrorDir)) {
    console.log("[summarize-code] no md_db/code directory found, skipping");
    return;
  }

  // Load workspace registry for workspace-aware source path resolution
  let registry: WorkspaceRegistry | undefined;
  try {
    registry = new WorkspaceRegistry(paths.workspacesPath, paths.mdDbPath);
    registry.load();
  } catch {
    // Fallback: resolve all paths relative to rootDir
  }

  const mirrors = collectMirrorFiles(mirrorDir, paths.rootDir, registry);
  const stale = mirrors.filter((m) => isStale(m));

  if (stale.length === 0) {
    return;
  }

  console.log(`[summarize-code] ${stale.length} stale mirror(s)`);

  const personality = loadPersonality("code-summarizer", paths.personalitiesDir);
  const existingTags = collectExistingTags(paths.mdDbPath);

  let done = 0;
  let failed = 0;

  for (const entry of stale) {
    const sourceContent = readText(entry.sourcePath);
    const mirrorContent = readText(entry.mirrorPath);

    const result = await summarize(sourceContent, mirrorContent, existingTags, personality);
    if (!result) {
      failed++;
      continue;
    }

    writeResult(entry.mirrorPath, mirrorContent, result.summary, result.tags);
    done++;
  }

  console.log(`[summarize-code] done=${done} failed=${failed}`);
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

interface MirrorEntry {
  mirrorPath: string;
  sourcePath: string;
  sourceMtime: number;
  mirrorMtime: number;
}

function collectMirrorFiles(mirrorDir: string, rootDir: string, registry?: WorkspaceRegistry): MirrorEntry[] {
  const results: MirrorEntry[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = listDir(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      const full = join(dir, name);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (name.endsWith(".md")) {
          const sourcePath = resolveSourcePath(full, rootDir, registry);
          if (!sourcePath || !fileExists(sourcePath)) continue;
          results.push({
            mirrorPath: full,
            sourcePath,
            sourceMtime: statSync(sourcePath).mtimeMs,
            mirrorMtime: stat.mtimeMs,
          });
        }
      } catch {
        continue;
      }
    }
  }

  walk(mirrorDir);
  return results;
}

/**
 * Extract `path:` from frontmatter and resolve to an absolute source path.
 * If the note has a `workspace:` frontmatter field, look up the workspace
 * in the registry to find the correct `sourceDir`. Falls back to `rootDir`.
 */
function resolveSourcePath(mirrorPath: string, rootDir: string, registry?: WorkspaceRegistry): string | null {
  let content: string;
  try {
    content = readText(mirrorPath);
  } catch {
    return null;
  }

  const pathMatch = content.match(/^---[\s\S]*?^path:\s*(.+)$/m);
  if (!pathMatch) return null;

  const relPath = pathMatch[1].trim();

  // Try workspace-aware resolution first
  if (registry) {
    const wsMatch = content.match(/^---[\s\S]*?^workspace:\s*(.+)$/m);
    if (wsMatch) {
      const wsName = wsMatch[1].trim();
      const entry = registry.getByName(wsName);
      if (entry) {
        return join(entry.sourceDir, relPath);
      }
    }
  }

  // Fallback: resolve relative to project root (backward compat)
  return join(rootDir, relPath);
}

// ---------------------------------------------------------------------------
// Tag collection — scan md_db for all tags currently in use
// ---------------------------------------------------------------------------

function collectExistingTags(mdDbPath: string): string[] {
  const tagCounts = new Map<string, number>();

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = listDir(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      const full = join(dir, name);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (name.endsWith(".md")) {
          const content = readText(full);
          extractTagsFromContent(content, tagCounts);
        }
      } catch {
        continue;
      }
    }
  }

  walk(mdDbPath);

  // Sort by frequency descending, then alphabetically
  return [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

function extractTagsFromContent(content: string, counts: Map<string, number>): void {
  // Match YAML dash-list items under a `tags:` key in frontmatter
  const fmMatch = content.match(/^---[\s\S]*?^tags:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (!fmMatch) return;

  const lines = fmMatch[1].split("\n");
  for (const line of lines) {
    const m = line.match(/^\s+-\s+(.+)/);
    if (m) {
      const tag = m[1].trim().toLowerCase();
      if (tag && tag !== "codeunit") {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Staleness — pure mtime comparison
// ---------------------------------------------------------------------------

function isStale(entry: MirrorEntry): boolean {
  return entry.sourceMtime > entry.mirrorMtime;
}

// ---------------------------------------------------------------------------
// Write summary + update tags in frontmatter
// ---------------------------------------------------------------------------

interface SummarizeResult {
  summary: string;
  tags: string[];
}

function writeResult(mirrorPath: string, existingContent: string, summary: string, tags: string[]): void {
  // Update tags in frontmatter
  let content = updateFrontmatterTags(existingContent, tags);
  // Write/replace summary section
  content = stripSummarySection(content).trimEnd() + `\n\n${SUMMARY_HEADER}\n\n${summary}\n`;
  writeText(mirrorPath, content);
}

/**
 * Replace the `tags:` block in frontmatter with the new tag list.
 * Always keeps `codeUnit` as the first tag.
 */
// TODO: Let the linter handle this?
function updateFrontmatterTags(content: string, newTags: string[]): string {
  // Ensure codeUnit is always present and first
  const allTags = ["codeUnit", ...newTags.filter((t) => t.toLowerCase() !== "codeunit")];

  const tagBlock = "tags:\n" + allTags.map((t) => `  - ${t}`).join("\n");

  // Replace existing tags block in frontmatter
  // Match from `tags:` through all following `  - ...` lines
  const tagsBlockRe = /^tags:\s*\n(?:\s+-\s+.+\n?)*/m;
  if (tagsBlockRe.test(content)) {
    return content.replace(tagsBlockRe, tagBlock + "\n");
  }

  // No existing tags — insert before closing `---`
  const closeIdx = content.indexOf("\n---", 4);
  if (closeIdx !== -1) {
    return content.slice(0, closeIdx) + "\n" + tagBlock + content.slice(closeIdx);
  }

  return content;
}

function stripSummarySection(content: string): string {
  const idx = content.indexOf("\n## Summary");
  if (idx === -1) return content;
  return content.slice(0, idx);
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function summarize(
  sourceContent: string,
  mirrorContent: string,
  existingTags: string[],
  personality: import("../../../agents/subagent/types.js").PersonalityConfig | null,
): Promise<SummarizeResult | null> {
  const tagList = existingTags.length > 0
    ? existingTags.slice(0, 50).join(", ")
    : "(none yet)";

  const userPrompt = [
    "## Mirror Note (imports, exports, call graph)",
    mirrorContent.slice(0, 3000),
    "",
    "## Source File",
    "```",
    sourceContent.slice(0, 6000),
    "```",
    "",
    "## Existing Tags in Knowledge Base",
    tagList,
    "",
    "Respond in exactly this format:",
    "TAGS: tag1, tag2, tag3",
    "SUMMARY: Your 2-3 sentence summary here.",
    // TODO - the intent is to have all prompts live in agents/prompts such that they LIVE there - editing them there causes the actual call to be different. 
  ].join("\n");

  try {
    const result = await llmChat(
      [
        { role: "system", content: personality?.content ?? SUMMARIZE_CODE_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      {
        ...resolvePersonalityChatOptions(personality),
        timeout: 60_000,
      },
    );

    return parseResponse(result.content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[summarize-code] LLM call failed: ${msg}`);
    return null;
  }
}

/**
 * Parse the LLM response into summary + tags.
 * Expected format:
 *   TAGS: tag1, tag2, tag3
 *   SUMMARY: The summary text...
 *
 * Falls back gracefully: if no TAGS line, returns empty tags.
 * If no SUMMARY line, treats entire response as summary.
 */
function parseResponse(raw: string): SummarizeResult | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let tags: string[] = [];
  let summary = trimmed;

  // Extract TAGS line
  const tagsMatch = trimmed.match(/^TAGS:\s*(.+)$/mi);
  if (tagsMatch) {
    tags = tagsMatch[1]
      .split(",")
      .map((t) => t.trim().toLowerCase().replace(/\s+/g, "_"))
      .filter((t) => t.length > 0 && t !== "codeunit");
  }

  // Extract SUMMARY line (everything after "SUMMARY:" to end)
  const summaryMatch = trimmed.match(/^SUMMARY:\s*([\s\S]+)$/mi);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  } else if (tagsMatch) {
    // Remove the TAGS line from the response and use the rest
    summary = trimmed.replace(/^TAGS:\s*.+$/mi, "").trim();
  }

  if (!summary) return null;

  return { summary, tags };
}
