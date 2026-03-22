/**
 * Built-in health check job — verifies Ollama reachability and SQLite connectivity.
 */
import type { ContextEngine } from "../../context_engine/context-engine.js";
import type { JobDefinition } from "../types.js";
/**
 * Create a health check job that verifies system dependencies.
 *
 * @param engine  Initialized ContextEngine (used to check graph store)
 * @param intervalMinutes  How often to check (default: 15)
 */
export declare function createHealthCheckJob(engine: ContextEngine, intervalMinutes?: number): JobDefinition;
//# sourceMappingURL=health-check.d.ts.map