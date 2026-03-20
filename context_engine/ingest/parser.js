"use strict";
/**
 * Markdown file parser — converts raw file content into a ParsedNote.
 *
 * Pure function: zero I/O, fully synchronous, easily testable.
 *
 * Handles:
 *   - Frontmatter between --- delimiters (simple key: value pairs)
 *   - [[wikilink]] extraction (with [[note|alias]] alias stripping)
 *   - NoteType inference: frontmatter > path prefix > filename
 *   - Title extraction: frontmatter.title > first # heading > filename stem
 */
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseMarkdownFile = parseMarkdownFile;
var path_1 = require("path");
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function parseMarkdownFile(content, relativePath) {
    var _a;
    var _b = splitFrontmatter(content), frontmatter = _b.frontmatter, body = _b.body;
    var noteType = inferNoteType(frontmatter, relativePath);
    var title = extractTitle(frontmatter, body, relativePath);
    var linksOut = extractWikilinks(body);
    var toolId = noteType === "tool"
        ? String((_a = frontmatter["tool_id"]) !== null && _a !== void 0 ? _a : stemOf(relativePath))
        : undefined;
    return {
        noteId: relativePath,
        path: relativePath,
        title: title,
        noteType: noteType,
        body: body,
        frontmatter: frontmatter,
        linksOut: linksOut,
        toolId: toolId,
        timeCreated: stringOrUndefined(frontmatter["time_created"]),
        lastEdited: stringOrUndefined(frontmatter["last_edited"]),
    };
}
// ---------------------------------------------------------------------------
// Frontmatter extraction
// ---------------------------------------------------------------------------
function splitFrontmatter(content) {
    var _a, _b;
    var lines = content.split("\n");
    // Must start with --- on first non-empty line
    if (((_a = lines[0]) === null || _a === void 0 ? void 0 : _a.trim()) !== "---") {
        return { frontmatter: {}, body: content };
    }
    // Find closing ---
    var closingIdx = -1;
    for (var i = 1; i < lines.length; i++) {
        if (((_b = lines[i]) === null || _b === void 0 ? void 0 : _b.trim()) === "---") {
            closingIdx = i;
            break;
        }
    }
    // No closing delimiter — treat entire file as body
    if (closingIdx === -1) {
        return { frontmatter: {}, body: content };
    }
    var fmLines = lines.slice(1, closingIdx);
    var frontmatter = parseFrontmatterLines(fmLines);
    // Skip the closing --- and any single leading blank line
    var bodyLines = lines.slice(closingIdx + 1);
    var body = bodyLines.join("\n").trimStart();
    return { frontmatter: frontmatter, body: body };
}
/**
 * Simple line-by-line key: value parser.
 * Handles: `key: value`, `key:` (null), `key: ` (null).
 * Does NOT handle YAML lists, nested objects, or multiline values.
 */
function parseFrontmatterLines(lines) {
    var result = {};
    for (var _i = 0, lines_1 = lines; _i < lines_1.length; _i++) {
        var line = lines_1[_i];
        var trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        var colonIdx = trimmed.indexOf(":");
        if (colonIdx <= 0)
            continue;
        var key = trimmed.slice(0, colonIdx).trim();
        var rawValue = trimmed.slice(colonIdx + 1).trim();
        result[key] = rawValue || null;
    }
    return result;
}
// ---------------------------------------------------------------------------
// Wikilink extraction
// ---------------------------------------------------------------------------
/**
 * Extracts [[wikilink]] targets from body text.
 * Handles [[note|alias]] — captures only the part before the pipe.
 * Deduplicates and filters empty captures.
 */
function extractWikilinks(body) {
    var _a;
    var seen = new Set();
    var pattern = /\[\[([^|\]]+)(?:\|[^\]]+)?\]\]/g;
    var match;
    while ((match = pattern.exec(body)) !== null) {
        var linkText = (_a = match[1]) === null || _a === void 0 ? void 0 : _a.trim();
        if (linkText)
            seen.add(linkText);
    }
    return __spreadArray([], seen, true);
}
// ---------------------------------------------------------------------------
// NoteType inference
// ---------------------------------------------------------------------------
function inferNoteType(frontmatter, relativePath) {
    // 1. Frontmatter field (type takes precedence over note_type)
    for (var _i = 0, _a = ["type", "note_type"]; _i < _a.length; _i++) {
        var key = _a[_i];
        var val = frontmatter[key];
        if (val && typeof val === "string") {
            var normalized = val.toLowerCase().trim();
            if (normalized === "tool" || normalized === "concept" || normalized === "index") {
                return normalized;
            }
        }
    }
    // 2. Path prefix
    if (relativePath.startsWith("tools/"))
        return "tool";
    if (relativePath.startsWith("concepts/"))
        return "concept";
    // 3. Filename fallback
    var stem = stemOf(relativePath).toLowerCase();
    if (stem === "index")
        return "index";
    return "concept";
}
// ---------------------------------------------------------------------------
// Title extraction
// ---------------------------------------------------------------------------
function extractTitle(frontmatter, body, relativePath) {
    // 1. frontmatter.title
    var fmTitle = frontmatter["title"];
    if (fmTitle && typeof fmTitle === "string" && fmTitle.trim()) {
        return fmTitle.trim();
    }
    // 2. First # heading in body
    var headingMatch = body.match(/^#\s+(.+)/m);
    if (headingMatch === null || headingMatch === void 0 ? void 0 : headingMatch[1]) {
        return headingMatch[1].trim();
    }
    // 3. Filename stem → title-case with spaces
    return stemOf(relativePath)
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function stemOf(relativePath) {
    var name = (0, path_1.basename)(relativePath);
    var ext = (0, path_1.extname)(name);
    return ext ? name.slice(0, -ext.length) : name;
}
function stringOrUndefined(value) {
    if (value == null)
        return undefined;
    var s = String(value).trim();
    return s || undefined;
}
