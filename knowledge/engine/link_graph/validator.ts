/**
 * Link validation utilities for detecting broken links and maintaining integrity.
 * 
 * Provides tools to identify and report various link integrity issues
 * including broken wikilinks, orphaned files, and cycle detection results.
 */

import type { WikiLink } from './parser.js';
import type { LinkGraph, CycleInfo } from './graph_builder.js';
import type { LinkGraphStorage, StoredWikiLink, LinkValidationResult } from './storage.js';

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
export class LinkValidator {
  constructor(
    private storage: LinkGraphStorage,
    private existingFileIds: Set<string>
  ) {}
  
  /**
   * Run comprehensive validation and return detailed report.
   */
  async validateAll(): Promise<ValidationReport> {
    const timestamp = new Date();
    
    // Get validation results from storage
    const validationResult = this.storage.validateAllLinks();
    const cycles = this.storage.getDetectedCycles();
    const stats = this.storage.getLinkStats();
    
    // Analyze broken links for suggestions
    const brokenLinks = await this.analyzeBrokenLinks(validationResult.broken);
    
    return {
      summary: {
        totalFiles: this.existingFileIds.size,
        totalLinks: stats.totalLinks,
        validLinks: validationResult.valid.length,
        brokenLinks: validationResult.broken.length,
        orphanFiles: validationResult.orphans.length,
        cyclesDetected: cycles.length
      },
      brokenLinks,
      orphanFiles: validationResult.orphans,
      cycles,
      timestamp
    };
  }
  
  /**
   * Analyze broken links and provide suggestions for fixes.
   */
  private async analyzeBrokenLinks(brokenLinks: StoredWikiLink[]): Promise<BrokenLinkInfo[]> {
    const results: BrokenLinkInfo[] = [];
    
    for (const link of brokenLinks) {
      const suggestions = this.generateSuggestions(link.target);
      const issueType = this.classifyBrokenLink(link);
      
      results.push({
        link,
        suggestions,
        issueType
      });
    }
    
    return results;
  }
  
  /**
   * Generate fix suggestions for a broken link target.
   */
  private generateSuggestions(target: string): string[] {
    const suggestions: string[] = [];
    
    // Try with .md extension if missing
    if (!target.endsWith('.md')) {
      const withExtension = `${target}.md`;
      if (this.existingFileIds.has(withExtension)) {
        suggestions.push(withExtension);
      }
    }
    
    // Try without .md extension if present
    if (target.endsWith('.md')) {
      const withoutExtension = target.slice(0, -3);
      if (this.existingFileIds.has(withoutExtension)) {
        suggestions.push(withoutExtension);
      }
    }
    
    // Fuzzy matching for similar file names
    const fuzzyMatches = this.findSimilarFiles(target);
    suggestions.push(...fuzzyMatches);
    
    return [...new Set(suggestions)]; // Deduplicate
  }
  
  /**
   * Find files with similar names using simple string similarity.
   */
  private findSimilarFiles(target: string, maxSuggestions: number = 3): string[] {
    const normalizedTarget = target.toLowerCase().replace(/[^a-z0-9]/g, '');
    const candidates: Array<{ file: string; score: number }> = [];
    
    for (const fileId of this.existingFileIds) {
      const normalizedFile = fileId.toLowerCase().replace(/[^a-z0-9]/g, '');
      const score = this.calculateSimilarity(normalizedTarget, normalizedFile);
      
      if (score > 0.6) { // Arbitrary threshold for similarity
        candidates.push({ file: fileId, score });
      }
    }
    
    // Sort by similarity score and return top matches
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, maxSuggestions).map(c => c.file);
  }
  
  /**
   * Simple string similarity using longest common subsequence ratio.
   */
  private calculateSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1.0;
    if (str1.length === 0 || str2.length === 0) return 0.0;
    
    const lcs = this.longestCommonSubsequence(str1, str2);
    const maxLength = Math.max(str1.length, str2.length);
    return lcs / maxLength;
  }
  
  /**
   * Calculate longest common subsequence length.
   */
  private longestCommonSubsequence(str1: string, str2: string): number {
    const m = str1.length;
    const n = str2.length;
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }
    
    return dp[m][n];
  }
  
  /**
   * Classify the type of broken link issue.
   */
  private classifyBrokenLink(link: StoredWikiLink): 'missing_file' | 'malformed_target' | 'invalid_anchor' {
    // Check if it's an anchor link to an existing file
    if (link.anchor) {
      const baseTarget = link.target;
      if (this.existingFileIds.has(baseTarget) || this.existingFileIds.has(`${baseTarget}.md`)) {
        return 'invalid_anchor'; // File exists but anchor might be invalid
      }
    }
    
    // Check if target looks malformed
    if (link.target.includes('<') || link.target.includes('>') || link.target.trim() === '') {
      return 'malformed_target';
    }
    
    return 'missing_file';
  }
  
  /**
   * Get all integrity issues as a flat list for easy processing.
   */
  async getAllIntegrityIssues(): Promise<LinkIntegrityIssue[]> {
    const report = await this.validateAll();
    const issues: LinkIntegrityIssue[] = [];
    
    // Add broken links as errors
    for (const brokenLink of report.brokenLinks) {
      issues.push({
        type: 'broken_link',
        severity: 'error',
        description: `Broken wikilink: [[${brokenLink.link.target}]] in ${brokenLink.link.sourceFile} (line ${brokenLink.link.line})`,
        files: [brokenLink.link.sourceFile],
        metadata: {
          target: brokenLink.link.target,
          suggestions: brokenLink.suggestions,
          line: brokenLink.link.line,
          position: brokenLink.link.position
        }
      });
    }
    
    // Add orphan files as warnings
    for (const orphanFile of report.orphanFiles) {
      issues.push({
        type: 'orphan_file',
        severity: 'warning',
        description: `Orphan file: ${orphanFile} has no incoming wikilinks`,
        files: [orphanFile],
        metadata: { file: orphanFile }
      });
    }
    
    // Add cycles as errors
    for (const cycle of report.cycles) {
      issues.push({
        type: 'cycle',
        severity: 'error',
        description: `Circular reference detected: ${cycle.cycle.join(' -> ')}`,
        files: cycle.cycle,
        metadata: {
          cycle: cycle.cycle,
          triggerLink: cycle.triggerLink
        }
      });
    }
    
    return issues;
  }
  
  /**
   * Quick health check - returns true if no critical issues found.
   */
  async isLinkGraphHealthy(): Promise<boolean> {
    const issues = await this.getAllIntegrityIssues();
    const criticalIssues = issues.filter(issue => issue.severity === 'error');
    return criticalIssues.length === 0;
  }
  
  /**
   * Generate a human-readable validation summary.
   */
  async generateSummaryReport(): Promise<string> {
    const report = await this.validateAll();
    const lines: string[] = [];
    
    lines.push('=== Link Validation Report ===');
    lines.push(`Generated: ${report.timestamp.toLocaleString()}`);
    lines.push('');
    
    lines.push('Summary:');
    lines.push(`  Total files: ${report.summary.totalFiles}`);
    lines.push(`  Total links: ${report.summary.totalLinks}`);
    lines.push(`  Valid links: ${report.summary.validLinks}`);
    lines.push(`  Broken links: ${report.summary.brokenLinks}`);
    lines.push(`  Orphan files: ${report.summary.orphanFiles}`);
    lines.push(`  Cycles detected: ${report.summary.cyclesDetected}`);
    lines.push('');
    
    if (report.brokenLinks.length > 0) {
      lines.push('Broken Links:');
      for (const broken of report.brokenLinks) {
        lines.push(`  ${broken.link.sourceFile}:${broken.link.line} -> [[${broken.link.target}]]`);
        if (broken.suggestions.length > 0) {
          lines.push(`    Suggestions: ${broken.suggestions.join(', ')}`);
        }
      }
      lines.push('');
    }
    
    if (report.orphanFiles.length > 0) {
      lines.push('Orphan Files (no incoming links):');
      for (const orphan of report.orphanFiles) {
        lines.push(`  ${orphan}`);
      }
      lines.push('');
    }
    
    if (report.cycles.length > 0) {
      lines.push('Circular References:');
      for (const cycle of report.cycles) {
        lines.push(`  ${cycle.cycle.join(' -> ')}`);
      }
      lines.push('');
    }
    
    const healthStatus = await this.isLinkGraphHealthy() ? 'HEALTHY' : 'ISSUES DETECTED';
    lines.push(`Overall Status: ${healthStatus}`);
    
    return lines.join('\n');
  }
}