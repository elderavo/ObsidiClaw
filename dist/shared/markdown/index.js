/**
 * Shared markdown utilities — canonical handlers for frontmatter, wikilinks,
 * and token normalization used throughout the system.
 */
export { parseFrontmatter, buildFrontmatter } from "./frontmatter.js";
export { extractWikilinks, parseWikiLinks, extractSimpleTargets, isValidWikiLinkSyntax } from "./wikilinks.js";
export { normalizeToken, normalizeTokens, normalizeTagList, extractTags } from "./tokens.js";
export { normalizeMdDb } from "./normalizer.js";
//# sourceMappingURL=index.js.map