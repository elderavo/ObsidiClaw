/**
 * Personality loader — reads personality markdown files from disk.
 *
 * Personality files live in shared/agents/personalities/ (outside md_db)
 * so they are NOT indexed by the context engine and don't pollute
 * retrieval results.
 *
 * File format:
 * ```markdown
 * ---
 * type: personality
 * title: Deep Researcher
 * provider:
 *   model: llama3
 *   baseUrl: http://10.0.132.100/v1
 * ---
 * # Deep Researcher
 * You are a deep researcher...
 * ```
 */
import { join } from "path";
import { readText, fileExists, listDir } from "../os/fs.js";
import { parseFrontmatter } from "../markdown/frontmatter.js";
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Load a personality by name from the given directory.
 * Returns null if the file doesn't exist.
 */
export function loadPersonality(name, personalitiesDir) {
    const filePath = join(personalitiesDir, `${name}.md`);
    if (!fileExists(filePath)) {
        return null;
    }
    const raw = readText(filePath);
    const { frontmatter, body } = parseFrontmatter(raw);
    return {
        name,
        content: body,
        provider: extractProvider(frontmatter),
    };
}
/**
 * List all available personality names in the given directory.
 * Returns names without the .md extension.
 */
export function listPersonalities(personalitiesDir) {
    if (!fileExists(personalitiesDir)) {
        return [];
    }
    return listDir(personalitiesDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.slice(0, -3));
}
/**
 * Extract provider config from parsed frontmatter.
 * Handles both flat and nested formats:
 *   provider:
 *     model: llama3
 *     baseUrl: http://...
 */
function extractProvider(fm) {
    const provider = fm["provider"];
    if (!provider || typeof provider !== "object")
        return undefined;
    const p = provider;
    const model = typeof p["model"] === "string" ? p["model"] : undefined;
    const baseUrl = typeof p["baseUrl"] === "string" ? p["baseUrl"] : undefined;
    if (!model && !baseUrl)
        return undefined;
    return { model, baseUrl };
}
//# sourceMappingURL=personality-loader.js.map