/**
 * run-workspace-mirror.ts
 *
 * Language-agnostic orchestrator for the full mirror + cleanup pipeline.
 *
 * Responsibilities:
 *   1. Run runMirrorTs and/or runMirrorPy for every configured language.
 *   2. Union the validPaths sets returned by each language mirror.
 *   3. Call cleanMirrorDir exactly once with the combined set so stale notes
 *      are removed regardless of which language produced them.
 *
 * Safety contract:
 *   If any configured language mirror throws, cleanup is skipped for that
 *   run. An incomplete validPaths set would cause the other language's notes
 *   to be incorrectly pruned.  The caller still gets accurate written counts
 *   for the languages that succeeded.
 *
 * This module is imported by:
 *   - automation/jobs/watchers/mirror-watcher.ts   (file-change runs)
 *   - automation/workspaces/workspace-registry.ts  (register() initial run)
 *   - entry/stack.ts                               (startup re-mirror pass)
 *   - automation/scripts/mirror-workspaces.ts      (CLI)
 */

import { runMirrorTs } from "./mirror-codebase.js";
import { runMirrorPy } from "./mirror-codebase-py.js";
import { cleanMirrorDir } from "./mirror-cleanup.js";
import type { WorkspaceLanguage } from "../workspaces/workspace-registry.js";

// ---------------------------------------------------------------------------
// Defaults (mirrors the per-script defaults)
// ---------------------------------------------------------------------------

const DEFAULT_TS_OMIT = ["dist", "node_modules", "_legacy", ".claude", "*.d.ts"];
const DEFAULT_PY_OMIT = ["__pycache__", "*.pyi", ".venv", "env", "venv", "dist", "node_modules"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceMirrorRunOptions {
  /** Absolute path to the source directory to scan. */
  scanDir: string;
  /** Absolute path to the mirror output directory (e.g. md_db/code/{name}). */
  mirrorDir: string;
  /** Which languages to mirror. */
  languages: WorkspaceLanguage[];
  /** Force-regenerate all notes even if mirror is up-to-date. */
  force: boolean;
  /** Workspace name — written into note frontmatter. */
  workspace?: string;
  /** Wikilink prefix for cross-note references (e.g. "code/obsidi-claw"). */
  wikilinkPrefix?: string;
  /** Per-language omit pattern overrides. Falls back to per-script defaults. */
  omitPatterns?: Partial<Record<WorkspaceLanguage, string[]>>;
}

export interface WorkspaceMirrorRunResult {
  tsWritten: number;
  pyWritten: number;
  /** Number of stale notes deleted from mirrorDir. 0 if cleanup was skipped. */
  cleaned: number;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runWorkspaceMirror(
  opts: WorkspaceMirrorRunOptions,
): Promise<WorkspaceMirrorRunResult> {
  const combinedValidPaths = new Set<string>();
  let tsWritten = 0;
  let pyWritten = 0;
  let allSucceeded = true;

  if (opts.languages.includes("ts")) {
    try {
      const result = await runMirrorTs({
        scanDir: opts.scanDir,
        mirrorDir: opts.mirrorDir,
        omitPatterns: opts.omitPatterns?.ts ?? DEFAULT_TS_OMIT,
        force: opts.force,
        workspace: opts.workspace,
        wikilinkPrefix: opts.wikilinkPrefix,
      });
      tsWritten = result.written;
      for (const p of result.validPaths) combinedValidPaths.add(p);
    } catch (err) {
      allSucceeded = false;
      console.warn(
        `[mirror-workspace] TS mirror failed for ${opts.workspace ?? opts.scanDir}: ${err}`,
      );
    }
  }

  if (opts.languages.includes("py")) {
    try {
      const result = await runMirrorPy({
        scanDir: opts.scanDir,
        mirrorDir: opts.mirrorDir,
        omitPatterns: opts.omitPatterns?.py ?? DEFAULT_PY_OMIT,
        force: opts.force,
        workspace: opts.workspace,
        wikilinkPrefix: opts.wikilinkPrefix,
      });
      pyWritten = result.written;
      for (const p of result.validPaths) combinedValidPaths.add(p);
    } catch (err) {
      allSucceeded = false;
      console.warn(
        `[mirror-workspace] PY mirror failed for ${opts.workspace ?? opts.scanDir}: ${err}`,
      );
    }
  }

  // Only prune stale notes when all enabled mirrors succeeded.
  // A partial failure means validPaths is incomplete — cleaning would delete
  // notes whose source files still exist but weren't covered by the failed run.
  let cleaned = 0;
  if (allSucceeded && combinedValidPaths.size > 0) {
    cleaned = cleanMirrorDir(opts.mirrorDir, combinedValidPaths);
  }

  return { tsWritten, pyWritten, cleaned };
}
