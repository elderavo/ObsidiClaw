import chokidar, { type FSWatcher } from "chokidar";
import { join } from "path";

import { runMirrorTs, type MirrorTsOptions } from "../../scripts/mirror-codebase.js";
import { runMirrorPy, type MirrorPyOptions } from "../../scripts/mirror-codebase-py.js";

// ---------------------------------------------------------------------------
// Defaults (mirror the CLI defaults from each script)
// ---------------------------------------------------------------------------

const DEFAULT_TS_OMIT = ["dist", "node_modules", "_legacy", ".claude", "*.d.ts"];
const DEFAULT_PY_OMIT = ["__pycache__", "*.pyi", ".venv", "env", "venv", "dist"];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MirrorWatcherOptions {
  /**
   * Debounce window before regenerating (ms).
   * Any source file change resets the timer. Default: 3000
   *
   * Longer than the lint watcher (2500ms) since any single change can affect
   * the cross-file call graph — we want to batch rapid saves before running.
   */
  debounceMs?: number;
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

/**
 * Start a chokidar watcher that regenerates code mirror notes whenever a
 * TypeScript or Python source file is added or changed.
 *
 * Watches:
 *   {rootDir}/**\/*.ts          (excluding dist, node_modules, md_db, etc.)
 *   {rootDir}/knowledge_graph/**\/*.py
 *
 * On change: debounces {debounceMs}ms then runs both mirrors with force:true
 * so cross-file call-in edges are always fresh.
 *
 * Running two chokidar FSWatchers (this + md-db-lint-watcher) is safe —
 * they watch disjoint paths (.ts/.py vs .md). The lint watcher will fire
 * when mirror writes new .md files to md_db/code/, which is harmless.
 */
export function startMirrorWatcher(
  rootDir: string,
  mirrorDir: string,
  options?: MirrorWatcherOptions,
): FSWatcher {
  const debounceMs = options?.debounceMs ?? 3000;

  const watcher = chokidar.watch(
    [
      join(rootDir, "**/*.ts"),
      join(rootDir, "knowledge/graph/**/*.py"),
    ],
    {
      ignored: [
        /[/\\]dist[/\\]/,
        /[/\\]node_modules[/\\]/,
        /[/\\]_legacy[/\\]/,
        /[/\\]\.claude[/\\]/,
        /[/\\]md_db[/\\]/,
        /[/\\]__pycache__[/\\]/,
        /\.d\.ts$/,
      ],
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    },
  );

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleRun(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void runBoth();
    }, debounceMs);
  }

  async function runBoth(): Promise<void> {
    const tsOpts: MirrorTsOptions = {
      scanDir: rootDir,
      mirrorDir,
      omitPatterns: DEFAULT_TS_OMIT,
      force: true,
    };
    const pyOpts: MirrorPyOptions = {
      scanDir: join(rootDir, "knowledge", "graph"),
      mirrorDir,
      omitPatterns: DEFAULT_PY_OMIT,
      force: true,
    };

    try {
      const ts = await runMirrorTs(tsOpts);
      const py = await runMirrorPy(pyOpts);
      // console.log(
      //   `[mirror-watcher] ts: ${ts.written} written — py: ${py.written} written`,
      // );
    } catch (err) {
      console.warn("[mirror-watcher] regeneration failed:", err);
    }
  }

  watcher.on("add", scheduleRun);
  watcher.on("change", scheduleRun);

  return watcher;
}
