/**
 * Enhanced storage layer for link graph data.
 *
 * Extends the existing SQLite schema to store detailed link information
 * including aliases, anchors, and metadata while maintaining compatibility
 * with the existing edge-based system.
 */
/**
 * Enhanced graph storage that extends SqliteGraphStore functionality.
 */
export class LinkGraphStorage {
    db;
    constructor(db) {
        this.db = db;
        this.initEnhancedSchema();
    }
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
    initEnhancedSchema() {
        // Drop derived tables so schema changes and stale FK constraints are cleared.
        this.db.exec(`
      DROP TABLE IF EXISTS link_validation_cache;
      DROP TABLE IF EXISTS detected_cycles;
      DROP TABLE IF EXISTS wikilinks;
    `);
        this.db.exec(`
      -- Wikilink metadata table — no FK constraints (targets are raw link text)
      CREATE TABLE IF NOT EXISTS wikilinks (
        link_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        source_file  TEXT NOT NULL,
        target_file  TEXT NOT NULL,
        alias        TEXT,
        anchor       TEXT,
        raw_text     TEXT NOT NULL,
        position     INTEGER NOT NULL,
        line_number  INTEGER NOT NULL,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_wikilinks_source ON wikilinks(source_file);
      CREATE INDEX IF NOT EXISTS idx_wikilinks_target ON wikilinks(target_file);
      CREATE INDEX IF NOT EXISTS idx_wikilinks_source_target ON wikilinks(source_file, target_file);

      CREATE TABLE IF NOT EXISTS detected_cycles (
        cycle_id     INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_path   TEXT NOT NULL,
        trigger_link TEXT NOT NULL,
        detected_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved     BOOLEAN DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS link_validation_cache (
        cache_key    TEXT PRIMARY KEY,
        result       TEXT NOT NULL,
        updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    }
    /**
     * Store a complete link graph in the database.
     * This replaces all existing wikilink data for efficiency.
     */
    storeGraph(graph) {
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
                    insertLink.run(nodeId, link.target, link.alias, link.anchor, link.raw, link.position, link.line);
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
    updateFileLinks(sourceFile, links) {
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
                insertLink.run(sourceFile, link.target, link.alias, link.anchor, link.raw, link.position, link.line);
            }
        });
        transaction();
    }
    /**
     * Get all wikilinks from a specific source file.
     */
    getLinksFromFile(sourceFile) {
        const rows = this.db.prepare(`
      SELECT * FROM wikilinks WHERE source_file = ? ORDER BY position
    `).all(sourceFile);
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
    getLinksToFile(targetFile) {
        const rows = this.db.prepare(`
      SELECT * FROM wikilinks WHERE target_file = ? ORDER BY source_file, position
    `).all(targetFile);
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
    validateAllLinks() {
        // Get all unique target files from wikilinks
        const targetRows = this.db.prepare(`
      SELECT DISTINCT target_file FROM wikilinks
    `).all();
        // Get all existing note IDs
        const noteRows = this.db.prepare(`
      SELECT note_id FROM notes
    `).all();
        const existingNotes = new Set(noteRows.map(row => row.note_id));
        const validTargets = new Set();
        const brokenTargets = new Set();
        // Classify targets as valid or broken
        for (const { target_file } of targetRows) {
            if (existingNotes.has(target_file) || existingNotes.has(`${target_file}.md`)) {
                validTargets.add(target_file);
            }
            else {
                brokenTargets.add(target_file);
            }
        }
        // Get all links categorized by validity
        const valid = [];
        const broken = [];
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
    getLinksWithTarget(target) {
        const rows = this.db.prepare(`
      SELECT * FROM wikilinks WHERE target_file = ?
    `).all(target);
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
    storeCycles(cycles) {
        const insertCycle = this.db.prepare(`
      INSERT INTO detected_cycles (cycle_path, trigger_link)
      VALUES (?, ?)
    `);
        for (const cycle of cycles) {
            insertCycle.run(JSON.stringify(cycle.cycle), JSON.stringify(cycle.triggerLink));
        }
    }
    /**
     * Get all unresolved cycles.
     */
    getDetectedCycles() {
        const rows = this.db.prepare(`
      SELECT cycle_path, trigger_link FROM detected_cycles WHERE resolved = FALSE
    `).all();
        return rows.map(row => ({
            cycle: JSON.parse(row.cycle_path),
            triggerLink: JSON.parse(row.trigger_link)
        }));
    }
    /**
     * Mark cycles as resolved.
     */
    markCyclesResolved() {
        this.db.prepare("UPDATE detected_cycles SET resolved = TRUE").run();
    }
    /**
     * Get link statistics for reporting.
     */
    getLinkStats() {
        const totalLinks = this.db.prepare("SELECT COUNT(*) as count FROM wikilinks").get().count;
        const uniqueTargets = this.db.prepare("SELECT COUNT(DISTINCT target_file) as count FROM wikilinks").get().count;
        const filesWithLinks = this.db.prepare("SELECT COUNT(DISTINCT source_file) as count FROM wikilinks").get().count;
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
    clearAllLinkData() {
        const transaction = this.db.transaction(() => {
            this.db.prepare("DELETE FROM wikilinks").run();
            this.db.prepare("DELETE FROM detected_cycles").run();
            this.db.prepare("DELETE FROM link_validation_cache").run();
        });
        transaction();
    }
}
//# sourceMappingURL=storage.js.map