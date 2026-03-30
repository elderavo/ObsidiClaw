/**
 * Vault note taxonomy and frontmatter schema for "know" workspaces.
 *
 * Three note types, each with slightly different required frontmatter fields.
 * Used by: inbox linter, notetaker CLI, capture_note MCP tool.
 */

import { buildFrontmatter } from "./frontmatter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VaultNoteType = "permanent" | "synthesized" | "source";

export const VAULT_NOTE_TYPES: VaultNoteType[] = ["permanent", "synthesized", "source"];

export const NOTE_TYPE_DESCRIPTIONS: Record<VaultNoteType, string> = {
  permanent: "Permanent  — atomic concept or reference note",
  synthesized: "Synthesized  — combines or distills multiple notes",
  source: "Source  — literature note from a paper, book, or article",
};

// ---------------------------------------------------------------------------
// Frontmatter builder
// ---------------------------------------------------------------------------

/**
 * Build a YAML frontmatter block for a new vault note.
 * Includes all required fields for the given type.
 */
export function buildVaultFrontmatter(
  type: VaultNoteType,
  title: string,
  tags: string[] = [],
): string {
  const fields: Record<string, unknown> = {
    title,
    type,
    date: new Date().toISOString().slice(0, 10), // YYYY-MM-DD
    tags,
  };

  if (type === "synthesized") {
    fields.source_notes = [];
  }
  if (type === "source") {
    fields.source = "";
    fields.author = "";
  }

  return buildFrontmatter(fields);
}

// ---------------------------------------------------------------------------
// Filename helpers
// ---------------------------------------------------------------------------

/** Slugify a title for use in filenames. */
export function slugifyTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "untitled"
  );
}

/** Build an inbox filename: {ISO-timestamp}-{slug}.md */
export function buildInboxFilename(title: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${ts}-${slugifyTitle(title)}.md`;
}

/** Build the full note file content (frontmatter + title heading + body). */
export function buildNoteContent(
  type: VaultNoteType,
  title: string,
  body: string,
  tags: string[] = [],
): string {
  const fm = buildVaultFrontmatter(type, title, tags);
  const trimmedBody = body.trim();
  return fm + "\n# " + title + (trimmedBody ? "\n\n" + trimmedBody : "\n") + "\n";
}
