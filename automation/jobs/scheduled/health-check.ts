/**
 * Built-in health check job — verifies LLM provider reachability and SQLite connectivity.
 */

import Database from "better-sqlite3";
import { isLlmReachable } from "../../../core/llm-client.js";
import type { JobDefinition } from "../types.js";
import type { ObsidiClawPaths } from "../../../core/config.js";

export function createHealthCheckJob(intervalMinutes = 24 * 60): JobDefinition {
  return {
    name: "health-check",
    description: "Verify LLM provider reachability and SQLite connectivity",
    schedule: { minutes: intervalMinutes },
    skipIfRunning: true,
    timeoutMs: 30_000,
  };
}

export async function run(paths: ObsidiClawPaths): Promise<void> {
  const issues: string[] = [];

  if (!await isLlmReachable()) {
    issues.push("LLM provider unreachable");
  }

  try {
    const db = new Database(paths.dbPath, { readonly: true });
    db.close();
  } catch (err) {
    issues.push(`runs.db not accessible: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (issues.length > 0) {
    throw new Error(issues.join("; "));
  }
}
