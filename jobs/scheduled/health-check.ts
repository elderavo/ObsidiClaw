/**
 * Built-in health check job — verifies Ollama reachability and SQLite connectivity.
 */

import axios from "axios";
import Database from "better-sqlite3";
import type { JobDefinition } from "../types.js";
import type { ObsidiClawPaths } from "../../shared/config.js";
import { getOllamaConfig } from "../../shared/config.js";

export function createHealthCheckJob(intervalMinutes = 24 * 60): JobDefinition {
  return {
    name: "health-check",
    description: "Verify Ollama reachability and SQLite connectivity",
    schedule: { minutes: intervalMinutes },
    skipIfRunning: true,
    timeoutMs: 30_000,
  };
}

export async function run(paths: ObsidiClawPaths): Promise<void> {
  const ollama = getOllamaConfig();
  const host = ollama.baseUrl.replace(/\/v1\/?$/, "");
  const issues: string[] = [];

  try {
    await axios.get(`${host}/api/tags`, { timeout: 10_000 });
  } catch (err) {
    issues.push(`Ollama unreachable at ${host}: ${err instanceof Error ? err.message : String(err)}`);
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
