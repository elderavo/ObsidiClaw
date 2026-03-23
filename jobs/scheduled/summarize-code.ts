/**
 * summarize-code — generate a technical summary for each code mirror note.
 *
 * For every markdown file under md_db/code/ whose source file has changed
 * since the last summary was written:
 *   1. Reads the source file content
 *   2. Reads the existing mirror markdown (imports, exports, call graph)
 *   3. Sends both + the repo directory tree to Ollama
 *   4. Writes the 2-3 sentence response under "## Summary" in the mirror
 *
 * Staleness is tracked by embedding a <!-- summary_source_mtime: ... -->
 * comment inside the ## Summary section. If the source file's mtime is newer,
 * the summary is regenerated. Missing summaries are always generated.
 */

import { join } from "path";
import { statSync } from "fs";
import { llmChat, isLlmReachable } from "../../shared/llm-client.js";
import type { JobDefinition } from "../types.js";
import type { ObsidiClawPaths } from "../../shared/config.js";
import { loadPersonality } from "../../shared/agents/personality-loader.js";
import { readText, writeText, fileExists, listDir } from "../../shared/os/fs.js";
import { buildDirectoryTree } from "../../scripts/update-directory-tree.js";

const SUMMARY_HEADER = "## Summary";
const MTIME_COMMENT_RE = /<!-- summary_source_mtime: (\d+) -->/;

// ---------------------------------------------------------------------------
// Job definition
// ---------------------------------------------------------------------------

export function createSummarizeCodeJob(intervalHours = 6): JobDefinition {
  return {
    name: "summarize-code",
    description: "Write AI technical summaries for code mirror notes with stale or missing summaries",
    schedule: { hours: intervalHours },
    skipIfRunning: true,
    timeoutMs: 600_000,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function run(paths: ObsidiClawPaths): Promise<void> {
  // Early-out if LLM provider is unreachable
  if (!await isLlmReachable()) {
    console.log("[summarize-code] LLM unavailable, skipping");
    return;
  }

  const mirrorDir = join(paths.mdDbPath, "code");
  if (!fileExists(mirrorDir)) {
    console.log("[summarize-code] no md_db/code directory found, skipping");
    return;
  }

  const mirrors = collectMirrorFiles(mirrorDir, paths.rootDir);
  const stale = mirrors.filter((m) => needsSummary(m));

  if (stale.length === 0) {
    console.log("[summarize-code] all mirrors up-to-date");
    return;
  }

  console.log(`[summarize-code] summarizing ${stale.length} file(s)`);

  const personality = loadPersonality("code-summarizer", paths.personalitiesDir);
  const directoryTree = buildDirectoryTree(paths.rootDir);
  let done = 0;
  let skipped = 0;

  for (const { mirrorPath, sourcePath, sourceMtime } of stale) {
    const sourceContent = readText(sourcePath);
    const mirrorContent = readText(mirrorPath);

    const summary = await callOllama(sourceContent, mirrorContent, directoryTree, personality?.content, personality?.provider);
    if (!summary) {
      skipped++;
      continue;
    }

    writeSummary(mirrorPath, mirrorContent, summary, sourceMtime);
    done++;
  }

  console.log(`[summarize-code] done=${done} skipped=${skipped}`);
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

interface MirrorEntry {
  mirrorPath: string;
  sourcePath: string;
  /** Source file mtime in ms at the time we checked. */
  sourceMtime: number;
}

function collectMirrorFiles(mirrorDir: string, rootDir: string): MirrorEntry[] {
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
          const sourcePath = resolveSourcePath(full, rootDir);
          if (!sourcePath || !fileExists(sourcePath)) continue;
          const sourceMtime = statSync(sourcePath).mtimeMs;
          results.push({ mirrorPath: full, sourcePath, sourceMtime });
        }
      } catch {
        continue;
      }
    }
  }

  walk(mirrorDir);
  return results;
}

/** Extract `path:` from frontmatter and resolve to an absolute source path. */
function resolveSourcePath(mirrorPath: string, rootDir: string): string | null {
  let content: string;
  try {
    content = readText(mirrorPath);
  } catch {
    return null;
  }

  const match = content.match(/^---[\s\S]*?^path:\s*(.+)$/m);
  if (!match) return null;

  const relPath = match[1].trim();
  return join(rootDir, relPath);
}

// ---------------------------------------------------------------------------
// Staleness detection
// ---------------------------------------------------------------------------

/**
 * A mirror needs a (re-)summary when:
 *   - it has no ## Summary section at all, or
 *   - its embedded summary_source_mtime is older than the source file's mtime
 */
function needsSummary(entry: MirrorEntry): boolean {
  let content: string;
  try {
    content = readText(entry.mirrorPath);
  } catch {
    return true;
  }

  if (!content.includes(SUMMARY_HEADER)) return true;

  const mtimeMatch = content.match(MTIME_COMMENT_RE);
  if (!mtimeMatch) return true; // summary exists but no mtime recorded — treat as stale

  const recordedMtime = Number(mtimeMatch[1]);
  return entry.sourceMtime > recordedMtime;
}

// ---------------------------------------------------------------------------
// Summary write (replace, not append)
// ---------------------------------------------------------------------------

/**
 * Write (or replace) the ## Summary section in a mirror file.
 * Embeds the source mtime so future runs can detect staleness.
 */
function writeSummary(mirrorPath: string, existingContent: string, summary: string, sourceMtime: number): void {
  // Strip any existing ## Summary section (everything from "## Summary" to EOF
  // or to the next ## heading at the same level)
  const stripped = stripSummarySection(existingContent);
  const mtimeComment = `<!-- summary_source_mtime: ${Math.floor(sourceMtime)} -->`;
  const newContent = stripped.trimEnd() + `\n\n${SUMMARY_HEADER}\n\n${mtimeComment}\n\n${summary}\n`;
  writeText(mirrorPath, newContent);
}

/** Remove the ## Summary section from content, if present. */
function stripSummarySection(content: string): string {
  const idx = content.indexOf("\n## Summary");
  if (idx === -1) return content;
  // Keep everything before the summary header
  return content.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Ollama call
// ---------------------------------------------------------------------------

const FALLBACK_SYSTEM_PROMPT = `You are a senior software engineer writing internal documentation. Given a source code file, its structured mirror note (imports, exports, call graph), and the project directory tree, write a concise 2-3 sentence technical description of what this module does and why it exists. Be precise and technical. Write in present tense. Output only the description — no headers, no preamble, no bullet points.`;

async function callOllama(
  sourceContent: string,
  mirrorContent: string,
  directoryTree: string,
  systemPrompt?: string,
  providerOverride?: { model?: string; baseUrl?: string },
): Promise<string | null> {
  const userPrompt = [
    "## Project Directory Tree",
    directoryTree,
    "",
    "## Mirror Note (imports, exports, call graph)",
    mirrorContent.slice(0, 3000),
    "",
    "## Source File",
    "```",
    sourceContent.slice(0, 6000),
    "```",
  ].join("\n");

  try {
    const result = await llmChat(
      [
        { role: "system", content: systemPrompt ?? FALLBACK_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      {
        model: providerOverride?.model,
        temperature: 0.2,
        numCtx: 16384,
        timeout: 60_000,
      },
    );

    return result.content.trim() || null;
  } catch {
    return null;
  }
}
