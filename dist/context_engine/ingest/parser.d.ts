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
import type { ParsedNote } from "./models.js";
export declare function parseMarkdownFile(content: string, relativePath: string): ParsedNote;
//# sourceMappingURL=parser.d.ts.map