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
export class LinkGraphStorage {
  constructor(private db: DB) {
    this.initEnhancedSchema();
  }
  
  /**
   * Initialize enhanced schema for detailed link storage.
   * Adds new tables while preserving existing notes/edges structure.
   */
  private initEnhancedSchema(): void {
    this.db.exec(`
      -- Enhanced wikilinks table with full metadata
      CREATE TABLE IF NOT EXISTS wikilinks (
        link_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        source_file  TEXT NOT NULL,
        target_file  TEXT NOT NULL,
        alias        TEXT,
        anchor       TEXT,
        raw_text     TEXT NOT NULL,
        position     INTEGER NOT NULL,
        line_number  INTEGER NOT NULL,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        
        -- Foreign keys to notes table
        FOREIGN KEY (source_file) REFERENCES notes(note_id) ON DELETE CASCADE,
        FOREIGN KEY (target_file) REFERENCES notes(note_id) ON DELETE CASCADE
      );
      
      -- Index for efficient queries
      CREATE INDEX IF NOT EXISTS idx_wikilinks_source ON wikilinks(source_file);
      CREATE INDEX IF NOT EXISTS idx_wikilinks_target ON wikilinks(target_file);
      CREATE INDEX IF NOT EXISTS idx_wikilinks_source_target ON wikilinks(source_file, target_file);
      
      -- Cycle detection metadata
      CREATE TABLE IF NOT EXISTS detected_cycles (
        cycle_id     INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_path   TEXT NOT NULL,  -- JSON array of node IDs
        trigger_link TEXT NOT NULL,  -- JSON of WikiLink that would complete cycle
        detected_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved     BOOLEAN DEFAULT FALSE
      );
      
      -- Link validation cache  
      CREATE TABLE IF NOT EXISTS link_validation_cache (
        cache_key    TEXT PRIMARY KEY,
        result       TEXT NOT NULL,  -- JSON of validation results
        updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }
  
  /**
   * Store a complete link graph in the database.
   * This replaces all existing wikilink data for efficiency.
   */
  storeGraph(graph: LinkGraph): void {
    const transaction = this.db.transaction(() => {
      // Clear existing enhanced link data (edges table maintained separately)
      this.db.prepare("DELETE FROM wikilinks").run();
      this.db.prepare("DELETE FROM detected_cycles").run();
      
      const insertLink = this.db.prepare(`
        INSERT INTO wikilinks 
        (source_file, target_file, alias, anchor, raw_text, position, line_number)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      
      // Store all links from the graph
      for (const nodeId of graph.getAllNodeIds()) {
        const links = graph.getOutgoingLinks(nodeId);
        
        for (const link of links) {
          insertLink.run(
            nodeId,
            link.target,
            link.alias,
            link.anchor,
            link.raw,
            link.position,
            link.line
          );
        }
      }
      
      // Store detected cycles
      const stats = graph.getStats();
      this.storeCycles(stats.cycles);
    });
    
    transaction();
  }
  
  /**
   * Update links for a specific source file.
   * More efficient than full graph rebuild for single file changes.
   */
  updateFileLinks(sourceFile: string, links: WikiLink[]): void {
    const transaction = this.db.transaction(() => {
      // Remove existing links from this source file
      this.db.prepare("DELETE FROM wikilinks WHERE source_file = ?").run(sourceFile);
      
      // Insert new links
      const insertLink = this.db.prepare(`
        INSERT INTO wikilinks 
        (source_file, target_file, alias, anchor, raw_text, position, line_number)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      
      for (const link of links) {
        insertLink.run(
          sourceFile,
          link.target,
          link.alias,
          link.anchor,
          link.raw,
          link.position,
          link.line
        );
      }
    });
    
    transaction();
  }
  
  /**
   * Get all wikilinks from a specific source file.
   */
  getLinksFromFile(sourceFile: string): StoredWikiLink[] {
    const rows = this.db.prepare(`
      SELECT * FROM wikilinks WHERE source_file = ? ORDER BY position
    `).all(sourceFile) as any[];
    
    return rows.map(row => ({
      target: row.target_file,
      alias: row.alias,
      anchor: row.anchor,
      raw: row.raw_text,
      position: row.position,
      line: row.line_number,
      sourceFile: row.source_file,
      linkId: String(row.link_id)
    }));
  }
  
  /**
   * Get all wikilinks that point to a specific target file.
   */
  getLinksToFile(targetFile: string): StoredWikiLink[] {
    const rows = this.db.prepare(`
      SELECT * FROM wikilinks WHERE target_file = ? ORDER BY source_file, position
    `).all(targetFile) as any[];
    
    return rows.map(row => ({
      target: row.target_file,
      alias: row.alias,
      anchor: row.anchor,
      raw: row.raw_text,
      position: row.position,
      line: row.line_number,
      sourceFile: row.source_file,
      linkId: String(row.link_id)
    }));
  }
  
  /**
   * Validate all links against existing notes and return broken links.
   */
  validateAllLinks(): LinkValidationResult {
    // Get all unique target files from wikilinks
    const targetRows = this.db.prepare(`
      SELECT DISTINCT target_file FROM wikilinks
    `).all() as { target_file: string }[];
    
    // Get all existing note IDs
    const noteRows = this.db.prepare(`
      SELECT note_id FROM notes
    `).all() as { note_id: string }[];
    
    const existingNotes = new Set(noteRows.map(row => row.note_id));
    const validTargets = new Set<string>();
    const brokenTargets = new Set<string>();
    
    // Classify targets as valid or broken
    for (const { target_file } of targetRows) {
      if (existingNotes.has(target_file) || existingNotes.has(`${target_file}.md`)) {
        validTargets.add(target_file);
      } else {
        brokenTargets.add(target_file);
      }
    }
    
    // Get all links categorized by validity
    const valid: StoredWikiLink[] = [];
    const broken: StoredWikiLink[] = [];
    
    for (const target of validTargets) {
      valid.push(...this.getLinksWithTarget(target));
    }
    
    for (const target of brokenTargets) {
      broken.push(...this.getLinksWithTarget(target));
    }
    
    // Find orphan files (notes with no incoming wikilinks)
    const linkedToFiles = new Set(targetRows.map(row => row.target_file));
    const orphans = noteRows
      .filter(row => !linkedToFiles.has(row.note_id) && !linkedToFiles.has(row.note_id.replace(/\.md$/, '')))
      .map(row => row.note_id);
    
    return { valid, broken, orphans };
  }
  
  /**
   * Get wikilinks with a specific target (helper method).
   */
  private getLinksWithTarget(target: string): StoredWikiLink[] {
    const rows = this.db.prepare(`
      SELECT * FROM wikilinks WHERE target_file = ?
    `).all(target) as any[];
    
    return rows.map(row => ({
      target: row.target_file,
      alias: row.alias,
      anchor: row.anchor,
      raw: row.raw_text,
      position: row.position,
      line: row.line_number,
      sourceFile: row.source_file,
      linkId: String(row.link_id)
    }));
  }
  
  /**
   * Store detected cycles in the database.
   */
  private storeCycles(cycles: CycleInfo[]): void {
    const insertCycle = this.db.prepare(`
      INSERT INTO detected_cycles (cycle_path, trigger_link)
      VALUES (?, ?)
    `);
    
    for (const cycle of cycles) {
      insertCycle.run(
        JSON.stringify(cycle.cycle),
        JSON.stringify(cycle.triggerLink)
      );
    }
  }
  
  /**
   * Get all unresolved cycles.
   */
  getDetectedCycles(): CycleInfo[] {
    const rows = this.db.prepare(`
      SELECT cycle_path, trigger_link FROM detected_cycles WHERE resolved = FALSE
    `).all() as { cycle_path: string; trigger_link: string }[];
    
    return rows.map(row => ({
      cycle: JSON.parse(row.cycle_path),
      triggerLink: JSON.parse(row.trigger_link)
    }));
  }
  
  /**
   * Mark cycles as resolved.
   */
  markCyclesResolved(): void {
    this.db.prepare("UPDATE detected_cycles SET resolved = TRUE").run();
  }
  
  /**
   * Get link statistics for reporting.
   */
  getLinkStats(): {
    totalLinks: number;
    uniqueTargets: number;
    filesWithLinks: number;
    brokenLinkCount: number;
    orphanCount: number;
  } {
    const totalLinks = (this.db.prepare("SELECT COUNT(*) as count FROM wikilinks").get() as any).count;
    const uniqueTargets = (this.db.prepare("SELECT COUNT(DISTINCT target_file) as count FROM wikilinks").get() as any).count;
    const filesWithLinks = (this.db.prepare("SELECT COUNT(DISTINCT source_file) as count FROM wikilinks").get() as any).count;
    
    const validation = this.validateAllLinks();
    
    return {
      totalLinks,
      uniqueTargets,
      filesWithLinks,
      brokenLinkCount: validation.broken.length,
      orphanCount: validation.orphans.length
    };
  }
  
  /**
   * Clear all enhanced link data (useful for testing).
   */
  clearAllLinkData(): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM wikilinks").run();
      this.db.prepare("DELETE FROM detected_cycles").run();
      this.db.prepare("DELETE FROM link_validation_cache").run();
    });
    
    transaction();
  }
}