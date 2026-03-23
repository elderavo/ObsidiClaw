/**
 * Built-in reindex job — periodically re-syncs md_db to the graph and vector index.
 */

import type { JobDefinition } from "../types.js";
import type { ObsidiClawPaths } from "../../../core/config.js";

export function createReindexJob(intervalMinutes = 30): JobDefinition {
  return {
    name: "reindex-md-db",
    description: "Re-sync md_db to the graph and vector index",
    schedule: { minutes: intervalMinutes },
    skipIfRunning: true,
    timeoutMs: 300_000,
  };
}

export async function run(paths: ObsidiClawPaths): Promise<void> {
  const { ContextEngine } = await import("../../../knowledge/engine/context-engine.js");
  const engine = new ContextEngine({ mdDbPath: paths.mdDbPath });
  await engine.initialize();
  try {
    await engine.reindex();
  } finally {
    await engine.close();
  }
}
