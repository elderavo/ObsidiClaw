/**
 * Link validation utilities for detecting broken links and maintaining integrity.
 *
 * Provides tools to identify and report various link integrity issues
 * including broken wikilinks, orphaned files, and cycle detection results.
 */
import type { CycleInfo } from './graph_builder.js';
import type { LinkGraphStorage, StoredWikiLink } from './storage.js';
export interface ValidationReport {
    /** Summary statistics */
    summary: {
        totalFiles: number;
        totalLinks: number;
        validLinks: number;
        brokenLinks: number;
        orphanFiles: number;
        cyclesDetected: number;
    };
    /** Detailed broken link information */
    brokenLinks: BrokenLinkInfo[];
    /** Files with no incoming links */
    orphanFiles: string[];
    /** Detected cycles */
    cycles: CycleInfo[];
    /** Validation timestamp */
    timestamp: Date;
}
export interface BrokenLinkInfo {
    /** The broken link details */
    link: StoredWikiLink;
    /** Suggested fixes (if any can be inferred) */
    suggestions: string[];
    /** Type of issue */
    issueType: 'missing_file' | 'malformed_target' | 'invalid_anchor';
}
export interface LinkIntegrityIssue {
    /** Type of integrity issue */
    type: 'broken_link' | 'orphan_file' | 'cycle' | 'duplicate_link';
    /** Severity level */
    severity: 'error' | 'warning' | 'info';
    /** Human-readable description */
    description: string;
    /** File or files involved */
    files: string[];
    /** Additional context data */
    metadata?: any;
}
/**
 * Main validator class for link integrity checking.
 */
export declare class LinkValidator {
    private storage;
    private existingFileIds;
    constructor(storage: LinkGraphStorage, existingFileIds: Set<string>);
    /**
     * Run comprehensive validation and return detailed report.
     */
    validateAll(): Promise<ValidationReport>;
    /**
     * Analyze broken links and provide suggestions for fixes.
     */
    private analyzeBrokenLinks;
    /**
     * Generate fix suggestions for a broken link target.
     */
    private generateSuggestions;
    /**
     * Find files with similar names using simple string similarity.
     */
    private findSimilarFiles;
    /**
     * Simple string similarity using longest common subsequence ratio.
     */
    private calculateSimilarity;
    /**
     * Calculate longest common subsequence length.
     */
    private longestCommonSubsequence;
    /**
     * Classify the type of broken link issue.
     */
    private classifyBrokenLink;
    /**
     * Get all integrity issues as a flat list for easy processing.
     */
    getAllIntegrityIssues(): Promise<LinkIntegrityIssue[]>;
    /**
     * Quick health check - returns true if no critical issues found.
     */
    isLinkGraphHealthy(): Promise<boolean>;
    /**
     * Generate a human-readable validation summary.
     */
    generateSummaryReport(): Promise<string>;
}
//# sourceMappingURL=validator.d.ts.map