/**
 * Enhanced link parser — extracts detailed wikilink information from markdown content.
 *
 * Builds on the existing wikilink extraction but provides richer metadata
 * including aliases, anchor links, and source context.
 */
export interface WikiLink {
    /** The target file/note being linked to */
    target: string;
    /** Display text (alias) if using [[target|alias]] syntax, null otherwise */
    alias: string | null;
    /** Anchor/section reference if using [[target#section]] syntax, null otherwise */
    anchor: string | null;
    /** Raw link text as it appears in the source */
    raw: string;
    /** Character position where link starts in the source */
    position: number;
    /** Line number where link appears (1-indexed) */
    line: number;
}
export interface ParsedLinks {
    /** All valid wikilinks found in the content */
    links: WikiLink[];
    /** Raw link texts that couldn't be parsed properly */
    malformed: string[];
}
/**
 * Extract all wikilinks from markdown content with detailed metadata.
 *
 * Handles:
 * - Basic links: [[target]]
 * - Aliased links: [[target|alias]]
 * - Anchor links: [[target#section]]
 * - Combined: [[target#section|alias]]
 * - Nested brackets (escapes them)
 * - Malformed links (reports them)
 */
export declare function parseWikiLinks(content: string, sourceFile?: string): ParsedLinks;
/**
 * Extract simple target list for backward compatibility with existing system.
 * Strips anchors and aliases to return just the target file names.
 */
export declare function extractSimpleTargets(links: WikiLink[]): string[];
/**
 * Validate wikilink syntax without parsing full structure.
 * Returns true if the link appears to be well-formed.
 */
export declare function isValidWikiLinkSyntax(linkText: string): boolean;
//# sourceMappingURL=parser.d.ts.map