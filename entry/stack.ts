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

import { join, relative } from "path";
import { randomUUID } from "crypto";

import chokidar from "chokidar";
import { RunLogger } from "../logger/run-logger.js";
import { NoteMetricsLogger } from "../logger/note-metrics.js";
import { ContextEngine } from "../knowledge/engine/context-engine.js";
import { resolvePaths, type ObsidiClawPaths } from "../core/config.js";
import type { RunEvent } from "../logger/types.js";
import { startMdDbLintWatcher } from "../automation/jobs/watchers/md-db-lint-watcher.js";
import { runWorkspaceMirror } from "../automation/scripts/run-workspace-mirror.js";
import { WorkspaceRegistry } from "../automation/workspaces/workspace-registry.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface StackOptions {
  /** Project root directory. Falls back to process.cwd(). */
  rootDir?: string;
  /** Session ID override. Generated if not provided. */
  sessionId?: string;
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
  const sessionId = opts.sessionId ?? randomUUID();
  const reviewEnabledRaw = (process.env["OBSIDI_CONTEXT_REVIEW"] ?? "1").toLowerCase();
  const reviewEnabled = !(reviewEnabledRaw === "0" || reviewEnabledRaw === "false" || reviewEnabledRaw === "off");

  // ── RunLogger ───────────────────────────────────────────────────────────
  const logger = new RunLogger({
    dbPath: paths.dbPath,
    onRetrievalError: (sid, timestamp, errorPayload) => {
      noteMetrics.logRetrievalError({ sessionId: sid, timestamp, errorPayload });
    },
  });

  // ── NoteMetricsLogger ──────────────────────────────────────────────────
  const noteMetrics = new NoteMetricsLogger(paths.notesDbPath);

  // ── WorkspaceRegistry ─────────────────────────────────────────────────
  const workspaceRegistry = new WorkspaceRegistry(
    paths.workspacesPath,
    paths.mdDbPath,
    paths.personalitiesDir,
    (event) => logger.logEvent({ ...event, sessionId } as RunEvent),
    () => { if (++activeSummarizers === 1) reindexControl.suspend(); },
    () => { if (--activeSummarizers === 0) reindexControl.flush(); },
  );

  // ── ContextEngine ───────────────────────────────────────────────────────
  const engine = new ContextEngine({
    mdDbPath: paths.mdDbPath,
    review: { enabled: reviewEnabled },
    onDebug: (event) => {
      logger.logEvent({
        ...event,
        sessionId: event.sessionId ?? sessionId,
      } as RunEvent);
    },
  });

  // ── md_db watcher (lint on change) ───────────────────────────────────────
  let mdDbWatcher: ReturnType<typeof startMdDbLintWatcher> | undefined;

  // ── md_db reindex watcher (incremental update on change) ────────────────
  let reindexWatcher: ReindexWatcherControl | undefined;

  // ── Summarizer ref counter + reindex control shim ───────────────────────
  // Suspends the reindex debounce while any summarizer worker is running.
  // Shim methods are populated in initialize() once the watcher is created.
  let activeSummarizers = 0;
  const reindexControl: { suspend(): void; flush(): void } = {
    suspend: () => {},
    flush: () => {},
  };

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
        // Subsequent boots: re-run mirrors + cleanup for all active workspaces.
        // mtime check inside each parser keeps this fast — only stale files
        // are rewritten. cleanMirrorDir removes notes for files deleted since
        // the last run (e.g. while the watcher was not active).
        for (const entry of workspaceRegistry.list()) {
          if (entry.active && entry.mode === "code") {
            await runWorkspaceMirror({
              scanDir: entry.sourceDir,
              mirrorDir: workspaceRegistry.mirrorDir(entry),
              languages: entry.languages,
              force: false,
              workspace: entry.name,
              wikilinkPrefix: WorkspaceRegistry.wikilinkPrefix(entry),
              omitPatterns: entry.omitPatterns,
            });
          }
        }
      }
    } catch (err) {
      logger.logEvent({
        type: "diagnostic",
        sessionId,
        timestamp: Date.now(),
        module: "stack",
        level: "error",
        message: `workspace initialization failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // ── Phase 2: start watchers BEFORE engine init ─────────────────────
    // Watchers must be running before engine.initialize() because init can
    // take 20+ seconds (slow path). Any source file edits during that window
    // would be missed if watchers started after init.
    // The reindex watcher is safe to start early: if the engine isn't ready,
    // incrementalUpdate() is a no-op (queued in Python background thread).
    mdDbWatcher = startMdDbLintWatcher(paths.mdDbPath);
    workspaceRegistry.startAllWatchers();
    const ctrl = startMdDbReindexWatcher(paths.mdDbPath, engine, sessionId, (event) => logger.logEvent({ ...event, sessionId } as RunEvent));
    reindexWatcher = ctrl;
    reindexControl.suspend = ctrl.suspend;
    reindexControl.flush = ctrl.flush;

    // ── Phase 3: engine init (sees settled md_db, hash is stable) ─────────
    await engine.initialize();
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

/** Control handle returned by startMdDbReindexWatcher. */
interface ReindexWatcherControl {
  /** Close the underlying chokidar watcher. */
  close(): Promise<void>;
  /** Suspend the debounce timer — paths still accumulate, no flush fires. */
  suspend(): void;
  /** Cancel the timer, resume, and fire incrementalUpdate immediately with accumulated paths. */
  flush(): void;
}

/**
 * Watch md_db for .md file changes and trigger incremental engine updates.
 * Batches rapid changes (debounce) and sends only the changed/deleted paths.
 *
 * Supports suspend/flush so callers can hold back the debounce while a
 * summarizer worker is running (preventing N×2 reindex events per save).
 */
function startMdDbReindexWatcher(
  mdDbPath: string,
  engine: ContextEngine,
  sessionId: string,
  onEvent?: (event: RunEvent) => void,
): ReindexWatcherControl {
  const pendingChanged = new Set<string>();
  const pendingDeleted = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let suspended = false;

  function toRelPath(absPath: string): string {
    return relative(mdDbPath, absPath).replace(/\\/g, "/");
  }

  function scheduleFlush(): void {
    if (suspended) return; // accumulate paths but don't fire yet
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void flushInternal();
    }, REINDEX_DEBOUNCE_MS);
  }

  async function flushInternal(): Promise<void> {
    const changed = [...pendingChanged];
    const deleted = [...pendingDeleted];
    pendingChanged.clear();
    pendingDeleted.clear();

    const changedFiltered = changed.filter((p) => !deleted.includes(p));
    if (changedFiltered.length === 0 && deleted.length === 0) return;

    onEvent?.({
      type: "reindex_queued",
      sessionId,
      timestamp: Date.now(),
      changedCount: changedFiltered.length,
      deletedCount: deleted.length,
    });

    try {
      await engine.incrementalUpdate(changedFiltered, deleted);
    } catch (err) {
      // Engine might not be initialized yet — put paths back for next flush
      for (const p of changedFiltered) pendingChanged.add(p);
      for (const p of deleted) pendingDeleted.add(p);
      onEvent?.({
        type: "reindex_deferred",
        sessionId,
        timestamp: Date.now(),
        changedCount: changedFiltered.length,
        deletedCount: deleted.length,
        reason: err instanceof Error ? err.message : String(err),
      });
      scheduleFlush();
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

  return {
    close: () => watcher.close(),
    suspend: () => {
      suspended = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
    },
    flush: () => {
      suspended = false;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      void flushInternal();
    },
  };
}
