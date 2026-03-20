/**
 * Frontmatter stripping utility for md_db notes.
 *
 * Obsidian notes commonly have YAML frontmatter (---) at the top that
 * contains metadata (tags, aliases, dates) not useful as agent context.
 * Strip it before injecting into the system prompt.
 */
/**
 * Remove YAML (--- ... ---) or TOML (+++ ... +++) frontmatter from markdown.
 * Also collapses runs of 3+ blank lines down to 2.
 */
export declare function stripFrontmatter(markdown: string): string;
/** Rough token estimate: 1 token ≈ 4 chars (OpenAI tokenizer average). */
export declare function estimateTokens(text: string): number;
//# sourceMappingURL=frontmatter.d.ts.map