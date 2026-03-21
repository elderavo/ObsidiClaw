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
import type { PersonalityConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a personality by name from the given directory.
 * Returns null if the file doesn't exist.
 */
export function loadPersonality(
  name: string,
  personalitiesDir: string,
): PersonalityConfig | null {
  const filePath = join(personalitiesDir, `${name}.md`);

  if (!fileExists(filePath)) {
    return null;
  }

  const raw = readText(filePath);
  const { frontmatter, body } = splitFrontmatter(raw);

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
export function listPersonalities(personalitiesDir: string): string[] {
  if (!fileExists(personalitiesDir)) {
    return [];
  }

  return listDir(personalitiesDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

interface Frontmatter {
  [key: string]: unknown;
}

function splitFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const lines = content.split("\n");

  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: content };
  }

  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      closingIdx = i;
      break;
    }
  }

  if (closingIdx === -1) {
    return { frontmatter: {}, body: content };
  }

  const fmLines = lines.slice(1, closingIdx);
  const frontmatter = parseFrontmatterLines(fmLines);
  const body = lines.slice(closingIdx + 1).join("\n").trimStart();

  return { frontmatter, body };
}

/**
 * Simple YAML-like parser that handles:
 *   key: value
 *   key:
 *     nested_key: nested_value
 *   key:
 *     - list_item
 *
 * Good enough for personality frontmatter (type, title, provider.model, etc.)
 */
function parseFrontmatterLines(lines: string[]): Frontmatter {
  const result: Frontmatter = {};
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
    } else {
      // Check for nested block or list
      const nested: Frontmatter = {};
      const listItems: string[] = [];
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
        } else {
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
      } else if (Object.keys(nested).length > 0) {
        result[key] = nested;
      } else {
        result[key] = null;
      }

      i = j;
    }
  }

  return result;
}

/**
 * Extract provider config from parsed frontmatter.
 * Handles both flat and nested formats:
 *   provider:
 *     model: llama3
 *     baseUrl: http://...
 */
function extractProvider(
  fm: Frontmatter,
): PersonalityConfig["provider"] | undefined {
  const provider = fm["provider"];
  if (!provider || typeof provider !== "object") return undefined;

  const p = provider as Frontmatter;
  const model = typeof p["model"] === "string" ? p["model"] : undefined;
  const baseUrl = typeof p["baseUrl"] === "string" ? p["baseUrl"] : undefined;

  if (!model && !baseUrl) return undefined;

  return { model, baseUrl };
}
