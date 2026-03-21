/**
 * Link Graph Infrastructure - Public API
 *
 * Pure infrastructure layer for parsing markdown wikilinks into a graph structure,
 * storing in database, and providing utilities for broken link detection and
 * loop prevention.
 */
import { type GraphStats } from './graph_builder.js';
import { type StoredWikiLink } from './storage.js';
import { type ValidationReport, type LinkIntegrityIssue } from './validator.js';
export { parseWikiLinks, extractSimpleTargets, isValidWikiLinkSyntax, type WikiLink, type ParsedLinks } from './parser.js';
export { LinkGraph, type GraphNode, type CycleInfo, type GraphStats } from './graph_builder.js';
export { LinkGraphStorage, type StoredWikiLink, type LinkValidationResult } from './storage.js';
export { LinkValidator, type ValidationReport, type BrokenLinkInfo, type LinkIntegrityIssue } from './validator.js';
/**
 * Main facade class that combines all components for easy usage.
 *
 * Example usage:
 * ```typescript
 * const processor = new LinkGraphProcessor(db, mdDbPath);
 * await processor.buildFromMarkdownFiles();
 * const report = await processor.validateLinks();
 * console.log(await processor.generateReport());
 * ```
 */
export declare class LinkGraphProcessor {
    private db;
    private mdDbPath;
    private graph;
    private storage;
    private validator;
    private existingFiles;
    constructor(db: any, mdDbPath: string);
    /**
     * Build the complete link graph from markdown files in mdDbPath.
     */
    buildFromMarkdownFiles(): Promise<void>;
    /**
     * Update links for a single file (more efficient than full rebuild).
     */
    updateFile(filePath: string): Promise<void>;
    /**
     * Validate all links and return comprehensive report.
     */
    validateLinks(): Promise<ValidationReport>;
    /**
     * Generate human-readable validation report.
     */
    generateReport(): Promise<string>;
    /**
     * Get graph statistics.
     */
    getGraphStats(): GraphStats;
    /**
     * Get all integrity issues for programmatic processing.
     */
    getIntegrityIssues(): Promise<LinkIntegrityIssue[]>;
    /**
     * Check if the link graph is healthy (no critical issues).
     */
    isHealthy(): Promise<boolean>;
    /**
     * Get links from a specific file.
     */
    getLinksFromFile(fileId: string): StoredWikiLink[];
    /**
     * Get all files that link to a specific file.
     */
    getLinksToFile(fileId: string): StoredWikiLink[];
    /**
     * Get basic link statistics.
     */
    getLinkStats(): {
        totalLinks: number;
        uniqueTargets: number;
        filesWithLinks: number;
        brokenLinkCount: number;
        orphanCount: number;
    };
    /**
     * Recursively collect all markdown files.
     */
    private collectMarkdownFiles;
}
//# sourceMappingURL=index.d.ts.map