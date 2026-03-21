/**
 * Re-exports wikilink parsing from the shared markdown layer.
 *
 * All wikilink parsing logic now lives in shared/markdown/wikilinks.ts.
 * This file preserves backward compatibility for existing link_graph imports.
 */

export {
  parseWikiLinks,
  extractSimpleTargets,
  isValidWikiLinkSyntax,
  type WikiLink,
  type ParsedLinks,
} from "../../shared/markdown/wikilinks.js";
