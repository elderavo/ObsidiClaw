/**
 * Tiered code summarization library.
 *
 * Implements a bottom-up 3-pass cascade:
 *   Pass 1 — Tier-1 (symbol notes):   mirror + source file
 *   Pass 2 — Tier-2 (file notes):     mirror + source file + tier-1 child summaries
 *   Pass 3 — Tier-3 (module notes):   mirror + tier-2 child summaries (no source file)
 *
 * Tier relationships are derived from directory structure:
 *   tier-1 path:  md_db/code/{ws}/…/fileStem/symbolName.md
 *   tier-2 path:  md_db/code/{ws}/…/fileStem.md
 *   tier-3 path:  md_db/code/{ws}/…/dirName.md  (dirname(tier-2) + ".md")
 *
 * Used by:
 *   - automation/jobs/watchers/mirror-watcher.ts  (event-driven, after mirrors complete)
 */

import { join, dirname } from "path";
import { statSync } from "fs";

import { llmChat, isLlmReachable } from "../../core/llm-client.js";
import {
  loadPersonality,
  resolvePersonalityChatOptions,
} from "../../agents/personality-loader.js";
import { readText, writeText, fileExists, listDir } from "../../core/os/fs.js";
import type { WorkspaceRegistry } from "../workspaces/workspace-registry.js";
import type { PersonalityConfig } from "../../agents/types.js";

// ---------------------------------------------------------------------------
// Public config
// ---------------------------------------------------------------------------

export interface WorkspaceSummarizeConfig {
  /** md_db/code/{workspaceName} — workspace mirror output directory */
  mirrorDir: string;
  /** md_db/ root — used for collecting existing tags across all notes */
  mdDbPath: string;
  /** Source directory root for resolving `path:` frontmatter fields */
  rootDir: string;
  /** Path to workspaces.json — used by summarize-worker to load registry independently */
  workspacesPath?: string;
  registry?: WorkspaceRegistry;
  personalitiesDir: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SummarizeResult {
  summary: string;
  tags: string[];
}

type LlmOutcome =
  | { ok: true; result: SummarizeResult }
  | { ok: false; connection: boolean }; // connection=true → network error, false → bad content

interface MirrorEntry {
  mirrorPath: string;
  sourcePath: string;
  sourceMtime: number;
  mirrorMtime: number;
}

interface SummarizeOpts {
  sourceContent?: string;
  childSummaries?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUMMARY_HEADER = "## Summary";
const MAX_CHILD_SUMMARIES = 15;
const TIER1_MIRROR_TRUNCATE = 12_000;
const TIER2_MIRROR_TRUNCATE = 2000;
const SOURCE_TRUNCATE_T2 = 3000;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the tiered summarization cascade for one workspace.
 *
 * Staleness rule for tier-1/2: missing summary OR source newer than mirror.
 * The mirror watcher rewrites mirrors before calling this, so mtime-only
 * would always return false. "No summary" catches all previously unsummarized
 * notes; "source newer" catches notes whose summary predates a code change.
 *
 * Silently skips if LLM is unreachable.
 */
export async function runCascadeForWorkspace(
  config: WorkspaceSummarizeConfig,
): Promise<void> {
  if (!await isLlmReachable()) return;

  const t1Personality = loadPersonality("code-summarizer-t1", config.personalitiesDir);
  const t2Personality = loadPersonality("code-summarizer-t2", config.personalitiesDir);
  const t3Personality = loadPersonality("code-summarizer-t3", config.personalitiesDir);
  const existingTags = collectExistingTags(config.mdDbPath);

  // ── Pass 1: Tier-1 symbol notes ──────────────────────────────────────────
  const justSummarizedT1 = new Set<string>();
  const tier1Notes = collectNotesByTier(config.mirrorDir, 1, config.rootDir, config.registry);
  process.stderr.write(`[summarize] tier-1: ${tier1Notes.length} notes found\n`);
  let t1done = 0;
  let t1fail = 0;
  let connFails = 0;

  for (const entry of tier1Notes) {
    let mirrorContent: string;
    try {
      mirrorContent = readText(entry.mirrorPath);
    } catch {
      t1fail++;
      continue;
    }

    // Summarize if: no existing summary OR source is newer than mirror
    if (extractSummary(mirrorContent) && !isStale(entry)) continue;

    const outcome = await llmSummarize(
      mirrorContent.slice(0, TIER1_MIRROR_TRUNCATE),
      {},
      existingTags,
      t1Personality,
    );

    if (outcome.ok) {
      writeResult(entry.mirrorPath, mirrorContent, outcome.result.summary, outcome.result.tags);
      justSummarizedT1.add(entry.mirrorPath);
      t1done++;
      connFails = 0;
    } else {
      t1fail++;
      if (outcome.connection && ++connFails >= 2) break;
    }
  }
  process.stderr.write(`[summarize] tier-1: done=${t1done} fail=${t1fail}\n`);

  // ── Pass 2: Tier-2 file notes ─────────────────────────────────────────────
  const justSummarizedT2 = new Set<string>();
  const tier2Notes = collectNotesByTier(config.mirrorDir, 2, config.rootDir, config.registry);
  process.stderr.write(`[summarize] tier-2: ${tier2Notes.length} notes found\n`);
  let t2done = 0;
  let t2fail = 0;
  connFails = 0;

  for (const entry of tier2Notes) {
    let sourceContent: string;
    let mirrorContent: string;
    try {
      sourceContent = readText(entry.sourcePath);
      mirrorContent = readText(entry.mirrorPath);
    } catch {
      t2fail++;
      continue;
    }

    const childPaths = getTier1Children(entry.mirrorPath);
    const hasUpdatedChild = childPaths.some((c) => justSummarizedT1.has(c));

    // Summarize if: no existing summary, source is newer, or a child was just summarized
    if (extractSummary(mirrorContent) && !isStale(entry) && !hasUpdatedChild) continue;

    const childSummaries = collectChildSummaries(childPaths);
    const outcome = await llmSummarize(
      mirrorContent.slice(0, TIER2_MIRROR_TRUNCATE),
      { sourceContent: sourceContent.slice(0, SOURCE_TRUNCATE_T2), childSummaries },
      existingTags,
      t2Personality,
    );

    if (outcome.ok) {
      writeResult(entry.mirrorPath, mirrorContent, outcome.result.summary, outcome.result.tags);
      justSummarizedT2.add(entry.mirrorPath);
      t2done++;
      connFails = 0;
    } else {
      t2fail++;
      if (outcome.connection && ++connFails >= 2) break;
    }
  }
  process.stderr.write(`[summarize] tier-2: done=${t2done} fail=${t2fail}\n`);

  // ── Pass 3: Tier-3 module notes ───────────────────────────────────────────
  let t3done = 0;
  let t3fail = 0;
  connFails = 0;
  const tier3Paths = deriveTier3Paths(tier2Notes.map((e) => e.mirrorPath));

  for (const tier3Path of tier3Paths) {
    if (!fileExists(tier3Path)) continue;

    const childPaths = getTier2Children(tier3Path);
    const hasUpdatedChild = childPaths.some((c) => justSummarizedT2.has(c));

    let mirrorContent: string;
    try {
      mirrorContent = readText(tier3Path);
    } catch {
      t3fail++;
      continue;
    }

    if (extractSummary(mirrorContent) && !hasUpdatedChild) continue;

    const childSummaries = collectChildSummaries(childPaths);
    if (childSummaries.length === 0) continue;

    const outcome = await llmSummarize(
      mirrorContent,
      { childSummaries },
      existingTags,
      t3Personality,
    );

    if (outcome.ok) {
      writeResult(tier3Path, mirrorContent, outcome.result.summary, outcome.result.tags);
      t3done++;
      connFails = 0;
    } else {
      t3fail++;
      if (outcome.connection && ++connFails >= 2) break;
    }
  }
  process.stderr.write(`[summarize] tier-3: done=${t3done} fail=${t3fail}\n`);
}

// ---------------------------------------------------------------------------
// Note collection
// ---------------------------------------------------------------------------

function collectNotesByTier(
  mirrorDir: string,
  tier: 1 | 2,
  rootDir: string,
  registry?: WorkspaceRegistry,
): MirrorEntry[] {
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
          let content: string;
          try {
            content = readText(full);
          } catch {
            continue;
          }

          if (readTier(content) !== tier) continue;

          const sourcePath = resolveSourcePath(full, rootDir, content, registry);
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

/** Derive unique tier-3 paths from a list of tier-2 mirror paths. */
function deriveTier3Paths(tier2Paths: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const p of tier2Paths) {
    const t3 = tier2ToTier3(p);
    if (!seen.has(t3)) {
      seen.add(t3);
      results.push(t3);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** tier-2 → tier-3: dirname(tier2Path) + "_module.md" */
function tier2ToTier3(tier2Path: string): string {
  return dirname(tier2Path) + "_module.md";
}

/**
 * Get tier-1 child mirror paths for a tier-2 note.
 * Children live in the directory with the same stem as the tier-2 file.
 */
function getTier1Children(tier2Path: string): string[] {
  const dir = tier2Path.replace(/\.md$/, "");
  if (!fileExists(dir)) return [];
  try {
    return listDir(dir)
      .filter((n) => n.endsWith(".md"))
      .map((n) => join(dir, n))
      .filter((p) => {
        try {
          return readTier(readText(p)) === 1;
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * Get tier-2 child mirror paths for a tier-3 note.
 * Tier-3 notes live at {parent}/{dirName}_module.md; children live in {parent}/{dirName}/.
 * Filtered to tier-2 only — avoids including nested tier-3 notes.
 */
function getTier2Children(tier3Path: string): string[] {
  const dir = tier3Path.replace(/_module\.md$/, "");
  if (!fileExists(dir)) return [];
  try {
    return listDir(dir)
      .filter((n) => n.endsWith(".md"))
      .map((n) => join(dir, n))
      .filter((p) => {
        try {
          const stat = statSync(p);
          if (!stat.isFile()) return false;
          return readTier(readText(p)) === 2;
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/** Extract and label summaries from a list of mirror paths. */
function collectChildSummaries(paths: string[]): string[] {
  return paths
    .slice(0, MAX_CHILD_SUMMARIES)
    .flatMap((p) => {
      try {
        const content = readText(p);
        const summary = extractSummary(content);
        if (!summary) return [];
        const stem = p.split(/[/\\]/).at(-1)?.replace(/\.md$/, "") ?? p;
        return [`**${stem}**: ${summary}`];
      } catch {
        return [];
      }
    });
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

function readTier(content: string): number | null {
  const m = content.match(/^---[\s\S]*?^tier:\s*(\d+)/m);
  return m ? parseInt(m[1]!, 10) : null;
}

function extractSummary(content: string): string | null {
  const idx = content.indexOf(`\n${SUMMARY_HEADER}`);
  if (idx === -1) return null;
  const after = content.slice(idx + `\n${SUMMARY_HEADER}`.length).trimStart();
  return after.length > 0 ? after.trimEnd() : null;
}

function resolveSourcePath(
  mirrorPath: string,
  rootDir: string,
  content: string,
  registry?: WorkspaceRegistry,
): string | null {
  const pathMatch = content.match(/^---[\s\S]*?^path:\s*(.+)$/m);
  if (!pathMatch) return null;
  const relPath = pathMatch[1]!.trim();

  if (registry) {
    const wsMatch = content.match(/^---[\s\S]*?^workspace:\s*(.+)$/m);
    if (wsMatch) {
      const wsName = wsMatch[1]!.trim();
      const entry = registry.getByName(wsName);
      if (entry) return join(entry.sourceDir, relPath);
    }
  }

  return join(rootDir, relPath);
}

function isStale(entry: MirrorEntry): boolean {
  return entry.sourceMtime > entry.mirrorMtime;
}

// ---------------------------------------------------------------------------
// Tag collection
// ---------------------------------------------------------------------------

function collectExistingTags(mdDbPath: string): string[] {
  const tagCounts = new Map<string, number>();
  const SKIP_TAGS = new Set(["codeunit", "codesymbol", "codemodule"]);

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
          extractTagsFromContent(readText(full), tagCounts, SKIP_TAGS);
        }
      } catch {
        continue;
      }
    }
  }

  walk(mdDbPath);
  return [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

function extractTagsFromContent(
  content: string,
  counts: Map<string, number>,
  skipTags: Set<string>,
): void {
  const fmMatch = content.match(/^---[\s\S]*?^tags:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (!fmMatch) return;
  for (const line of fmMatch[1]!.split("\n")) {
    const m = line.match(/^\s+-\s+(.+)/);
    if (m) {
      const tag = m[1]!.trim().toLowerCase();
      if (tag && !skipTags.has(tag)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Write result
// ---------------------------------------------------------------------------

function writeResult(
  mirrorPath: string,
  existingContent: string,
  summary: string,
  tags: string[],
): void {
  let content = updateFrontmatterTags(existingContent, tags);
  content = stripSummarySection(content);
  // Remove the mirror-generated placeholder that appears before the summary
  content = content.replace(/\n\*Module summary not yet generated\.\*\n*/g, "\n\n");
  content = content.trimEnd() + `\n\n${SUMMARY_HEADER}\n\n${summary}\n`;
  writeText(mirrorPath, content);
}

/**
 * Replace the tags block in frontmatter with the new tags.
 * Preserves the first existing tag (the type sentinel: codeUnit / codeSymbol / codeModule).
 */
function updateFrontmatterTags(content: string, newTags: string[]): string {
  const firstTagMatch = content.match(/^---[\s\S]*?^tags:\s*\n\s+-\s+(.+)/m);
  const primaryTag = firstTagMatch ? firstTagMatch[1]!.trim() : "codeUnit";
  const allTags = [primaryTag, ...newTags.filter((t) => t.toLowerCase() !== primaryTag.toLowerCase())];
  const tagBlock = "tags:\n" + allTags.map((t) => `  - ${t}`).join("\n");

  const tagsBlockRe = /^tags:\s*\n(?:\s+-\s+.+\n?)*/m;
  if (tagsBlockRe.test(content)) return content.replace(tagsBlockRe, tagBlock + "\n");

  const closeIdx = content.indexOf("\n---", 4);
  if (closeIdx !== -1) return content.slice(0, closeIdx) + "\n" + tagBlock + content.slice(closeIdx);
  return content;
}

function stripSummarySection(content: string): string {
  const idx = content.indexOf(`\n${SUMMARY_HEADER}`);
  return idx === -1 ? content : content.slice(0, idx);
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

// Error message substrings that indicate a connection-level failure (vs. bad model output)
const CONNECTION_ERROR_PATTERNS = ["ETIMEDOUT", "ENETUNREACH", "ECONNRESET", "ECONNREFUSED", "unreachable", "canceled"];

async function llmSummarize(
  mirrorContent: string,
  opts: SummarizeOpts,
  existingTags: string[],
  personality: PersonalityConfig | null,
): Promise<LlmOutcome> {
  const tagList = existingTags.length > 0 ? existingTags.slice(0, 50).join(", ") : "(none yet)";

  const parts: string[] = ["## Mirror Note", mirrorContent];

  if (opts.sourceContent) {
    parts.push("", "## Source File", "```", opts.sourceContent, "```");
  }

  if (opts.childSummaries && opts.childSummaries.length > 0) {
    parts.push("", "## Child Summaries", opts.childSummaries.join("\n"));
  }

  parts.push(
    "",
    "## Existing Tags in Knowledge Base",
    tagList,
    "",
    "Respond in exactly this format:",
    "TAGS: tag1, tag2, tag3",
    "SUMMARY: Your summary here.",
  );

  try {
    const raw = await llmChat(
      [
        { role: "system", content: personality?.content ?? "" },
        { role: "user", content: parts.join("\n") },
      ],
      { ...resolvePersonalityChatOptions(personality), timeout: 60_000 },
    );
    const parsed = parseResponse(raw.content);
    if (parsed) return { ok: true, result: parsed };
    process.stderr.write(
      `[summarize] LLM returned unparseable response (${raw.content.length} chars). First 200: ${raw.content.slice(0, 200)}\n`,
    );
    return { ok: false, connection: false };
  } catch (err) {
    const msg = String(err);
    const isConn = CONNECTION_ERROR_PATTERNS.some((p) => msg.includes(p));
    process.stderr.write(`[summarize] LLM call failed: ${msg}\n`);
    return { ok: false, connection: isConn };
  }
}

function parseResponse(raw: string): SummarizeResult | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const SKIP_TAGS = new Set(["codeunit", "codesymbol", "codemodule"]);
  let tags: string[] = [];
  let summary = trimmed;

  const tagsMatch = trimmed.match(/^TAGS:\s*(.+)$/mi);
  if (tagsMatch) {
    tags = tagsMatch[1]!
      .split(",")
      .map((t) => t.trim().toLowerCase().replace(/\s+/g, "_"))
      .filter((t) => t.length > 0 && !SKIP_TAGS.has(t));
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
