/**
 * Enhanced storage layer for link graph data.
 *
 * Extends the existing SQLite schema to store detailed link information
 * including aliases, anchors, and metadata while maintaining compatibility
 * with the existing edge-based system.
 */
import type { Database as DB } from "better-sqlite3";
import type { WikiLink } from './parser.js';
import type { LinkGraph, CycleInfo } from './graph_builder.js';
export interface StoredWikiLink extends WikiLink {
    /** Source file that contains this link */
    sourceFile: string;
    /** Unique identifier for this link instance */
    linkId?: string;
}
export interface LinkValidationResult {
    /** Links that point to existing files */
    valid: StoredWikiLink[];
    /** Links that point to non-existent files */
    broken: StoredWikiLink[];
    /** Files that exist but have no incoming links */
    orphans: string[];
}
/**
 * Enhanced graph storage that extends SqliteGraphStore functionality.
 */
export declare class LinkGraphStorage {
    private db;
    constructor(db: DB);
    /**
     * Initialize enhanced schema for detailed link storage.
     *
     * Always drops and recreates the derived link tables so schema changes take
     * effect immediately. These tables are pure computed caches (rebuilt from
     * markdown on every sync), so dropping them is always safe.
     *
     * NOTE: No foreign keys on source_file/target_file — wikilink targets are
     * raw text (e.g. "network"), not resolved note_ids ("concepts/network.md").
     * Broken links must be storable for broken-link detection to work.
     */
    private initEnhancedSchema;
    /**
     * Store a complete link graph in the database.
     * This replaces all existing wikilink data for efficiency.
     */
    storeGraph(graph: LinkGraph): void;
    /**
     * Update links for a specific source file.
     * More efficient than full graph rebuild for single file changes.
     */
    updateFileLinks(sourceFile: string, links: WikiLink[]): void;
    /**
     * Get all wikilinks from a specific source file.
     */
    getLinksFromFile(sourceFile: string): StoredWikiLink[];
    /**
     * Get all wikilinks that point to a specific target file.
     */
    getLinksToFile(targetFile: string): StoredWikiLink[];
    /**
     * Validate all links against existing notes and return broken links.
     */
    validateAllLinks(): LinkValidationResult;
    /**
     * Get wikilinks with a specific target (helper method).
     */
    private getLinksWithTarget;
    /**
     * Store detected cycles in the database.
     */
    private storeCycles;
    /**
     * Get all unresolved cycles.
     */
    getDetectedCycles(): CycleInfo[];
    /**
     * Mark cycles as resolved.
     */
    markCyclesResolved(): void;
    /**
     * Get link statistics for reporting.
     */
    getLinkStats(): {
        totalLinks: number;
        uniqueTargets: number;
        filesWithLinks: number;
        brokenLinkCount: number;
        orphanCount: number;
    };
    /**
     * Clear all enhanced link data (useful for testing).
     */
    clearAllLinkData(): void;
}
//# sourceMappingURL=storage.d.ts.map