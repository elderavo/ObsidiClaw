---
title: Link Graph Infrastructure
type: concept
---

# Link Graph Infrastructure (Enhanced Wikilinks)

Additional infrastructure for parsing, storing, and validating rich wikilink data, separate from the simple `edges` graph in [[sqlite-graph-store]].

## Purpose

- Provide **richer link metadata**:
  - Aliases, anchors, positions, and line numbers.
- Enable **integrity checks**:
  - Broken links, orphan files, cycles.
- Avoid polluting the core retrieval graph:
  - Uses its own tables (`wikilinks`, `detected_cycles`, etc.) as a derived cache.

## Components

- **Parser (`parser.ts`)**
  - `parseWikiLinks(content, sourceFile?)` → `{ links, malformed }`:
    - Handles `[[target]]`, `[[target|alias]]`, `[[target#anchor]]`, `[[target#anchor|alias]]`.
    - Records `target`, `alias`, `anchor`, `raw`, `position`, `line`.
  - `extractSimpleTargets(links)` for legacy use.

- **Graph builder (`graph_builder.ts`)**
  - `LinkGraph` with:
    - `addNode(id)`, `addEdge(fromId, toId, linkInfo)` with cycle detection.
    - `replaceOutgoingEdges(fromId, newLinks)`.
    - `getStats()` returns node/edge counts, orphans, leaves, cycles.

- **Storage (`storage.ts`)**
  - `LinkGraphStorage` on top of `better-sqlite3` DB from [[sqlite-graph-store]]:
    - Tables:
      - `wikilinks` – detailed link rows (no FKs; targets are raw text).
      - `detected_cycles` – records detected cycles.
      - `link_validation_cache` – for future caching.
    - Methods:
      - `storeGraph(graph)` – rebuilds tables for full graph.
      - `updateFileLinks(sourceFile, links)` – incremental update.
      - `validateAllLinks()` – valid vs broken links + orphans.
      - `getDetectedCycles()`, `markCyclesResolved()`, `getLinkStats()`.

- **Validator (`validator.ts`)**
  - `LinkValidator`:
    - `validateAll()` – summary of valid/broken links, orphans, cycles.
    - `getAllIntegrityIssues()` – flat list with severities and suggestions.
    - `isLinkGraphHealthy()` – quick check for critical issues.
    - `generateSummaryReport()` – human-readable report (for logs).

- **Facade (`index.ts`)**
  - `LinkGraphProcessor(db, mdDbPath)`:
    - `buildFromMarkdownFiles()` – full rebuild from `md_db/`.
    - `updateFile(filePath)` – per-file update.
    - `validateLinks()`, `generateReport()`, `getIntegrityIssues()`, etc.

## Integration with ContextEngine

- `ContextEngine.rebuildLinkGraph()`:
  - Creates `LinkGraphProcessor` with `graphStore.getDatabase()` and `mdDbPath`.
  - Calls `buildFromMarkdownFiles()`.
  - Checks `isHealthy()`, logs issue counts via `getIntegrityIssues()`.

Enhanced link data is **not** in the retrieval path of [[context_engine-retrieval-workflow]]; it’s infrastructure for quality and tooling.
