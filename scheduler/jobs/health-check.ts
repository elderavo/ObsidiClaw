/**
 * Built-in health check job — verifies Ollama reachability and SQLite connectivity.
 */

import type { JobDefinition } from "../types.js";

/**
 * Create a health check job definition.
 *
 * @param intervalMinutes  How often to check (default: 1440 = once per day)
 */
export function createHealthCheckJob(intervalMinutes = 24 * 60): JobDefinition {
  return {
    name: "health-check",
    description: "Verify Ollama reachability and SQLite connectivity",
    schedule: { minutes: intervalMinutes },
    skipIfRunning: true,
    timeoutMs: 30_000,
  };
}
