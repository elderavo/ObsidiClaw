/**
 * Shared markdown utilities — canonical handlers for frontmatter, wikilinks,
 * and token normalization used throughout the system.
 */
export { parseFrontmatter, buildFrontmatter, type FrontmatterResult } from "./frontmatter.js";
export { extractWikilinks, parseWikiLinks, extractSimpleTargets, isValidWikiLinkSyntax, type WikiLink, type ParsedLinks } from "./wikilinks.js";
export { normalizeToken, normalizeTokens, normalizeTagList, extractTags } from "./tokens.js";
export { normalizeMdDb, type NormalizationIssue, type NormalizationResult, type NormalizeOptions } from "./normalizer.js";
//# sourceMappingURL=index.d.ts.map