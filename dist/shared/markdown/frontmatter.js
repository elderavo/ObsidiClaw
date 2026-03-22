/**
 * Frontmatter parsing and building — canonical handler for YAML frontmatter
 * in markdown files throughout the system.
 *
 * Handles:
 *   - `key: value` (string)
 *   - `key:` followed by `- item` lines (array)
 *   - `key:` followed by indented `subkey: value` lines (nested object)
 *
 * Used by: context_engine/ingest, shared/agents/personality-loader, insight_engine
 */
// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
/**
 * Split markdown content into frontmatter key-values and body text.
 * Returns empty frontmatter if no valid `---` delimiters are found.
 */
export function parseFrontmatter(content) {
    const lines = content.split("\n");
    // Must start with --- on first line
    if (lines[0]?.trim() !== "---") {
        return { frontmatter: {}, body: content };
    }
    // Find closing ---
    let closingIdx = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === "---") {
            closingIdx = i;
            break;
        }
    }
    // No closing delimiter — treat entire file as body
    if (closingIdx === -1) {
        return { frontmatter: {}, body: content };
    }
    const fmLines = lines.slice(1, closingIdx);
    const frontmatter = parseFrontmatterLines(fmLines);
    const body = lines.slice(closingIdx + 1).join("\n").trimStart();
    return { frontmatter, body };
}
/**
 * YAML-like line-by-line parser.
 * Handles: key: value, YAML dash-lists, and one level of nested objects.
 */
function parseFrontmatterLines(lines) {
    const result = {};
    let i = 0;
    while (i < lines.length) {
        const line = lines[i] ?? "";
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            i++;
            continue;
        }
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx <= 0) {
            i++;
            continue;
        }
        const key = trimmed.slice(0, colonIdx).trim();
        const rawValue = trimmed.slice(colonIdx + 1).trim();
        if (rawValue) {
            // Inline value: key: value
            result[key] = rawValue;
            i++;
        }
        else {
            // Check for nested block or list
            const nested = {};
            const listItems = [];
            let j = i + 1;
            while (j < lines.length) {
                const nextLine = lines[j] ?? "";
                const nextTrimmed = nextLine.trim();
                // Empty line or non-indented line ends the block
                if (!nextTrimmed || (!nextLine.startsWith("  ") && !nextLine.startsWith("\t"))) {
                    break;
                }
                if (nextTrimmed.startsWith("- ")) {
                    listItems.push(nextTrimmed.slice(2).trim());
                }
                else {
                    const nestedColon = nextTrimmed.indexOf(":");
                    if (nestedColon > 0) {
                        const nKey = nextTrimmed.slice(0, nestedColon).trim();
                        const nVal = nextTrimmed.slice(nestedColon + 1).trim();
                        nested[nKey] = nVal || null;
                    }
                }
                j++;
            }
            if (listItems.length > 0) {
                result[key] = listItems;
            }
            else if (Object.keys(nested).length > 0) {
                result[key] = nested;
            }
            else {
                result[key] = null;
            }
            i = j;
        }
    }
    return result;
}
// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------
/**
 * Build a YAML frontmatter block from key-value pairs.
 *
 * - Strings → `key: value`
 * - Arrays → multi-line with `    - item` (4-space indent)
 * - Objects → nested with 4-space indent (`subkey: value`)
 * - null/undefined values → `key:` (empty)
 *
 * Returns the full block including `---` delimiters and trailing newline.
 */
export function buildFrontmatter(fields) {
    const lines = ["---"];
    for (const [key, value] of Object.entries(fields)) {
        if (value === null || value === undefined) {
            lines.push(`${key}:`);
        }
        else if (Array.isArray(value)) {
            lines.push(`${key}:`);
            for (const item of value) {
                lines.push(`    - ${String(item)}`);
            }
        }
        else if (typeof value === "object") {
            lines.push(`${key}:`);
            for (const [subKey, subVal] of Object.entries(value)) {
                if (subVal === null || subVal === undefined) {
                    lines.push(`    ${subKey}:`);
                }
                else {
                    lines.push(`    ${subKey}: ${String(subVal)}`);
                }
            }
        }
        else {
            lines.push(`${key}: ${String(value)}`);
        }
    }
    lines.push("---");
    return lines.join("\n") + "\n";
}
//# sourceMappingURL=frontmatter.js.map