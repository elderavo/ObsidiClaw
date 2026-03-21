# Link Graph Infrastructure

Pure infrastructure layer for parsing markdown wikilinks into a graph structure, storing in the database, and providing utilities for broken link detection and loop prevention.

## Overview

This module provides:
- **Enhanced wikilink parsing** with aliases, anchors, and position tracking
- **Graph construction** with automatic cycle detection and prevention  
- **Database storage** that extends the existing SQLite schema
- **Link validation** utilities for detecting broken links and orphans
- **Loop prevention** during graph traversal and construction

## Core Components

### Parser (`parser.ts`)
Extracts detailed wikilink information from markdown:
```typescript
const { links, malformed } = parseWikiLinks(content);
// links contains: target, alias, anchor, position, line, raw
```

### Graph Builder (`graph_builder.ts`)
Builds directed graph with cycle detection:
```typescript
const graph = new LinkGraph();
graph.addEdge('file1.md', 'file2.md', linkInfo); // Returns false if would create cycle
```

### Storage (`storage.ts`)
Persists enhanced link data in SQLite:
```typescript
const storage = new LinkGraphStorage(db);
storage.storeGraph(graph);
const brokenLinks = storage.validateAllLinks();
```

### Validator (`validator.ts`)
Detects broken links and integrity issues:
```typescript
const validator = new LinkValidator(storage, existingFiles);
const report = await validator.validateAll();
```

## Usage

### Simple API
```typescript
import { LinkGraphProcessor } from './link_graph/index.js';

const processor = new LinkGraphProcessor(db, './md_db');

// Build graph from markdown files
await processor.buildFromMarkdownFiles();

// Validate links
const report = await processor.validateLinks();
console.log(`Found ${report.summary.brokenLinks} broken links`);

// Generate human-readable report
console.log(await processor.generateReport());
```

### Integration with Existing Indexer
```typescript
// In graph-indexer.ts
import { LinkGraphProcessor } from './link_graph/index.js';

export async function syncMdDbToGraphWithLinkAnalysis(
  mdDbPath: string,
  graphStore: SqliteGraphStore
): Promise<void> {
  // Existing sync logic...
  await syncMdDbToGraph(mdDbPath, graphStore);
  
  // Add enhanced link processing
  const linkProcessor = new LinkGraphProcessor(graphStore.db, mdDbPath);
  await linkProcessor.buildFromMarkdownFiles();
  
  // Report any issues
  const isHealthy = await linkProcessor.isHealthy();
  if (!isHealthy) {
    console.warn('[indexer] Link integrity issues detected');
    const issues = await linkProcessor.getIntegrityIssues();
    console.warn(`[indexer] ${issues.length} issues found`);
  }
}
```

## Database Schema

Adds these tables to the existing schema:

### `wikilinks`
Stores detailed link information:
- `source_file`, `target_file` - link relationship
- `alias`, `anchor` - display text and section references  
- `position`, `line_number` - location in source file
- Foreign keys to existing `notes` table

### `detected_cycles` 
Tracks circular references:
- `cycle_path` - JSON array of the cycle
- `trigger_link` - Link that would complete the cycle
- `resolved` - Whether issue has been addressed

## Cycle Detection

The graph builder prevents infinite loops by:
1. **Construction-time detection** - `addEdge()` checks if new edge would create cycle
2. **DFS-based checking** - Uses depth-first search to detect reachability 
3. **Path tracking** - Records the actual cycle path for debugging
4. **Graceful handling** - Logs cycles but continues processing

Example cycle detection:
```
file1.md -> file2.md -> file3.md -> file1.md
```

## Link Validation

The validator detects:

### Broken Links
- Links to non-existent files
- Provides suggestions based on file name similarity
- Handles `.md` extension mismatches

### Orphan Files  
- Files with no incoming wikilinks
- Useful for finding disconnected content

### Malformed Links
- Invalid wikilink syntax
- Empty or corrupted link targets

## Performance Notes

- **Bulk operations** - Uses transactions for efficient database updates
- **Incremental updates** - `updateFile()` for single file changes
- **Memory efficient** - Streams large markdown collections
- **Index optimized** - Database indexes on source/target for fast queries

## Integration Points

This module is designed to integrate with:
- **Graph indexer** - Add to `syncMdDbToGraph()` 
- **Context retrieval** - Use link relationships for better context
- **MCP server** - Expose validation as tool functions
- **Orchestrator** - Include health checks in startup

## Future Enhancements

Potential Phase 6+ features:
- **Real-time validation** during file changes
- **Link suggestion engine** based on content similarity
- **Visual graph export** for external visualization tools
- **Automatic link fixing** for simple cases