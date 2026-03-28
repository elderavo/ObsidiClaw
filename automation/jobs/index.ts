/**
 * Jobs — re-exports.
 *
 * In-runtime automation only: chokidar-based file watchers + summarizer.
 * Out-of-runtime automation lives in automation/scripts/ as standalone scripts.
 */

export { startMdDbLintWatcher } from "./watchers/md-db-lint-watcher.js";
export { startWorkspaceMirrorWatcher } from "./watchers/mirror-watcher.js";
export { runCascadeForWorkspace } from "./summarize-lib.js";
