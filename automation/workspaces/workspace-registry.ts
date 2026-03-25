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
import { runMirrorTs } from "../scripts/mirror-codebase.js";
import { runMirrorPy } from "../scripts/mirror-codebase-py.js";

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

  /**
   * Start a mirror watcher for a single workspace entry.
   * No-op if a watcher is already running for this workspace.
   */
  startWatcher(entry: WorkspaceEntry): void {
    if (entry.mode !== "code" || !entry.active) return;
    if (this.watchers.has(entry.id)) return;

    const config: WorkspaceMirrorConfig = {
      sourceDir: entry.sourceDir,
      mirrorDir: this.mirrorDir(entry),
      workspace: entry.name,
      wikilinkPrefix: WorkspaceRegistry.wikilinkPrefix(entry),
      languages: entry.languages,
      omitPatterns: entry.omitPatterns,
    };

    const watcher = startWorkspaceMirrorWatcher(config);
    this.watchers.set(entry.id, watcher);
  }

  /** Stop and remove a watcher for a workspace. */
  async stopWatcher(id: string): Promise<void> {
    const watcher = this.watchers.get(id);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(id);
    }
  }

  /** Start watchers for all active code workspaces. Call during stack init. */
  startAllWatchers(): void {
    this.ensureLoaded();
    for (const entry of this.entries) {
      if (entry.active && entry.mode === "code") {
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
   * Returns the created entry and count of generated notes.
   */
  async register(
    input: Omit<WorkspaceEntry, "id" | "registeredAt">,
  ): Promise<{ entry: WorkspaceEntry; notesGenerated: number }> {
    const entry = this.add(input);
    const mirrorDir = this.mirrorDir(entry);
    mkdirSync(mirrorDir, { recursive: true });

    let notesGenerated = 0;

    if (entry.mode === "code") {
      const prefix = WorkspaceRegistry.wikilinkPrefix(entry);

      // Run initial mirror (non-forced — mtime skip handles re-registration)
      const promises: Promise<{ written: number }>[] = [];

      if (entry.languages.includes("ts")) {
        promises.push(
          runMirrorTs({
            scanDir: entry.sourceDir,
            mirrorDir,
            omitPatterns: entry.omitPatterns?.ts ?? ["dist", "node_modules", "_legacy", ".claude", "*.d.ts"],
            force: false,
            workspace: entry.name,
            wikilinkPrefix: prefix,
          }),
        );
      }

      if (entry.languages.includes("py")) {
        promises.push(
          runMirrorPy({
            scanDir: entry.sourceDir,
            mirrorDir,
            omitPatterns: entry.omitPatterns?.py ?? ["__pycache__", "*.pyi", ".venv", "env", "venv", "dist"],
            force: false,
            workspace: entry.name,
            wikilinkPrefix: prefix,
          }),
        );
      }

      const results = await Promise.all(promises);
      notesGenerated = results.reduce((sum, r) => sum + r.written, 0);

      // Start watcher for continuous updates
      this.startWatcher(entry);
    } else {
      // "know" mode — just create the directory, no pipeline yet
      console.log(`[workspace-registry] know mode workspace "${entry.name}" registered (pipeline not yet implemented)`);
    }

    return { entry, notesGenerated };
  }

  /**
   * Unregister a workspace: stop watcher, optionally delete notes, remove from registry.
   * Returns list of deleted note paths (relative to md_db) for incremental update.
   */
  async unregister(
    name: string,
    opts: { deleteNotes?: boolean } = {},
  ): Promise<{ removed: WorkspaceEntry | undefined; deletedPaths: string[] }> {
    const deleteNotes = opts.deleteNotes ?? true;
    const entry = this.getByName(name);
    if (!entry) return { removed: undefined, deletedPaths: [] };

    // Stop watcher
    await this.stopWatcher(entry.id);

    // Collect paths of notes to delete (for incremental update)
    const deletedPaths: string[] = [];
    const mirrorDir = this.mirrorDir(entry);

    if (deleteNotes && existsSync(mirrorDir)) {
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
