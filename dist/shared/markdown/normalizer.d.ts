/**
 * md_db normalizer — scans markdown files for formatting issues and optionally
 * auto-fixes safe inconsistencies.
 *
 * Safe auto-fixes:
 *   - Reformat frontmatter to canonical YAML (dash-list tags, consistent spacing)
 *   - Add missing `type` field inferred from path prefix
 *
 * Report-only (not auto-fixed):
 *   - Missing required frontmatter fields (tags)
 *   - Broken [[wikilinks]] (target file doesn't exist)
 *   - Malformed frontmatter (can't be parsed)
 */
export interface NormalizationIssue {
    /** Relative path from mdDbPath. */
    path: string;
    type: "missing_field" | "format_inconsistency" | "broken_link" | "malformed_frontmatter";
    description: string;
    autoFixable: boolean;
}
export interface NormalizationResult {
    /** Number of .md files scanned. */
    scanned: number;
    /** All issues found. */
    issues: NormalizationIssue[];
    /** Number of files auto-fixed (when fix: true). */
    fixed: number;
}
export interface NormalizeOptions {
    /** When true, auto-fix safe issues (frontmatter reformatting, missing type). Default: false. */
    fix?: boolean;
    /** Directory names to skip during traversal. Default: [".obsidian"]. */
    ignoredDirs?: string[];
}
/**
 * Scan md_db for formatting issues and optionally auto-fix safe ones.
 */
export declare function normalizeMdDb(mdDbPath: string, options?: NormalizeOptions): NormalizationResult;
//# sourceMappingURL=normalizer.d.ts.map