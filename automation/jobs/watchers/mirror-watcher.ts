import chokidar, { type FSWatcher } from "chokidar";
import { join } from "path";
import { existsSync } from "fs";
import { spawn, type ChildProcess } from "child_process";

import { runMirrorTs, type MirrorTsOptions } from "../../scripts/mirror-codebase.js";
import { runMirrorPy, type MirrorPyOptions } from "../../scripts/mirror-codebase-py.js";
import type { WorkspaceLanguage, WorkspaceRegistry } from "../../workspaces/workspace-registry.js";
import type { SummarizeWorkerConfig } from "../summarize-worker.js";

// ---------------------------------------------------------------------------
// Defaults (mirror the CLI defaults from each script)
// ---------------------------------------------------------------------------

const DEFAULT_TS_OMIT = ["dist", "node_modules", "_legacy", ".claude", "*.d.ts"];
const DEFAULT_PY_OMIT = ["__pycache__", "*.pyi", ".venv", "env", "venv", "dist", "node_modules"];

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
// Worker process tracking — module-level, shared across all watcher instances
// ---------------------------------------------------------------------------

// Active summarize-worker child processes, keyed by workspace name.
const activeWorkers = new Map<string, ChildProcess>();

// Workspaces that had a source change while a worker was running.
// A new worker will be spawned once the current one exits.
const pendingRerun = new Set<string>();

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
  /** Personalities directory — enables tiered summarization after mirroring. */
  personalitiesDir?: string;
  /** md_db/ root — required for tag collection when personalitiesDir is set. */
  mdDbPath?: string;
  /** Path to workspaces.json — passed to summarize-worker for registry reload. */
  workspacesPath?: string;
  /** Workspace registry — kept for source-path resolution (not serialized to worker). */
  registry?: WorkspaceRegistry;
}

// ---------------------------------------------------------------------------
// Config-driven watcher (new — used by WorkspaceRegistry)
// ---------------------------------------------------------------------------

/**
 * Start a chokidar watcher for a single workspace. Watches source files
 * matching the configured languages and regenerates mirrors on change.
 * After mirrors complete, spawns a detached summarize-worker child process.
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
    } catch {
      return;
    }

    // Spawn summarize worker if configured — fire-and-forget, never blocks TUI
    if (config.personalitiesDir && config.mdDbPath && config.workspacesPath) {
      spawnSummarizeWorker(config);
    }
  }

  watcher.on("add", scheduleRun);
  watcher.on("change", scheduleRun);
  watcher.on("unlink", scheduleRun);

  return watcher;
}

// ---------------------------------------------------------------------------
// Summarize worker spawning
// ---------------------------------------------------------------------------

/**
 * Resolve the tsx binary from the project's node_modules.
 * Returns null if not found (summarization silently skipped).
 */
function findTsxBin(rootDir: string): string | null {
  // .cmd is the Windows batch wrapper; bare tsx works on Unix
  for (const name of ["tsx.cmd", "tsx"]) {
    const p = join(rootDir, "node_modules", ".bin", name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Spawn summarize-worker.ts as a child process for the given workspace.
 *
 * If a worker is already running for this workspace, defers one re-run
 * until the current worker exits — prevents pile-up from rapid saves.
 *
 * stdout/stderr from the worker are forwarded to the parent console so
 * summarization progress is visible in the Pi terminal.
 *
 * child.unref() means the Pi TUI can exit without waiting for the worker.
 */
function spawnSummarizeWorker(config: WorkspaceMirrorConfig): void {
  const workspace = config.workspace;

  // Worker already running for this workspace — defer one re-run
  if (activeWorkers.has(workspace)) {
    pendingRerun.add(workspace);
    return;
  }

  // rootDir is one level above mdDbPath (md_db/ lives at project root)
  const rootDir = join(config.mdDbPath!, "..");

  const tsx = findTsxBin(rootDir);
  if (!tsx) return;

  const workerScript = join(rootDir, "automation", "jobs", "summarize-worker.ts");
  if (!existsSync(workerScript)) return;

  const workerConfig: SummarizeWorkerConfig = {
    mirrorDir: config.mirrorDir,
    mdDbPath: config.mdDbPath!,
    rootDir: config.sourceDir,
    workspacesPath: config.workspacesPath!,
    personalitiesDir: config.personalitiesDir!,
  };

  const child = spawn(tsx, [workerScript, JSON.stringify(workerConfig)], {
    cwd: rootDir,
    shell: true,                    // required for .cmd files on Windows
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },        // inherit LLM host, API keys, conda path, etc.
  });

  activeWorkers.set(workspace, child);

  // Drain stdout/stderr to prevent the pipe buffer from blocking the worker
  child.stdout?.resume();
  child.stderr?.resume();

  child.on("exit", () => {
    activeWorkers.delete(workspace);

    // If a source change arrived while we were running, do one more pass
    if (pendingRerun.has(workspace)) {
      pendingRerun.delete(workspace);
      spawnSummarizeWorker(config);
    }
  });

  // Parent (Pi TUI) can exit without waiting for the worker to finish
  child.unref();
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
