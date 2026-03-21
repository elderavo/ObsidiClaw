/**
 * Built-in reindex job — periodically re-syncs md_db to the graph and vector index.
 */

import type { ContextEngine } from "../../context_engine/context-engine.js";
import type { JobDefinition } from "../types.js";

/**
 * Create a reindex job that calls engine.reindex() on a schedule.
 *
 * @param engine  Initialized ContextEngine
 * @param intervalMinutes  How often to reindex (default: 30)
 */
export function createReindexJob(
  engine: ContextEngine,
  intervalMinutes = 30,
): JobDefinition {
  return {
    name: "reindex-md-db",
    description: "Re-sync md_db markdown files to the graph store and vector index",
    schedule: { minutes: intervalMinutes },
    skipIfRunning: true,
    async execute(ctx) {
      if (ctx.signal.aborted) return;
      await engine.reindex();
    },
  };
}
