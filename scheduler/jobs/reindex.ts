/**
 * Built-in reindex job — periodically re-syncs md_db to the graph and vector index.
 */

import type { JobDefinition } from "../types.js";

/**
 * Create a reindex job definition.
 *
 * @param intervalMinutes  How often to reindex (default: 30)
 */
export function createReindexJob(intervalMinutes = 30): JobDefinition {
  return {
    name: "reindex-md-db",
    description: "Re-sync md_db to the graph and vector index",
    schedule: { minutes: intervalMinutes },
    skipIfRunning: true,
    timeoutMs: 300_000,
  };
}
