/**
 * Token and tag normalization utilities for markdown notes.
 *
 * Used by hybrid retrieval (tag boosting), pruning (tag filtering),
 * and anywhere else that needs consistent token handling.
 */
/** Lowercase, replace non-alphanumeric runs with _, trim leading/trailing _. */
export declare function normalizeToken(value: string): string;
/** Split a string into normalized tokens on non-alphanumeric boundaries. */
export declare function normalizeTokens(value: string): string[];
/** Normalize and deduplicate a raw tag array. */
export declare function normalizeTagList(tags: string[]): string[];
/**
 * Extract and normalize tags from a frontmatter JSON string (as stored in SQLite).
 * Handles both array and comma-separated string formats.
 */
export declare function extractTags(frontmatterJson?: string | null): string[];
//# sourceMappingURL=tokens.d.ts.map