---
title: Context Engine Ingest Pipeline
type: concept
---

# Context Engine Ingest Pipeline

Transforms raw markdown files under `md_db/` into structured notes in SQLite.

## Steps

1. **File discovery**
   - `collectMarkdownFiles(mdDbPath)` recursively finds all `*.md` files.
   - Used by [[context_engine-indexing-lifecycle]] and [[link-graph-infrastructure]].

2. **Parsing markdown → ParsedNote**
   - `parseMarkdownFile(content, relativePath)` (in `ingest/note-parser.ts`):
     - Splits frontmatter (`---`, `+++`) from body.
     - Parses simple key/value + list frontmatter into a JS object.
     - Infers `NoteType`:
       - `frontmatter.type` / `note_type` if present.
       - Otherwise, path-prefix: `tools/` → `"tool"`, `concepts/` → `"concept"`.
       - Otherwise, filename `index` → `"index"`, else `"concept"`.
     - Extracts title from:
       - `frontmatter.title` → first `#` heading → filename stem.
     - Extracts raw wikilinks (`linksOut`):
       - Captures `[[note]]` and `[[note|alias]]` as just `note`.
     - Populates `toolId` for `"tool"` notes from `frontmatter.tool_id` or filename stem.

3. **ParsedNote model**
   - See [[context_engine-data-models]] (`ParsedNote`).
   - No I/O; pure data used by [[context_engine-indexing-lifecycle]].

## Where it’s used

- [[context_engine-indexing-lifecycle]] uses `parseMarkdownFile` to:
  - Upsert notes into [[sqlite-graph-store]].
  - Resolve `linksOut` into concrete edges via `resolveLink()`.

For enhanced wikilink metadata and validation (aliases, anchors, positions), see [[link-graph-infrastructure]].
