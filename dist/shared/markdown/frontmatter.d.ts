/**
 * Frontmatter parsing and building — canonical handler for YAML frontmatter
 * in markdown files throughout the system.
 *
 * Handles:
 *   - `key: value` (string)
 *   - `key:` followed by `- item` lines (array)
 *   - `key:` followed by indented `subkey: value` lines (nested object)
 *
 * Used by: context_engine/ingest, shared/agents/personality-loader, insight_engine
 */
export interface FrontmatterResult {
    /** Parsed key-value pairs from the frontmatter block. */
    frontmatter: Record<string, unknown>;
    /** Markdown body with frontmatter stripped. */
    body: string;
}
/**
 * Split markdown content into frontmatter key-values and body text.
 * Returns empty frontmatter if no valid `---` delimiters are found.
 */
export declare function parseFrontmatter(content: string): FrontmatterResult;
/**
 * Build a YAML frontmatter block from key-value pairs.
 *
 * - Strings → `key: value`
 * - Arrays → multi-line with `    - item` (4-space indent)
 * - Objects → nested with 4-space indent (`subkey: value`)
 * - null/undefined values → `key:` (empty)
 *
 * Returns the full block including `---` delimiters and trailing newline.
 */
export declare function buildFrontmatter(fields: Record<string, unknown>): string;
//# sourceMappingURL=frontmatter.d.ts.map