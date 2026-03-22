/**
 * summarize-code — generate a technical summary for each code mirror note.
 *
 * For every markdown file under md_db/code/ that lacks a "## Summary" section:
 *   1. Reads the source file content
 *   2. Reads the existing mirror markdown (imports, exports, call graph)
 *   3. Sends both + the repo directory tree to Ollama
 *   4. Appends the 2-3 sentence response under "## Summary" in the mirror
 *
 * Idempotent — skips files that already have a summary.
 */

import { join } from "path";
import { statSync } from "fs";
import axios from "axios";
import type { JobDefinition } from "../types.js";
import type { ObsidiClawPaths } from "../../shared/config.js";
import { getOllamaConfig } from "../../shared/config.js";
import { readText, writeText, fileExists, listDir } from "../../shared/os/fs.js";
import { buildDirectoryTree } from "../../scripts/update-directory-tree.js";

const SUMMARY_HEADER = "## Summary";

// ---------------------------------------------------------------------------
// Job definition
// ---------------------------------------------------------------------------

export function createSummarizeCodeJob(intervalHours = 6): JobDefinition {
  return {
    name: "summarize-code",
    description: "Write AI technical summaries for unsummarized code mirror notes",
    schedule: { hours: intervalHours },
    skipIfRunning: true,
    timeoutMs: 600_000,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function run(paths: ObsidiClawPaths): Promise<void> {
  const mirrorDir = join(paths.mdDbPath, "code");
  if (!fileExists(mirrorDir)) {
    console.log("[summarize-code] no md_db/code directory found, skipping");
    return;
  }

  const mirrors = collectMirrorFiles(mirrorDir, paths.rootDir);
  const unsummarized = mirrors.filter((m) => !hasSummary(m.mirrorPath));

  if (unsummarized.length === 0) {
    console.log("[summarize-code] all mirrors already summarized");
    return;
  }

  console.log(`[summarize-code] summarizing ${unsummarized.length} file(s)`);

  const directoryTree = buildDirectoryTree(paths.rootDir);
  let done = 0;
  let skipped = 0;

  for (const { mirrorPath, sourcePath } of unsummarized) {
    if (!fileExists(sourcePath)) {
      skipped++;
      continue;
    }

    const sourceContent = readText(sourcePath);
    const mirrorContent = readText(mirrorPath);

    const summary = await callOllama(sourceContent, mirrorContent, directoryTree);
    if (!summary) {
      skipped++;
      continue;
    }

    appendSummary(mirrorPath, mirrorContent, summary);
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
          if (sourcePath) results.push({ mirrorPath: full, sourcePath });
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
// Summary check + write
// ---------------------------------------------------------------------------

function hasSummary(mirrorPath: string): boolean {
  try {
    return readText(mirrorPath).includes(SUMMARY_HEADER);
  } catch {
    return false;
  }
}

function appendSummary(mirrorPath: string, existingContent: string, summary: string): void {
  writeText(mirrorPath, existingContent.trimEnd() + `\n\n${SUMMARY_HEADER}\n\n${summary}\n`);
}

// ---------------------------------------------------------------------------
// Ollama call
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior software engineer writing internal documentation.

Given a source code file, its structured mirror note (imports, exports, call graph), and the project directory tree, write a concise 2-3 sentence technical description of what this module does and why it exists.

Focus on:
- The primary responsibility of this module
- Its architectural role in the project
- What would be missing if this file didn't exist

Be precise and technical. Write in present tense. Output only the description — no headers, no preamble, no bullet points.`;

async function callOllama(
  sourceContent: string,
  mirrorContent: string,
  directoryTree: string,
): Promise<string | null> {
  const ollama = getOllamaConfig();
  const host = ollama.baseUrl.replace(/\/v1\/?$/, "");

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
    const response = await axios.post(
      `${host}/api/chat`,
      {
        model: ollama.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        stream: false,
        options: { num_ctx: 16384, temperature: 0.2 },
      },
      { timeout: 60_000, signal: AbortSignal.timeout(60_000) },
    );

    const text = (response.data?.message?.content ?? "").trim();
    return text || null;
  } catch {
    return null;
  }
}
