/**
 * WorkspaceRegistry — persistent registry of source directories to mirror.
 *
 * Each workspace is a source directory the system watches and mirrors into
 * md_db/. The agent registers/unregisters workspaces via MCP tools at runtime.
 *
 * Registry persists to `.obsidi-claw/workspaces.json`.
 */

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import type { FSWatcher } from "chokidar";

import { startWorkspaceMirrorWatcher, type WorkspaceMirrorConfig } from "../jobs/watchers/mirror-watcher.js";
import { startInboxWatcher } from "../jobs/watchers/inbox-watcher.js";
import { runWorkspaceMirror } from "../scripts/run-workspace-mirror.js";
import type { RunEvent } from "../../logger/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkspaceMode = "code" | "know";
export type WorkspaceLanguage = "ts" | "py";

export interface WorkspaceEntry {
  /** Stable UUID. */
  id: string;
  /** Human slug — used as folder name in md_db. Alphanumeric + hyphens only. */
  name: string;
  /** Absolute path to the source directory. */
  sourceDir: string;
  /** "code" = mirror pipeline; "know" = conversational knowledge (future stub). */
  mode: WorkspaceMode;
  /** Which mirror scripts to run. Only relevant for code mode. */
  languages: WorkspaceLanguage[];
  /** Whether watchers should run for this workspace. */
  active: boolean;
  /** ISO timestamp of registration. */
  registeredAt: string;
  /** Per-language omit patterns. Falls back to script defaults when absent. */
  omitPatterns?: Partial<Record<WorkspaceLanguage, string[]>>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

function validateName(name: string): void {
  if (name.length < 2 || name.length > 64) {
    throw new Error(`Workspace name must be 2-64 characters, got "${name}"`);
  }
  if (!NAME_RE.test(name)) {
    throw new Error(
      `Workspace name must be lowercase alphanumeric + hyphens (no leading/trailing hyphen), got "${name}"`,
    );
  }
}

function validateSourceDir(dir: string): void {
  const abs = resolve(dir);
  if (!existsSync(abs)) {
    throw new Error(`Source directory does not exist: ${abs}`);
  }
  if (!statSync(abs).isDirectory()) {
    throw new Error(`Source path is not a directory: ${abs}`);
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class WorkspaceRegistry {
  private entries: WorkspaceEntry[] = [];
  private loaded = false;

  constructor(
    /** Path to `.obsidi-claw/workspaces.json`. */
    private readonly registryPath: string,
    /** Path to `md_db/`. */
    private readonly mdDbPath: string,
    /** Personalities directory — enables tiered summarization in mirror watchers. */
    private readonly personalitiesDir?: string,
    /** Callback for emitting structured trace events from mirror watchers. */
    private readonly onEvent?: (event: RunEvent) => void,
    /** Called when any summarize worker spawns — forwarded to reindex watcher for suspend. */
    private readonly onSummarizerStart?: () => void,
    /** Called when the last summarize worker exits — forwarded to reindex watcher for flush. */
    private readonly onSummarizerDone?: () => void,
    /**
     * Called when a new note lands in a know workspace's inbox.
     * Args: workspace name, absolute file path.
     */
    private readonly onInboxNote?: (workspaceName: string, filePath: string) => void,
  ) {}

  // ── Persistence ──────────────────────────────────────────────────────────

  /** Load entries from disk. Creates empty file if missing. */
  load(): void {
    if (existsSync(this.registryPath)) {
      try {
        const raw = readFileSync(this.registryPath, "utf-8");
        this.entries = JSON.parse(raw) as WorkspaceEntry[];
      } catch {
        console.warn("[workspace-registry] failed to parse workspaces.json, starting empty");
        this.entries = [];
      }
    } else {
      this.entries = [];
    }
    this.loaded = true;
  }

  /** Write current entries to disk. */
  save(): void {
    const dir = dirname(this.registryPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.registryPath, JSON.stringify(this.entries, null, 2), "utf-8");
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  list(): readonly WorkspaceEntry[] {
    this.ensureLoaded();
    return this.entries;
  }

  get(id: string): WorkspaceEntry | undefined {
    this.ensureLoaded();
    return this.entries.find((e) => e.id === id);
  }

  getByName(name: string): WorkspaceEntry | undefined {
    this.ensureLoaded();
    return this.entries.find((e) => e.name === name);
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  /**
   * Add a workspace entry. Validates name uniqueness and source directory.
   * Persists immediately.
   */
  add(
    input: Omit<WorkspaceEntry, "id" | "registeredAt">,
  ): WorkspaceEntry {
    this.ensureLoaded();
    validateName(input.name);
    validateSourceDir(input.sourceDir);

    if (this.getByName(input.name)) {
      throw new Error(`Workspace "${input.name}" already exists`);
    }

    const entry: WorkspaceEntry = {
      ...input,
      sourceDir: resolve(input.sourceDir),
      id: randomUUID(),
      registeredAt: new Date().toISOString(),
    };

    this.entries.push(entry);
    this.save();
    return entry;
  }

  /** Remove a workspace by ID. Persists immediately. Returns the removed entry or undefined. */
  remove(id: string): WorkspaceEntry | undefined {
    this.ensureLoaded();
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) return undefined;
    const [removed] = this.entries.splice(idx, 1);
    this.save();
    return removed;
  }

  /** Remove a workspace by name. Persists immediately. */
  removeByName(name: string): WorkspaceEntry | undefined {
    const entry = this.getByName(name);
    if (!entry) return undefined;
    return this.remove(entry.id);
  }

  /** Toggle active state. Persists immediately. */
  setActive(id: string, active: boolean): void {
    this.ensureLoaded();
    const entry = this.get(id);
    if (!entry) throw new Error(`Workspace not found: ${id}`);
    entry.active = active;
    this.save();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Return the md_db subdirectory for this workspace's mirrored notes.
   * e.g. "code/obsidi-claw" or "know/my-notes"
   */
  static mirrorSubdir(entry: Pick<WorkspaceEntry, "mode" | "name">): string {
    return `${entry.mode}/${entry.name}`;
  }

  /**
   * Return the absolute path to the workspace's mirror output directory.
   * e.g. "/path/to/md_db/code/obsidi-claw"
   */
  mirrorDir(entry: Pick<WorkspaceEntry, "mode" | "name">): string {
    return join(this.mdDbPath, WorkspaceRegistry.mirrorSubdir(entry));
  }

  /**
   * Return the wikilink prefix for notes in this workspace.
   * Same as mirrorSubdir — e.g. "code/obsidi-claw"
   */
  static wikilinkPrefix(entry: Pick<WorkspaceEntry, "mode" | "name">): string {
    return WorkspaceRegistry.mirrorSubdir(entry);
  }

  // ── Watcher lifecycle ─────────────────────────────────────────────────

  private watchers = new Map<string, FSWatcher>();
  private inboxWatchers = new Map<string, FSWatcher>();

  /**
   * Start a mirror watcher for a single workspace entry.
   * No-op if a watcher is already running for this workspace.
   */
  startWatcher(entry: WorkspaceEntry): void {
    if (!entry.active) return;
    if (this.watchers.has(entry.id)) return;

    if (entry.mode === "code") {
      const config: WorkspaceMirrorConfig = {
        sourceDir: entry.sourceDir,
        mirrorDir: this.mirrorDir(entry),
        workspace: entry.name,
        wikilinkPrefix: WorkspaceRegistry.wikilinkPrefix(entry),
        languages: entry.languages,
        omitPatterns: entry.omitPatterns,
        personalitiesDir: this.personalitiesDir,
        mdDbPath: this.mdDbPath,
        workspacesPath: this.registryPath,
        registry: this,
        onEvent: this.onEvent,
        onSummarizerStart: this.onSummarizerStart,
        onSummarizerDone: this.onSummarizerDone,
      };
      const watcher = startWorkspaceMirrorWatcher(config);
      this.watchers.set(entry.id, watcher);
    } else if (entry.mode === "know") {
      if (this.onInboxNote) {
        const inboxDir = join(this.mirrorDir(entry), "inbox");
        mkdirSync(inboxDir, { recursive: true });
        const inboxWatcher = startInboxWatcher({
          inboxDir,
          onInboxNote: (filePath) => this.onInboxNote!(entry.name, filePath),
        });
        this.inboxWatchers.set(entry.id, inboxWatcher);
      }
    }
  }

  /** Stop and remove a watcher for a workspace. */
  async stopWatcher(id: string): Promise<void> {
    const watcher = this.watchers.get(id);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(id);
    }
    const inboxWatcher = this.inboxWatchers.get(id);
    if (inboxWatcher) {
      await inboxWatcher.close();
      this.inboxWatchers.delete(id);
    }
  }

  /** Start watchers for all active workspaces. Call during stack init. */
  startAllWatchers(): void {
    this.ensureLoaded();
    for (const entry of this.entries) {
      if (entry.active) {
        this.startWatcher(entry);
      }
    }
  }

  /** Stop all watchers. Call during stack shutdown. */
  async stopAllWatchers(): Promise<void> {
    const ids = [...this.watchers.keys()];
    await Promise.all(ids.map((id) => this.stopWatcher(id)));
  }

  // ── Full lifecycle (register / unregister with mirror pipeline) ──────

  /**
   * Register a new workspace, run initial mirror, and start watcher.
   * Returns the created entry, count of generated notes, and their relative paths.
   */
  async register(
    input: Omit<WorkspaceEntry, "id" | "registeredAt">,
  ): Promise<{ entry: WorkspaceEntry; notesGenerated: number; notePaths: string[] }> {
    const entry = this.add(input);
    const mirrorDir = this.mirrorDir(entry);
    mkdirSync(mirrorDir, { recursive: true });

    let notesGenerated = 0;
    const notePaths: string[] = [];

    if (entry.mode === "code") {
      // Run initial mirror + cleanup (non-forced — mtime skip handles re-registration).
      // Cleanup runs here so that a workspace re-registration after source deletions
      // reflects the current source tree immediately.
      const result = await runWorkspaceMirror({
        scanDir: entry.sourceDir,
        mirrorDir,
        languages: entry.languages,
        force: false,
        workspace: entry.name,
        wikilinkPrefix: WorkspaceRegistry.wikilinkPrefix(entry),
        omitPatterns: entry.omitPatterns,
      });
      notesGenerated = result.tsWritten + result.pyWritten;

      // Collect paths of newly written notes for incremental index update.
      // collectMdPaths runs after cleanup so deleted notes are not included.
      if (notesGenerated > 0) {
        collectMdPaths(mirrorDir, this.mdDbPath, notePaths);
      }

      // Start watcher for continuous updates
      this.startWatcher(entry);
    } else if (entry.mode === "know") {
      // Notes are authored directly in md_db/know/{ws}/ — just ensure dirs exist.
      mkdirSync(join(mirrorDir, "inbox"), { recursive: true });
      this.startWatcher(entry);
    }

    return { entry, notesGenerated, notePaths };
  }

  /**
   * Collect all note paths (relative to md_db) for an active workspace.
   * Useful for triggering targeted incremental index updates at startup.
   */
  listNotePaths(entry: WorkspaceEntry): string[] {
    const mirrorDir = this.mirrorDir(entry);
    const paths: string[] = [];
    collectMdPaths(mirrorDir, this.mdDbPath, paths);
    return paths;
  }

  /**
   * Unregister a workspace: stop watcher, delete mirrored notes, remove from registry.
   * Returns list of deleted note paths (relative to md_db) for incremental update.
   */
  async unregister(
    name: string,
  ): Promise<{ removed: WorkspaceEntry | undefined; deletedPaths: string[] }> {
    const entry = this.getByName(name);
    if (!entry) return { removed: undefined, deletedPaths: [] };

    // Stop watcher
    await this.stopWatcher(entry.id);

    // Collect paths of notes to delete (for incremental update)
    const deletedPaths: string[] = [];
    const mirrorDir = this.mirrorDir(entry);

    if (existsSync(mirrorDir)) {
      collectMdPaths(mirrorDir, this.mdDbPath, deletedPaths);
      rmSync(mirrorDir, { recursive: true, force: true });
    }

    // Remove from registry
    const removed = this.remove(entry.id);
    return { removed, deletedPaths };
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      this.load();
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect all .md file paths relative to mdDbPath. */
function collectMdPaths(dir: string, mdDbPath: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        collectMdPaths(full, mdDbPath, out);
      } else if (name.endsWith(".md")) {
        out.push(relative(mdDbPath, full).replace(/\\/g, "/"));
      }
    } catch {
      continue;
    }
  }
}
