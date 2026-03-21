/**
 * Link Graph Infrastructure - Public API
 *
 * Pure infrastructure layer for parsing markdown wikilinks into a graph structure,
 * storing in database, and providing utilities for broken link detection and
 * loop prevention.
 */

// Local imports for use within LinkGraphProcessor
import { parseWikiLinks } from './parser.js';
import { LinkGraph, type GraphStats } from './graph_builder.js';
import { LinkGraphStorage, type StoredWikiLink } from './storage.js';
import { LinkValidator, type ValidationReport, type LinkIntegrityIssue } from './validator.js';

// Core parser functionality
export {
  parseWikiLinks,
  extractSimpleTargets,
  isValidWikiLinkSyntax,
  type WikiLink,
  type ParsedLinks
} from './parser.js';

// Graph building with cycle detection
export {
  LinkGraph,
  type GraphNode,
  type CycleInfo,
  type GraphStats
} from './graph_builder.js';

// Enhanced storage layer
export {
  LinkGraphStorage,
  type StoredWikiLink,
  type LinkValidationResult
} from './storage.js';

// Validation utilities
export {
  LinkValidator,
  type ValidationReport,
  type BrokenLinkInfo,
  type LinkIntegrityIssue
} from './validator.js';

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
export class LinkGraphProcessor {
  private graph: LinkGraph;
  private storage: LinkGraphStorage;
  private validator: LinkValidator;
  private existingFiles = new Set<string>();
  
  constructor(private db: any, private mdDbPath: string) {
    this.graph = new LinkGraph();
    this.storage = new LinkGraphStorage(db);
    this.validator = new LinkValidator(this.storage, this.existingFiles);
  }
  
  /**
   * Build the complete link graph from markdown files in mdDbPath.
   */
  async buildFromMarkdownFiles(): Promise<void> {
    const { readdir, readFile } = await import('fs/promises');
    const { join, relative, extname } = await import('path');
    
    // Collect all markdown files
    const files = await this.collectMarkdownFiles(this.mdDbPath);
    this.existingFiles = new Set(files.map(path => relative(this.mdDbPath, path).replace(/\\/g, '/')));
    
    // Clear existing graph
    this.graph = new LinkGraph();
    
    // Parse each file and build graph
    for (const filePath of files) {
      const content = await readFile(filePath, 'utf-8');
      const relativePath = relative(this.mdDbPath, filePath).replace(/\\/g, '/');
      const { links } = parseWikiLinks(content, relativePath);
      
      // Add to graph with cycle detection
      this.graph.replaceOutgoingEdges(relativePath, links);
    }
    
    // Store in database
    this.storage.storeGraph(this.graph);
    
    console.log(`[link-graph] Built graph with ${this.graph.getAllNodeIds().length} nodes`);
    
    const stats = this.graph.getStats();
    if (stats.cycles.length > 0) {
      console.warn(`[link-graph] Detected ${stats.cycles.length} cycles`);
    }
  }
  
  /**
   * Update links for a single file (more efficient than full rebuild).
   */
  async updateFile(filePath: string): Promise<void> {
    const { readFile } = await import('fs/promises');
    const { relative } = await import('path');
    
    const content = await readFile(filePath, 'utf-8');
    const relativePath = relative(this.mdDbPath, filePath).replace(/\\/g, '/');
    const { links } = parseWikiLinks(content, relativePath);
    
    // Update graph and storage
    this.graph.replaceOutgoingEdges(relativePath, links);
    this.storage.updateFileLinks(relativePath, links);
  }
  
  /**
   * Validate all links and return comprehensive report.
   */
  async validateLinks(): Promise<ValidationReport> {
    // Update validator with current file set
    this.validator = new LinkValidator(this.storage, this.existingFiles);
    return await this.validator.validateAll();
  }
  
  /**
   * Generate human-readable validation report.
   */
  async generateReport(): Promise<string> {
    this.validator = new LinkValidator(this.storage, this.existingFiles);
    return await this.validator.generateSummaryReport();
  }
  
  /**
   * Get graph statistics.
   */
  getGraphStats(): GraphStats {
    return this.graph.getStats();
  }
  
  /**
   * Get all integrity issues for programmatic processing.
   */
  async getIntegrityIssues(): Promise<LinkIntegrityIssue[]> {
    this.validator = new LinkValidator(this.storage, this.existingFiles);
    return await this.validator.getAllIntegrityIssues();
  }
  
  /**
   * Check if the link graph is healthy (no critical issues).
   */
  async isHealthy(): Promise<boolean> {
    this.validator = new LinkValidator(this.storage, this.existingFiles);
    return await this.validator.isLinkGraphHealthy();
  }
  
  /**
   * Get links from a specific file.
   */
  getLinksFromFile(fileId: string): StoredWikiLink[] {
    return this.storage.getLinksFromFile(fileId);
  }
  
  /**
   * Get all files that link to a specific file.
   */
  getLinksToFile(fileId: string): StoredWikiLink[] {
    return this.storage.getLinksToFile(fileId);
  }
  
  /**
   * Get basic link statistics.
   */
  getLinkStats() {
    return this.storage.getLinkStats();
  }
  
  /**
   * Recursively collect all markdown files.
   */
  private async collectMarkdownFiles(dir: string): Promise<string[]> {
    const { readdir } = await import('fs/promises');
    const { join, extname } = await import('path');
    
    const entries = await readdir(dir, { withFileTypes: true });
    const paths: string[] = [];
    
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        paths.push(...(await this.collectMarkdownFiles(fullPath)));
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        paths.push(fullPath);
      }
    }
    
    return paths;
  }
}