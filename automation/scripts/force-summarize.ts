/**
 * Force-run the code summarizer against ALL mirror notes.
 *
 * Identical to the summarize-code job but skips the staleness check —
 * every mirror file is treated as needing a (re-)summary.
 *
 * Usage:
 *   npx tsx --env-file=.env automation/scripts/force-summarize.ts
 */

import { join } from "path";
import { statSync } from "fs";
import { llmChat, isLlmReachable } from "../../core/llm-client.js";
import { loadPersonality } from "../../agents/subagent/personality-loader.js";
import { SUMMARIZE_CODE_SYSTEM_PROMPT } from "../../agents/prompts.js";
import { readText, writeText, fileExists, listDir } from "../../core/os/fs.js";
import { resolvePaths } from "../../core/config.js";

// ---------------------------------------------------------------------------
// Types (duplicated from summarize-code to keep this script self-contained)
// ---------------------------------------------------------------------------

interface MirrorEntry {
  mirrorPath: string;
  sourcePath: string;
}

interface SummarizeResult {
  summary: string;
  tags: string[];
}

const SUMMARY_HEADER = "## Summary";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const paths = resolvePaths();

  if (!await isLlmReachable()) {
    console.error("[force-summarize] LLM unreachable — check OBSIDI_LLM_HOST");
    process.exit(1);
  }

  const mirrorDir = join(paths.mdDbPath, "code");
  if (!fileExists(mirrorDir)) {
    console.error(`[force-summarize] ${mirrorDir} not found`);
    process.exit(1);
  }

  const mirrors = collectMirrorFiles(mirrorDir, paths.rootDir);
  console.log(`[force-summarize] ${mirrors.length} mirror(s) found — forcing all`);

  if (mirrors.length === 0) return;

  const personality = loadPersonality("code-summarizer", paths.personalitiesDir);
  const existingTags = collectExistingTags(paths.mdDbPath);
  console.log(`[force-summarize] ${existingTags.length} existing tags loaded`);

  let done = 0;
  let failed = 0;

  for (let i = 0; i < mirrors.length; i++) {
    const entry = mirrors[i]!;
    const label = `[${i + 1}/${mirrors.length}] ${entry.mirrorPath.split(/[\\/]/).at(-1)}`;
    process.stdout.write(`${label} ... `);

    let sourceContent: string;
    let mirrorContent: string;
    try {
      sourceContent = readText(entry.sourcePath);
      mirrorContent = readText(entry.mirrorPath);
    } catch (err) {
      console.log("SKIP (read error)");
      failed++;
      continue;
    }

    const result = await summarize(
      sourceContent,
      mirrorContent,
      existingTags,
      personality?.content,
      personality?.provider,
    );

    if (!result) {
      console.log("FAIL");
      failed++;
      continue;
    }

    writeResult(entry.mirrorPath, mirrorContent, result.summary, result.tags);
    console.log(`OK  tags=[${result.tags.join(", ")}]`);
    done++;
  }

  console.log(`\n[force-summarize] done=${done} failed=${failed}`);
}

// ---------------------------------------------------------------------------
// File collection — all mirrors, no staleness filter
// ---------------------------------------------------------------------------

function collectMirrorFiles(mirrorDir: string, rootDir: string): MirrorEntry[] {
  const results: MirrorEntry[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try { entries = listDir(dir); } catch { return; }

    for (const name of entries) {
      const full = join(dir, name);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (name.endsWith(".md")) {
          const sourcePath = resolveSourcePath(full, rootDir);
          if (!sourcePath || !fileExists(sourcePath)) continue;
          results.push({ mirrorPath: full, sourcePath });
        }
      } catch { continue; }
    }
  }

  walk(mirrorDir);
  return results;
}

function resolveSourcePath(mirrorPath: string, rootDir: string): string | null {
  let content: string;
  try { content = readText(mirrorPath); } catch { return null; }
  const match = content.match(/^---[\s\S]*?^path:\s*(.+)$/m);
  if (!match) return null;
  return join(rootDir, match[1]!.trim());
}

// ---------------------------------------------------------------------------
// Tag collection
// ---------------------------------------------------------------------------

function collectExistingTags(mdDbPath: string): string[] {
  const tagCounts = new Map<string, number>();

  function walk(dir: string): void {
    let entries: string[];
    try { entries = listDir(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (name.endsWith(".md")) extractTagsFromContent(readText(full), tagCounts);
      } catch { continue; }
    }
  }

  walk(mdDbPath);
  return [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

function extractTagsFromContent(content: string, counts: Map<string, number>): void {
  const fmMatch = content.match(/^---[\s\S]*?^tags:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (!fmMatch) return;
  for (const line of fmMatch[1]!.split("\n")) {
    const m = line.match(/^\s+-\s+(.+)/);
    if (m) {
      const tag = m[1]!.trim().toLowerCase();
      if (tag && tag !== "codeunit") counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Write summary + update tags
// ---------------------------------------------------------------------------

function writeResult(mirrorPath: string, existingContent: string, summary: string, tags: string[]): void {
  let content = updateFrontmatterTags(existingContent, tags);
  content = stripSummarySection(content).trimEnd() + `\n\n${SUMMARY_HEADER}\n\n${summary}\n`;
  writeText(mirrorPath, content);
}

function updateFrontmatterTags(content: string, newTags: string[]): string {
  const allTags = ["codeUnit", ...newTags.filter((t) => t.toLowerCase() !== "codeunit")];
  const tagBlock = "tags:\n" + allTags.map((t) => `  - ${t}`).join("\n");
  const tagsBlockRe = /^tags:\s*\n(?:\s+-\s+.+\n?)*/m;
  if (tagsBlockRe.test(content)) return content.replace(tagsBlockRe, tagBlock + "\n");
  const closeIdx = content.indexOf("\n---", 4);
  if (closeIdx !== -1) return content.slice(0, closeIdx) + "\n" + tagBlock + content.slice(closeIdx);
  return content;
}

function stripSummarySection(content: string): string {
  const idx = content.indexOf("\n## Summary");
  return idx === -1 ? content : content.slice(0, idx);
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function summarize(
  sourceContent: string,
  mirrorContent: string,
  existingTags: string[],
  systemPrompt?: string,
  providerOverride?: { model?: string; baseUrl?: string },
): Promise<SummarizeResult | null> {
  const tagList = existingTags.length > 0 ? existingTags.slice(0, 50).join(", ") : "(none yet)";

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
  ].join("\n");

  try {
    const result = await llmChat(
      [
        { role: "system", content: systemPrompt ?? SUMMARIZE_CODE_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      { model: providerOverride?.model, temperature: 0.2, numCtx: 16384, timeout: 60_000 },
    );
    return parseResponse(result.content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`\n[force-summarize] LLM error: ${msg}`);
    return null;
  }
}

function parseResponse(raw: string): SummarizeResult | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let tags: string[] = [];
  let summary = trimmed;

  const tagsMatch = trimmed.match(/^TAGS:\s*(.+)$/mi);
  if (tagsMatch) {
    tags = tagsMatch[1]!
      .split(",")
      .map((t) => t.trim().toLowerCase().replace(/\s+/g, "_"))
      .filter((t) => t.length > 0 && t !== "codeunit");
  }

  const summaryMatch = trimmed.match(/^SUMMARY:\s*([\s\S]+)$/mi);
  if (summaryMatch) {
    summary = summaryMatch[1]!.trim();
  } else if (tagsMatch) {
    summary = trimmed.replace(/^TAGS:\s*.+$/mi, "").trim();
  }

  if (!summary) return null;
  return { summary, tags };
}

main().catch((err) => { console.error(err); process.exit(1); });
