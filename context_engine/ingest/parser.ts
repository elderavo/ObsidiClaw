/**
 * Markdown file parser — converts raw file content into a ParsedNote.
 *
 * Pure function: zero I/O, fully synchronous, easily testable.
 *
 * Handles:
 *   - Frontmatter between --- delimiters (simple key: value pairs)
 *   - [[wikilink]] extraction (with [[note|alias]] alias stripping)
 *   - NoteType inference: frontmatter > path prefix > filename
 *   - Title extraction: frontmatter.title > first # heading > filename stem
 */

import { basename, extname } from "path";
import type { NoteType } from "../types.js";
import type { ParsedNote } from "./models.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseMarkdownFile(content: string, relativePath: string): ParsedNote {
  const { frontmatter, body } = splitFrontmatter(content);
  const noteType = inferNoteType(frontmatter, relativePath);
  const title = extractTitle(frontmatter, body, relativePath);
  const linksOut = extractWikilinks(body);
  const toolId =
    noteType === "tool"
      ? String(frontmatter["tool_id"] ?? stemOf(relativePath))
      : undefined;

  return {
    noteId: relativePath,
    path: relativePath,
    title,
    noteType,
    body,
    frontmatter,
    linksOut,
    toolId,
    timeCreated: stringOrUndefined(frontmatter["time_created"]),
    lastEdited: stringOrUndefined(frontmatter["last_edited"]),
  };
}

// ---------------------------------------------------------------------------
// Frontmatter extraction
// ---------------------------------------------------------------------------

function splitFrontmatter(
  content: string,
): { frontmatter: Record<string, unknown>; body: string } {
  const lines = content.split("\n");

  // Must start with --- on first non-empty line
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: content };
  }

  // Find closing ---
  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      closingIdx = i;
      break;
    }
  }

  // No closing delimiter — treat entire file as body
  if (closingIdx === -1) {
    return { frontmatter: {}, body: content };
  }

  const fmLines = lines.slice(1, closingIdx);
  const frontmatter = parseFrontmatterLines(fmLines);
  // Skip the closing --- and any single leading blank line
  const bodyLines = lines.slice(closingIdx + 1);
  const body = bodyLines.join("\n").trimStart();

  return { frontmatter, body };
}

/**
 * Simple line-by-line key: value parser.
 * Handles: `key: value`, `key:` (null), `key: ` (null).
 * Does NOT handle YAML lists, nested objects, or multiline values.
 */
function parseFrontmatterLines(lines: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx <= 0) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();
    result[key] = rawValue || null;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Wikilink extraction
// ---------------------------------------------------------------------------

/**
 * Extracts [[wikilink]] targets from body text.
 * Handles [[note|alias]] — captures only the part before the pipe.
 * Deduplicates and filters empty captures.
 */
function extractWikilinks(body: string): string[] {
  const seen = new Set<string>();
  const pattern = /\[\[([^|\]]+)(?:\|[^\]]+)?\]\]/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(body)) !== null) {
    const linkText = match[1]?.trim();
    if (linkText) seen.add(linkText);
  }

  return [...seen];
}

// ---------------------------------------------------------------------------
// NoteType inference
// ---------------------------------------------------------------------------

function inferNoteType(
  frontmatter: Record<string, unknown>,
  relativePath: string,
): NoteType {
  // 1. Frontmatter field (type takes precedence over note_type)
  for (const key of ["type", "note_type"]) {
    const val = frontmatter[key];
    if (val && typeof val === "string") {
      const normalized = val.toLowerCase().trim() as NoteType;
      if (normalized === "tool" || normalized === "concept" || normalized === "index") {
        return normalized;
      }
    }
  }

  // 2. Path prefix
  if (relativePath.startsWith("tools/")) return "tool";
  if (relativePath.startsWith("concepts/")) return "concept";

  // 3. Filename fallback
  const stem = stemOf(relativePath).toLowerCase();
  if (stem === "index") return "index";

  return "concept";
}

// ---------------------------------------------------------------------------
// Title extraction
// ---------------------------------------------------------------------------

function extractTitle(
  frontmatter: Record<string, unknown>,
  body: string,
  relativePath: string,
): string {
  // 1. frontmatter.title
  const fmTitle = frontmatter["title"];
  if (fmTitle && typeof fmTitle === "string" && fmTitle.trim()) {
    return fmTitle.trim();
  }

  // 2. First # heading in body
  const headingMatch = body.match(/^#\s+(.+)/m);
  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }

  // 3. Filename stem → title-case with spaces
  return stemOf(relativePath)
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stemOf(relativePath: string): string {
  const name = basename(relativePath);
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (value == null) return undefined;
  const s = String(value).trim();
  return s || undefined;
}
