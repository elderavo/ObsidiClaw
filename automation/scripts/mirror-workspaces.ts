#!/usr/bin/env npx tsx
/**
 * mirror-workspaces.ts
 *
 * Combined CLI that runs the full mirror + cleanup pipeline for every active
 * workspace registered in .obsidi-claw/workspaces.json.
 *
 * Unlike the per-language CLIs (mirror-codebase.ts / mirror-codebase-py.ts),
 * this script processes both TS and PY mirrors for each workspace and then
 * calls cleanMirrorDir once with the *union* of both languages' validPaths —
 * preventing any one language's notes from being incorrectly pruned.
 *
 * This is the recommended CLI for ad-hoc and CI use.
 *
 * Usage:
 *   npx tsx automation/scripts/mirror-workspaces.ts [--force]
 *
 * Options:
 *   --force    Regenerate all notes even if mirror is up-to-date
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { runWorkspaceMirror } from "./run-workspace-mirror.js";
import type { WorkspaceLanguage } from "../workspaces/workspace-registry.js";

const __filename = fileURLToPath(import.meta.url);

interface WorkspaceEntry {
  name: string;
  sourceDir: string;
  languages: string[];
  active: boolean;
  omitPatterns?: Partial<Record<string, string[]>>;
}

async function main() {
  const force = process.argv.includes("--force");
  const cwd = process.cwd();
  const registryPath = path.join(cwd, ".obsidi-claw", "workspaces.json");
  const mdDbPath = path.join(cwd, "md_db");

  let workspaces: WorkspaceEntry[] = [];
  try {
    const raw = fs.readFileSync(registryPath, "utf8");
    workspaces = (JSON.parse(raw) as WorkspaceEntry[]).filter((w) => w.active);
  } catch {
    console.error(
      "[mirror-workspaces] Could not load .obsidi-claw/workspaces.json — run this from the project root.",
    );
    process.exit(1);
  }

  if (workspaces.length === 0) {
    console.log("[mirror-workspaces] No active workspaces found.");
    return;
  }

  for (const ws of workspaces) {
    const languages = ws.languages.filter((l): l is WorkspaceLanguage =>
      l === "ts" || l === "py",
    );
    if (languages.length === 0) continue;

    const mirrorDir = path.join(mdDbPath, "code", ws.name);
    console.log(`[mirror-workspaces] ${ws.name} (${ws.sourceDir})`);

    const result = await runWorkspaceMirror({
      scanDir: ws.sourceDir,
      mirrorDir,
      languages,
      force,
      workspace: ws.name,
      wikilinkPrefix: `code/${ws.name}`,
      omitPatterns: ws.omitPatterns as Partial<Record<WorkspaceLanguage, string[]>> | undefined,
    });

    console.log(
      `  ts=${result.tsWritten} py=${result.pyWritten} cleaned=${result.cleaned}`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
