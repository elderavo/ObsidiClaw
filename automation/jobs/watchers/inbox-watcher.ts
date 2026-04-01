/**
 * Inbox watcher for "know" workspaces.
 *
 * Watches an inbox directory for new .md files and fires onInboxNote so the
 * inbox pipeline (TODO resolution, tagging, atomicity check, promotion)
 * can run immediately when Pi is active.
 */

import chokidar, { type FSWatcher } from "chokidar";

export interface InboxWatcherConfig {
  /** Absolute path to the inbox directory to watch. */
  inboxDir: string;
  /** Called when a new .md file lands in the inbox. Path is absolute. */
  onInboxNote: (filePath: string) => void;
}

/**
 * Start watching an inbox directory for new markdown files.
 * Uses a 1.5s stabilityThreshold so partial writes don't fire early.
 */
export function startInboxWatcher(config: InboxWatcherConfig): FSWatcher {
  const { inboxDir, onInboxNote } = config;

  // Debounce: track a per-file timer so rapid re-saves don't double-fire.
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const watcher = chokidar.watch(inboxDir, {
    ignoreInitial: true,
    ignored: /(^|[/\\])\./,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 100 },
  });

  function schedule(filePath: string): void {
    if (!filePath.endsWith(".md")) return;
    const existing = pending.get(filePath);
    if (existing) clearTimeout(existing);
    pending.set(
      filePath,
      setTimeout(() => {
        pending.delete(filePath);
        onInboxNote(filePath);
      }, 100),
    );
  }

  watcher.on("add", schedule);

  return watcher;
}
