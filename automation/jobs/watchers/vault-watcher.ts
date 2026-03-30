/**
 * Vault mirror watcher for "know" workspaces.
 *
 * Watches a subset of an Obsidian vault (permanent + synthesized note dirs)
 * and copies .md changes into md_db/know/{name}/ for LlamaIndex ingestion.
 *
 * The inbox directory is intentionally excluded — inbox notes are works-in-
 * progress and only move to the indexed dirs after the pipeline approves them.
 */

import chokidar, { type FSWatcher } from "chokidar";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { dirname, join, relative } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VaultWatcherConfig {
  /** Absolute path to the vault root (e.g. C:\Users\Alex\VaultusSapiens). */
  sourceDir: string;
  /** Absolute path to mirror output dir (e.g. md_db/know/vaultus-sapiens). */
  mirrorDir: string;
  /**
   * Vault-relative subdirectories to index.
   * Default: ["notes/permanent", "notes/synthesized"]
   */
  indexDirs?: string[];
}

const DEFAULT_INDEX_DIRS = ["notes/permanent", "notes/synthesized"];

// ---------------------------------------------------------------------------
// Initial sync
// ---------------------------------------------------------------------------

/**
 * Synchronously copy all .md files from vault index dirs to mirrorDir.
 * Called once during workspace registration to seed the index.
 * Returns the number of files copied.
 */
export function runInitialVaultCopy(
  sourceDir: string,
  mirrorDir: string,
  indexDirs: string[] = DEFAULT_INDEX_DIRS,
): { count: number } {
  mkdirSync(mirrorDir, { recursive: true });
  let count = 0;
  for (const subdir of indexDirs) {
    const srcDir = join(sourceDir, subdir);
    if (!existsSync(srcDir)) continue;
    count += copyMdRecursive(srcDir, mirrorDir, sourceDir);
  }
  return { count };
}

function copyMdRecursive(srcDir: string, mirrorDir: string, baseDir: string): number {
  let count = 0;
  let entries: string[];
  try {
    entries = readdirSync(srcDir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const srcPath = join(srcDir, name);
    try {
      const st = statSync(srcPath);
      if (st.isDirectory()) {
        count += copyMdRecursive(srcPath, mirrorDir, baseDir);
      } else if (name.endsWith(".md")) {
        const rel = relative(baseDir, srcPath).replace(/\\/g, "/");
        const dest = join(mirrorDir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(srcPath, dest);
        count++;
      }
    } catch {
      continue;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

/**
 * Start a vault mirror watcher. Copies .md changes from index dirs to mirrorDir.
 * The reindex watcher in stack.ts picks up the copied files automatically.
 */
export function startVaultWatcher(config: VaultWatcherConfig): FSWatcher {
  const { sourceDir, mirrorDir } = config;
  const indexDirs = config.indexDirs ?? DEFAULT_INDEX_DIRS;

  mkdirSync(mirrorDir, { recursive: true });

  const watchPaths = indexDirs
    .map((d) => join(sourceDir, d).replace(/\\/g, "/"));

  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: false,
    ignored: /(^|[/\\])\./,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  function toDest(src: string): string {
    const rel = relative(sourceDir, src).replace(/\\/g, "/");
    return join(mirrorDir, rel);
  }

  function copyFile(src: string): void {
    if (!src.endsWith(".md")) return;
    const dest = toDest(src);
    try {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    } catch {
      // ignore — file may be temporarily locked on Windows
    }
  }

  function removeFile(src: string): void {
    if (!src.endsWith(".md")) return;
    const dest = toDest(src);
    try {
      if (existsSync(dest)) unlinkSync(dest);
    } catch {
      // ignore
    }
  }

  watcher.on("add", copyFile);
  watcher.on("change", copyFile);
  watcher.on("unlink", removeFile);

  return watcher;
}
