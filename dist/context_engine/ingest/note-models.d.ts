import type { NoteType } from "../types.js";
/**
 * A note after it has been fully parsed from disk.
 * Pure data — no I/O, no logic.
 *
 * `noteId` and `path` are intentionally the same value (the relative path
 * from md_db root, e.g. "tools/network.md"). Keeping both fields lets
 * callers be semantically precise: use `noteId` for graph identity,
 * `path` for file-system operations.
 */
export interface ParsedNote {
    /** Graph identity key. Equals the relative file path. */
    noteId: string;
    /** Relative path from md_db root, forward-slash separated. */
    path: string;
    /** Extracted from frontmatter.title, first # heading, or filename stem. */
    title: string;
    noteType: NoteType;
    /** Markdown body with frontmatter stripped. */
    body: string;
    /** Raw key/value pairs from the frontmatter block. */
    frontmatter: Record<string, unknown>;
    /**
     * Raw wikilink texts extracted from the body, e.g. ["network", "bash_core"].
     * NOT yet resolved to noteIds — resolution happens in syncMdDbToGraph.
     */
    linksOut: string[];
    /** Only set for noteType === "tool". Stem of filename or frontmatter.tool_id. */
    toolId?: string;
    /** Raw string from frontmatter.time_created. Not parsed to Date. */
    timeCreated?: string;
    /** Raw string from frontmatter.last_edited. Not parsed to Date. */
    lastEdited?: string;
}
//# sourceMappingURL=note-models.d.ts.map