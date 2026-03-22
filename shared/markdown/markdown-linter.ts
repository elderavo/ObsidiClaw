/**
 * Markdown linter / normalizer for md_db.
 *
 * Responsibilities:
 *   - Ensure required frontmatter fields (id/uuid, type, created, updated, tags, md_db)
 *   - Canonicalize frontmatter formatting (YAML dash lists via buildFrontmatter)
 *   - Normalize markdown body whitespace (line endings, trailing spaces, final newline)
 *   - Validate wikilinks (report-only)
 *   - Support single-file linting for watcher-driven workflows
 */

import { randomUUID } from "crypto";
import { statSync } from "fs";
import { basename, extname, join, relative } from "path";

import { parseFrontmatter, buildFrontmatter } from "./frontmatter.js";
import { extractWikilinks } from "./wikilinks.js";
import { normalizeTagList } from "./tokens.js";
import { readText, writeText, listDir } from "../os/fs.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LintIssueType =
  | "missing_field"
  | "invalid_uuid"
  | "format_inconsistency"
  | "broken_link"
  | "malformed_frontmatter";

export interface LintIssue {
  path: string; // relative to md_db
  type: LintIssueType;
  description: string;
  autoFixed: boolean;
}

export interface LintResult {
  scanned: number;
  fixed: number;
  issues: LintIssue[];
}

export interface LintOptions {
  /** When true, write fixes to disk. */
  fix?: boolean;
  /** Directories to skip (defaults: .obsidian, .obsidi-claw). */
  ignoredDirs?: string[];
}

export interface SingleFileLintOptions extends LintOptions {
  /** Optional set of known note paths (relative) for wikilink validation. */
  allNotePaths?: Set<string>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function lintMdDb(mdDbPath: string, options?: LintOptions): LintResult {
  const fix = options?.fix ?? false;
  const ignoredDirs = new Set(options?.ignoredDirs ?? [".obsidian", ".obsidi-claw"]);

  const mdFiles = collectMdFiles(mdDbPath, mdDbPath, ignoredDirs);
  const allNotePaths = new Set(mdFiles.map((f) => f.relativePath));

  let scanned = 0;
  let fixed = 0;
  const issues: LintIssue[] = [];

  for (const file of mdFiles) {
    const result = lintFile(file.absolutePath, file.relativePath, { fix, allNotePaths });
    scanned += result.scanned;
    fixed += result.fixed;
    issues.push(...result.issues);
  }

  return { scanned, fixed, issues };
}

export function lintFile(
  absolutePath: string,
  relativePath: string,
  options?: SingleFileLintOptions,
): LintResult {
  const fix = options?.fix ?? false;
  const allNotePaths = options?.allNotePaths ?? new Set<string>([relativePath]);

  let content: string;
  try {
    content = readText(absolutePath);
  } catch {
    return {
      scanned: 1,
      fixed: 0,
      issues: [
        {
          path: relativePath,
          type: "malformed_frontmatter",
          description: "Could not read file",
          autoFixed: false,
        },
      ],
    };
  }

  const originalContent = content;
  const { frontmatter, body } = parseFrontmatter(content);

  let stats: ReturnType<typeof statSync> | undefined;
  try {
    stats = statSync(absolutePath);
  } catch {
    // Best-effort; fall back to now.
  }

  const { normalizedFrontmatter, normalizedBody, issues } = normalizeFile(
    frontmatter,
    body,
    relativePath,
    stats,
    allNotePaths,
  );

  const newFrontmatterBlock = buildFrontmatter(normalizedFrontmatter);
  const bodyWithFinalNewline = ensureFinalNewline(normalizedBody);
  const newContent = newFrontmatterBlock + bodyWithFinalNewline;

  const needsWrite = fix && newContent !== originalContent;
  if (needsWrite) {
    writeText(absolutePath, newContent);
  }

  return {
    scanned: 1,
    fixed: needsWrite ? 1 : 0,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Core normalization
// ---------------------------------------------------------------------------

function normalizeFile(
  frontmatter: Record<string, unknown>,
  body: string,
  relativePath: string,
  stats: ReturnType<typeof statSync> | undefined,
  allNotePaths: Set<string>,
): {
  normalizedFrontmatter: Record<string, unknown>;
  normalizedBody: string;
  issues: LintIssue[];
} {
  const issues: LintIssue[] = [];
  const noteType = normalizeType(frontmatter["type"], relativePath);
  const normalizedTags = normalizeTags(frontmatter["tags"]);

  // UUID / ID handling
  const existingId = pickUuid(frontmatter["uuid"] ?? frontmatter["id"]);
  let noteUuid = existingId.value;
  if (!existingId.value) {
    noteUuid = randomUUID();
    issues.push({
      path: relativePath,
      type: "missing_field",
      description: "Missing id/uuid — generated new UUID",
      autoFixed: true,
    });
  } else if (!existingId.valid) {
    noteUuid = randomUUID();
    issues.push({
      path: relativePath,
      type: "invalid_uuid",
      description: "Invalid id/uuid — replaced with new UUID",
      autoFixed: true,
    });
  }

  // created/updated
  const created = normalizeTimestamp(frontmatter["created"], stats?.birthtime ?? stats?.mtime);
  if (!frontmatter["created"] || isPlaceholder(frontmatter["created"])) {
    issues.push({
      path: relativePath,
      type: "missing_field",
      description: "Missing created timestamp — filled from file birth/mtime or now",
      autoFixed: true,
    });
  }

  let updated = normalizeTimestamp(frontmatter["updated"], new Date());
  if (!frontmatter["updated"] || isPlaceholder(frontmatter["updated"])) {
    issues.push({
      path: relativePath,
      type: "missing_field",
      description: "Missing updated timestamp — set to now",
      autoFixed: true,
    });
  }

  // Markdown body normalization
  const normalizedBody = normalizeBody(body);

  // Wikilink validation (report-only)
  const links = extractWikilinks(normalizedBody);
  for (const link of links) {
    const resolved = resolveWikilink(link, allNotePaths);
    if (!resolved) {
      issues.push({
        path: relativePath,
        type: "broken_link",
        description: `Broken wikilink: [[${link}]]`,
        autoFixed: false,
      });
    }
  }

  // Preserve any extra frontmatter fields not part of the canonical set
  const canonicalKeys = new Set([
    "id",
    "uuid",
    "type",
    "created",
    "updated",
    "tags",
    "md_db",
  ]);
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!canonicalKeys.has(key)) {
      extras[key] = value;
    }
  }

  // If we made any body or frontmatter normalization, update `updated` timestamp
  const frontmatterChanged =
    !frontmatter["id"] ||
    !frontmatter["uuid"] ||
    !frontmatter["created"] ||
    isPlaceholder(frontmatter["created"]) ||
    !frontmatter["updated"] ||
    isPlaceholder(frontmatter["updated"]) ||
    !frontmatter["tags"] ||
    isPlaceholder(frontmatter["tags"]) ||
    frontmatter["type"] !== noteType;

  if (frontmatterChanged || normalizedBody !== body) {
    updated = toIsoTimestamp(new Date());
  }

  const normalizedFrontmatter: Record<string, unknown> = {
    id: noteUuid,
    uuid: noteUuid,
    type: noteType,
    created,
    updated,
    tags: normalizedTags,
    md_db: true,
    ...extras,
  };

  return { normalizedFrontmatter, normalizedBody, issues };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MdFile {
  absolutePath: string;
  relativePath: string;
}

function collectMdFiles(dir: string, rootDir: string, ignoredDirs: Set<string>): MdFile[] {
  const results: MdFile[] = [];

  let entries: string[];
  try {
    entries = listDir(dir);
  } catch {
    return results;
  }

  for (const name of entries) {
    if (ignoredDirs.has(name)) continue;
    if (name.startsWith(".")) {
      if (ignoredDirs.has(name)) continue;
    }

    const fullPath = join(dir, name);
    let isDir = false;
    try {
      // If listDir succeeds, it's a directory.
      listDir(fullPath);
      isDir = true;
    } catch {
      isDir = false;
    }

    if (isDir) {
      results.push(...collectMdFiles(fullPath, rootDir, ignoredDirs));
    } else if (extname(name) === ".md") {
      results.push({
        absolutePath: fullPath,
        relativePath: relative(rootDir, fullPath).replace(/\\/g, "/"),
      });
    }
  }

  return results;
}

function normalizeType(raw: unknown, relPath: string): string {
  if (typeof raw === "string") {
    const cleaned = stripParens(raw).trim();
    if (cleaned) return cleaned;
  }

  return inferTypeFromPath(relPath);
}

function inferTypeFromPath(relPath: string): string {
  if (relPath.startsWith("tools/")) return "tool";
  const stem = basename(relPath, ".md").toLowerCase();
  if (stem === "index") return "index";
  if (relPath.toLowerCase().includes("rule")) return "rule";
  if (relPath.toLowerCase().includes("context")) return "context";
  return "concept";
}

function normalizeTags(raw: unknown): string[] {
  const tags: string[] = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const cleaned = stripParens(String(item)).trim();
      if (cleaned) tags.push(cleaned);
    }
  } else if (typeof raw === "string") {
    const cleaned = stripParens(raw).trim();
    if (cleaned && !isPlaceholder(cleaned)) {
      const parts = cleaned.includes(",") ? cleaned.split(",") : cleaned.split(/\s+/);
      for (const part of parts) {
        const t = part.trim();
        if (t) tags.push(t);
      }
    }
  }

  return normalizeTagList(tags);
}

function pickUuid(raw: unknown): { value: string | null; valid: boolean } {
  if (typeof raw !== "string") return { value: null, valid: false };
  const cleaned = stripParens(raw).trim();
  if (!cleaned) return { value: null, valid: false };
  const valid = isUuid(cleaned);
  return { value: cleaned, valid };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeTimestamp(raw: unknown, fallbackDate?: Date): string {
  if (typeof raw === "string" && raw.trim() && !isPlaceholder(raw)) {
    return stripParens(raw).trim();
  }
  return toIsoTimestamp(fallbackDate ?? new Date());
}

function toIsoTimestamp(date: Date): string {
  return date.toISOString();
}

function isPlaceholder(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) return true;
  if (/YYYY/i.test(trimmed)) return true;
  if (/UUID/i.test(trimmed)) return true;
  if (/tag1|tag2/i.test(trimmed)) return true;
  return false;
}

function stripParens(value: string): string {
  return value.replace(/^\(\s*/, "").replace(/\s*\)$/, "");
}

function normalizeBody(body: string): string {
  let normalized = body.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n").map((line) => line.replace(/[ \t]+$/, ""));
  normalized = lines.join("\n");
  return normalized;
}

function ensureFinalNewline(body: string): string {
  if (!body.endsWith("\n")) return body + "\n";
  return body;
}

function resolveWikilink(linkText: string, allPaths: Set<string>): string | null {
  // Direct match
  if (allPaths.has(linkText)) return linkText;

  const withMd = linkText.endsWith(".md") ? linkText : `${linkText}.md`;
  if (allPaths.has(withMd)) return withMd;

  // Search for matching filename in any subdirectory
  for (const path of allPaths) {
    if (path.endsWith(`/${withMd}`) || path === withMd) return path;
  }

  return null;
}
