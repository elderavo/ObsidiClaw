/**
 * force-summarize — run the tiered summarization cascade for all active workspaces.
 *
 * Bypasses mtime staleness — summarizes every note missing a summary regardless
 * of whether the source is newer than the mirror. Useful after a force-mirror run
 * or after the summarizer was broken and needs to catch up.
 *
 * Usage:
 *   npx tsx --env-file=.env automation/scripts/force-summarize.ts
 */

import { resolvePaths } from "../../core/config.js";
import { WorkspaceRegistry } from "../workspaces/workspace-registry.js";
import { runCascadeForWorkspace } from "../jobs/summarize-lib.js";
import { join } from "path";

const paths = resolvePaths();
const registry = new WorkspaceRegistry(paths.workspacesPath, paths.mdDbPath);
registry.load();

const workspaces = registry.list().filter((w) => w.active);

if (workspaces.length === 0) {
  console.log("[force-summarize] no active workspaces found");
  process.exit(0);
}

for (const ws of workspaces) {
  console.log(`[force-summarize] ${ws.name} (${ws.sourceDir})`);
  await runCascadeForWorkspace({
    mirrorDir: join(paths.mdDbPath, "code", ws.name),
    mdDbPath: paths.mdDbPath,
    rootDir: ws.sourceDir,
    workspacesPath: paths.workspacesPath,
    personalitiesDir: paths.personalitiesDir,
    registry,
  });
  console.log(`[force-summarize] ${ws.name} done`);
}
