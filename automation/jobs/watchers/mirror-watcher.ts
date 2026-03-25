import chokidar, { type FSWatcher } from "chokidar";
import { join } from "path";

import { runMirrorTs, type MirrorTsOptions } from "../../scripts/mirror-codebase.js";
import { runMirrorPy, type MirrorPyOptions } from "../../scripts/mirror-codebase-py.js";
import type { WorkspaceLanguage } from "../../workspaces/workspace-registry.js";

// ---------------------------------------------------------------------------
// Defaults (mirror the CLI defaults from each script)
// ---------------------------------------------------------------------------

const DEFAULT_TS_OMIT = ["dist", "node_modules", "_legacy", ".claude", "*.d.ts"];
const DEFAULT_PY_OMIT = ["__pycache__", "*.pyi", ".venv", "env", "venv", "dist"];

// Glob patterns per language — appended to sourceDir
const LANG_GLOBS: Record<WorkspaceLanguage, string> = {
  ts: "**/*.ts",
  py: "**/*.py",
};

// Common directories to ignore regardless of language
const COMMON_IGNORED: RegExp[] = [
  /[/\\]dist[/\\]/,
  /[/\\]node_modules[/\\]/,
  /[/\\]_legacy[/\\]/,
  /[/\\]\.claude[/\\]/,
  /[/\\]md_db[/\\]/,
  /[/\\]__pycache__[/\\]/,
  /[/\\]\.venv[/\\]/,
  /[/\\]\.obsidi-claw[/\\]/,
  /\.d\.ts$/,
];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MirrorWatcherOptions {
  /**
   * Debounce window before regenerating (ms).
   * Any source file change resets the timer. Default: 3000
   */
  debounceMs?: number;
}

/** Config describing a workspace's mirror pipeline. */
export interface WorkspaceMirrorConfig {
  /** Absolute path to the source directory to watch. */
  sourceDir: string;
  /** Absolute path to mirror output directory (e.g. md_db/code/{name}). */
  mirrorDir: string;
  /** Workspace name — written into note frontmatter. */
  workspace: string;
  /** Wikilink prefix for cross-note references (e.g. "code/obsidi-claw"). */
  wikilinkPrefix: string;
  /** Which languages to mirror. */
  languages: WorkspaceLanguage[];
  /** Per-language omit pattern overrides. Falls back to defaults. */
  omitPatterns?: Partial<Record<WorkspaceLanguage, string[]>>;
}

// ---------------------------------------------------------------------------
// Config-driven watcher (new — used by WorkspaceRegistry)
// ---------------------------------------------------------------------------

/**
 * Start a chokidar watcher for a single workspace. Watches source files
 * matching the configured languages and regenerates mirrors on change.
 */
export function startWorkspaceMirrorWatcher(
  config: WorkspaceMirrorConfig,
  options?: MirrorWatcherOptions,
): FSWatcher {
  const debounceMs = options?.debounceMs ?? 3000;

  // Build watch globs from languages
  const watchPaths = config.languages.map((lang) =>
    join(config.sourceDir, LANG_GLOBS[lang]),
  );

  const watcher = chokidar.watch(watchPaths, {
    ignored: COMMON_IGNORED,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleRun(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void runMirrors();
    }, debounceMs);
  }

  async function runMirrors(): Promise<void> {
    const tsOmit = config.omitPatterns?.ts ?? DEFAULT_TS_OMIT;
    const pyOmit = config.omitPatterns?.py ?? DEFAULT_PY_OMIT;

    try {
      const promises: Promise<unknown>[] = [];

      if (config.languages.includes("ts")) {
        const tsOpts: MirrorTsOptions = {
          scanDir: config.sourceDir,
          mirrorDir: config.mirrorDir,
          omitPatterns: tsOmit,
          force: true,
          workspace: config.workspace,
          wikilinkPrefix: config.wikilinkPrefix,
        };
        promises.push(runMirrorTs(tsOpts));
      }

      if (config.languages.includes("py")) {
        const pyOpts: MirrorPyOptions = {
          scanDir: config.sourceDir,
          mirrorDir: config.mirrorDir,
          omitPatterns: pyOmit,
          force: true,
          workspace: config.workspace,
          wikilinkPrefix: config.wikilinkPrefix,
        };
        promises.push(runMirrorPy(pyOpts));
      }

      await Promise.all(promises);
    } catch (err) {
      console.warn(`[mirror-watcher:${config.workspace}] regeneration failed:`, err);
    }
  }

  watcher.on("add", scheduleRun);
  watcher.on("change", scheduleRun);
  watcher.on("unlink", scheduleRun);

  return watcher;
}

// ---------------------------------------------------------------------------
// Legacy watcher (deprecated — used by old stack.ts until Phase 5 cutover)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use startWorkspaceMirrorWatcher instead.
 */
export function startMirrorWatcher(
  rootDir: string,
  mirrorDir: string,
  options?: MirrorWatcherOptions,
): FSWatcher {
  return startWorkspaceMirrorWatcher(
    {
      sourceDir: rootDir,
      mirrorDir,
      workspace: "",
      wikilinkPrefix: "code",
      languages: ["ts", "py"],
    },
    options,
  );
}
