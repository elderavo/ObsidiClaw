import { basename, join, resolve } from "path";
import { fileURLToPath } from "url";
import { lstatSync } from "fs";

import { resolvePaths } from "../../core/config.js";
import { fileExists, readText, writeText, listDir } from "../../core/os/fs.js";

const START_MARKER = "<!-- obsidi-claw: directory tree (auto-generated) -->";
const END_MARKER = "<!-- /obsidi-claw: directory tree -->";

const DEFAULT_IGNORES = new Set([
  "node_modules",
  "dist",
  ".git",
  ".obsidi-claw",
  ".obsidian",
  ".venv",
  ".cache",
]);

function buildDirectoryTreeLines(rootDir: string, ignoreNames: Set<string>): string[] {
  const lines: string[] = [];

  function walk(dir: string, depth: number): void {
    let entries: string[];
    try {
      entries = listDir(dir);
    } catch {
      return;
    }

    const sorted = entries.filter((name) => !ignoreNames.has(name)).sort((a, b) => a.localeCompare(b));

    for (const name of sorted) {
      const fullPath = join(dir, name);
      let stats: ReturnType<typeof lstatSync>;
      try {
        stats = lstatSync(fullPath);
      } catch {
        continue;
      }

      if (stats.isSymbolicLink()) continue;
      if (!stats.isDirectory()) continue;

      lines.push(`${"  ".repeat(depth + 1)}- ${name}/`);
      walk(fullPath, depth + 1);
    }
  }

  walk(rootDir, 0);
  return lines;
}

/**
 * Build a formatted directory tree string for injection as ephemeral startup context.
 * Pure function — no file I/O.
 */
export function buildDirectoryTree(rootDir: string): string {
  const treeLines = buildDirectoryTreeLines(rootDir, DEFAULT_IGNORES);
  const rootLabel = basename(rootDir) || rootDir;
  return ["```", `${rootLabel}/`, ...treeLines, "```"].join("\n");
}

/**
 * Strip the auto-generated directory tree block from a markdown file (one-time migration).
 * No-op if the block is not present. Returns true if the file was rewritten.
 */
export function stripDirectoryBlock(filePath: string): boolean {
  let current: string;
  try {
    current = readText(filePath);
  } catch {
    return false;
  }
  const startIdx = current.indexOf(START_MARKER);
  const endIdx = current.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return false;

  const stripped = (
    current.slice(0, startIdx) +
    current.slice(endIdx + END_MARKER.length)
  ).replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

  if (stripped === current) return false;
  try {
    writeText(filePath, stripped);
    return true;
  } catch {
    return false;
  }
}

/**
 * @deprecated Use buildDirectoryTree() for ephemeral context injection instead.
 * Update md_db/preferences.md with the latest project directory tree.
 * Returns true if the file was written.
 */
export function updateDirectory(rootDir: string, mdDbPath: string): boolean {
  const prefsPath = join(mdDbPath, "preferences.md");
  if (!fileExists(prefsPath)) return false;

  const treeLines = buildDirectoryTreeLines(rootDir, DEFAULT_IGNORES);
  const rootLabel = basename(rootDir) || rootDir;
  const timestamp = new Date().toISOString().replace("T", " ").replace("Z", " UTC");

  const blockLines = [
    START_MARKER,
    "",
    `## Project directory tree (auto-generated ${timestamp})`,
    "",
    `Root: ${rootDir}`,
    "",
    "```",
    `${rootLabel}/`,
    ...treeLines,
    "```",
    "",
    END_MARKER,
  ];
  const newBlock = blockLines.join("\n");

  let current: string;
  try {
    current = readText(prefsPath);
  } catch {
    return false;
  }

  let next: string;

  const startIdx = current.indexOf(START_MARKER);
  const endIdx = current.indexOf(END_MARKER);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    next = current.slice(0, startIdx) + newBlock + current.slice(endIdx + END_MARKER.length);
  } else {
    const trimmed = current.trimEnd();
    next = `${trimmed}\n\n${newBlock}\n`;
  }

  if (next === current) return false;

  try {
    writeText(prefsPath, next);
    return true;
  } catch {
    return false;
  }
}
