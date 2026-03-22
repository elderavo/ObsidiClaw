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
export declare function createReindexJob(engine: ContextEngine, intervalMinutes?: number): JobDefinition;
//# sourceMappingURL=reindex.d.ts.map