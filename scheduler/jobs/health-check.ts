/**
 * Built-in health check job — verifies Ollama reachability and SQLite connectivity.
 */

import axios from "axios";
import { getOllamaConfig } from "../../shared/config.js";
import type { ContextEngine } from "../../context_engine/context-engine.js";
import type { JobDefinition } from "../types.js";

/**
 * Create a health check job that verifies system dependencies.
 *
 * @param engine  Initialized ContextEngine (used to check graph store)
 * @param intervalMinutes  How often to check (default: 15)
 */
export function createHealthCheckJob(
  engine: ContextEngine,
  intervalMinutes = 15,
): JobDefinition {
  return {
    name: "health-check",
    description: "Check Ollama reachability and SQLite graph store health",
    schedule: { minutes: intervalMinutes },
    skipIfRunning: true,
    timeoutMs: 30_000,

    async execute(ctx) {
      if (ctx.signal.aborted) return;

      const issues: string[] = [];

      // Check Ollama reachability
      const ollamaConfig = getOllamaConfig();
      const ollamaHost = ollamaConfig.baseUrl.replace(/\/v1\/?$/, "");
      try {
        await axios.get(`${ollamaHost}/api/tags`, {
          timeout: 10_000,
          signal: ctx.signal,
        });
      } catch (err) {
        issues.push(`Ollama unreachable at ${ollamaHost}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Check graph store
      const graphStore = engine.getGraphStore();
      if (!graphStore) {
        issues.push("Graph store not initialized");
      }

      if (issues.length > 0) {
        throw new Error(`Health check failed:\n${issues.join("\n")}`);
      }
    },
  };
}
