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
import type { ParsedNote } from "./note-models.js";
import { parseFrontmatter } from "../../shared/markdown/frontmatter.js";
import { extractWikilinks } from "../../shared/markdown/wikilinks.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseMarkdownFile(content: string, relativePath: string): ParsedNote {
  const { frontmatter, body } = parseFrontmatter(content);
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
