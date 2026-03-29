/**
 * ObsidiClawStack — shared infrastructure factory.
 *
 * Creates and manages the core runtime components (ContextEngine, RunLogger,
 * NoteMetricsLogger, WorkspaceRegistry) that all entry points need. Each
 * process creates its own stack instance; SQLite WAL mode handles concurrent
 * access.
 *
 * Consumers:
 *   - entry/extension.ts  (Pi TUI path)
 */

import { join, relative, resolve } from "path";
import { randomUUID } from "crypto";

import chokidar, { type FSWatcher } from "chokidar";
import { RunLogger } from "../logger/run-logger.js";
import { NoteMetricsLogger } from "../logger/note-metrics.js";
import { ContextEngine } from "../knowledge/engine/context-engine.js";
import { resolvePaths, type ObsidiClawPaths } from "../core/config.js";
import type { RunEvent } from "../logger/types.js";
import { startMdDbLintWatcher } from "../automation/jobs/watchers/md-db-lint-watcher.js";
import { runMirrorTs } from "../automation/scripts/mirror-codebase.js";
import { runMirrorPy } from "../automation/scripts/mirror-codebase-py.js";
import { WorkspaceRegistry } from "../automation/workspaces/workspace-registry.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface StackOptions {
  /** Project root directory. Falls back to process.cwd(). */
  rootDir?: string;
  /**
   * Enable debug JSONL. Default: ON (set OBSIDI_CLAW_DEBUG=0 to disable).
   * When true, all events are also written to .obsidi-claw/debug/{sessionId}.jsonl.
   */
  debug?: boolean;
}

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

export interface ObsidiClawStack {
  readonly engine: ContextEngine;
  readonly logger: RunLogger;
  readonly noteMetrics: NoteMetricsLogger;
  readonly sessionId: string;
  readonly paths: ObsidiClawPaths;
  readonly workspaceRegistry: WorkspaceRegistry;

  /** Initialize the context engine and start all watchers. */
  initialize(): Promise<void>;
  /** Graceful shutdown: close engine + logger. */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createObsidiClawStack(opts: StackOptions = {}): ObsidiClawStack {
  const paths = resolvePaths(opts.rootDir);
  const sessionId = randomUUID();

  // ── Debug mode ──────────────────────────────────────────────────────────
  const debugExplicit = opts.debug;
  const debugFromEnv = !["0", "false"].includes(
    (process.env["OBSIDI_CLAW_DEBUG"] ?? "").toLowerCase(),
  );
  const debugEnabled = debugExplicit ?? debugFromEnv;

  // ── RunLogger ───────────────────────────────────────────────────────────
  const logger = new RunLogger({
    dbPath: paths.dbPath,
    ...(debugEnabled
      ? { debugDir: resolve(paths.rootDir, ".obsidi-claw/debug") }
      : {}),
    onRetrievalError: (sessionId, runId, timestamp, errorPayload) => {
      noteMetrics.logRetrievalError({ sessionId, runId: runId ?? undefined, timestamp, errorPayload });
    },
  });

  // ── NoteMetricsLogger ──────────────────────────────────────────────────
  const noteMetrics = new NoteMetricsLogger(paths.notesDbPath);

  // ── WorkspaceRegistry ─────────────────────────────────────────────────
  const workspaceRegistry = new WorkspaceRegistry(paths.workspacesPath, paths.mdDbPath, paths.personalitiesDir);

  // ── ContextEngine ───────────────────────────────────────────────────────
  const engine = new ContextEngine({
    mdDbPath: paths.mdDbPath,
    onDebug: (event) => {
      logger.logEvent({
        ...event,
        sessionId: (event as Record<string, unknown>)["sessionId"] as string ?? sessionId,
        runId: (event as Record<string, unknown>)["runId"] as string ?? "",
      } as RunEvent);
    },
  });

  // ── md_db watcher (lint on change) ───────────────────────────────────────
  let mdDbWatcher: ReturnType<typeof startMdDbLintWatcher> | undefined;

  // ── md_db reindex watcher (incremental update on change) ────────────────
  let reindexWatcher: FSWatcher | undefined;

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async function initialize(): Promise<void> {
    // ── Phase 1: mirrors ───────────────────────────────────────────────────
    // Mirrors MUST finish before the engine initializes. The engine computes
    // a content hash of md_db/ on startup to decide fast vs. slow path.
    // If mirrors run concurrently with engine init, file writes change content
    // after the hash is stored → full re-embed every startup.
    workspaceRegistry.load();

    try {
      if (workspaceRegistry.list().length === 0) {
        // First boot: auto-register ObsidiClaw's own source tree
        await workspaceRegistry.register({
          name: "obsidi-claw",
          sourceDir: paths.rootDir,
          mode: "code",
          languages: ["ts", "py"],
          active: true,
        });
      } else {
        // Subsequent boots: re-run mirrors for all active workspaces
        // (mtime check makes this fast — skips up-to-date notes)
        for (const entry of workspaceRegistry.list()) {
          if (entry.active && entry.mode === "code") {
            const mirrorDir = workspaceRegistry.mirrorDir(entry);
            const prefix = WorkspaceRegistry.wikilinkPrefix(entry);
            const promises: Promise<unknown>[] = [];
            if (entry.languages.includes("ts")) {
              promises.push(runMirrorTs({
                scanDir: entry.sourceDir, mirrorDir,
                omitPatterns: entry.omitPatterns?.ts ?? ["dist", "node_modules", "_legacy", ".claude", "*.d.ts"],
                force: false, workspace: entry.name, wikilinkPrefix: prefix,
              }));
            }
            if (entry.languages.includes("py")) {
              promises.push(runMirrorPy({
                scanDir: entry.sourceDir, mirrorDir,
                omitPatterns: entry.omitPatterns?.py ?? ["__pycache__", "*.pyi", ".venv", "env", "venv", "dist", "node_modules"],
                force: false, workspace: entry.name, wikilinkPrefix: prefix,
              }));
            }
            await Promise.all(promises);
          }
        }
      }
    } catch (err) {
      logger.logEvent({
        type: "diagnostic",
        sessionId,
        runId: "",
        timestamp: Date.now(),
        module: "stack",
        level: "error",
        message: `workspace initialization failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // ── Phase 2: engine init (sees settled md_db, hash is stable) ─────────
    await engine.initialize();

    // Watchers are cheap — start after everything else is up.
    mdDbWatcher = startMdDbLintWatcher(paths.mdDbPath);
    workspaceRegistry.startAllWatchers();
    reindexWatcher = startMdDbReindexWatcher(paths.mdDbPath, engine);
  }

  async function shutdown(): Promise<void> {
    if (reindexWatcher) {
      await reindexWatcher.close();
      reindexWatcher = undefined;
    }
    await workspaceRegistry.stopAllWatchers();
    if (mdDbWatcher) {
      await mdDbWatcher.close();
      mdDbWatcher = undefined;
    }
    await engine.close();
    noteMetrics.close();
    logger.close();
  }

  return {
    engine,
    logger,
    noteMetrics,
    sessionId,
    paths,
    workspaceRegistry,
    initialize,
    shutdown,
  };
}

// ---------------------------------------------------------------------------
// md_db reindex watcher — incremental update on file change
// ---------------------------------------------------------------------------

const REINDEX_DEBOUNCE_MS = 1500;

/**
 * Watch md_db for .md file changes and trigger incremental engine updates.
 * Batches rapid changes (debounce) and sends only the changed/deleted paths.
 */
function startMdDbReindexWatcher(mdDbPath: string, engine: ContextEngine): FSWatcher {
  const pendingChanged = new Set<string>();
  const pendingDeleted = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function toRelPath(absPath: string): string {
    return relative(mdDbPath, absPath).replace(/\\/g, "/");
  }

  function scheduleFlush(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void flush();
    }, REINDEX_DEBOUNCE_MS);
  }

  async function flush(): Promise<void> {
    const changed = [...pendingChanged];
    const deleted = [...pendingDeleted];
    pendingChanged.clear();
    pendingDeleted.clear();

    const changedFiltered = changed.filter((p) => !deleted.includes(p));
    if (changedFiltered.length === 0 && deleted.length === 0) return;

    try {
      await engine.incrementalUpdate(changedFiltered, deleted);
    } catch {
      // Engine might not be initialized yet or subprocess crashed — swallow
    }
  }

  const watcher = chokidar.watch(mdDbPath, {
    ignored: [/\.obsidian/, /\.obsidi-claw/],
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  function handleChange(absPath: string): void {
    if (!absPath.endsWith(".md")) return;
    const rel = toRelPath(absPath);
    pendingChanged.add(rel);
    pendingDeleted.delete(rel);
    scheduleFlush();
  }

  function handleUnlink(absPath: string): void {
    if (!absPath.endsWith(".md")) return;
    const rel = toRelPath(absPath);
    pendingDeleted.add(rel);
    pendingChanged.delete(rel);
    scheduleFlush();
  }

  watcher.on("add", handleChange);
  watcher.on("change", handleChange);
  watcher.on("unlink", handleUnlink);

  return watcher;
}
