/**
 * OS job runner — entry point for all scheduled jobs.
 *
 * Called by Windows Task Scheduler as:
 *   node dist/scripts/run-job.js <job-name>
 *
 * Working directory is set to project root by the schtasks command wrapper.
 * Uses resolvePaths() (process.cwd()) to find md_db, runs.db, etc.
 */

import { randomUUID } from "crypto";
import { resolvePaths, getOllamaConfig } from "../shared/config.js";
import { RunLogger } from "../logger/run-logger.js";

const jobName = process.argv[2];

if (!jobName) {
  console.error("[run-job] usage: node run-job.js <job-name>");
  process.exit(1);
}

const paths = resolvePaths();

async function run(): Promise<void> {
  const logger = new RunLogger({ dbPath: paths.dbPath });
  const runId = randomUUID();
  const sessionId = "scheduler";
  const startTime = Date.now();

  logger.insertJobRun(runId, sessionId, startTime, jobName);

  try {
    await runJob(jobName);
    logger.finalizeRun(runId, "done", Date.now());
    console.log(`[run-job] ${jobName} completed in ${Date.now() - startTime}ms`);
  } catch (err) {
    logger.finalizeRun(runId, "error", Date.now());
    console.error(`[run-job] ${jobName} failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    logger.close();
  }
}

async function runJob(name: string): Promise<void> {
  switch (name) {
    case "reindex-md-db": {
      const { ContextEngine } = await import("../context_engine/context-engine.js");
      const engine = new ContextEngine({ mdDbPath: paths.mdDbPath });
      await engine.initialize();
      try {
        await engine.reindex();
      } finally {
        await engine.close();
      }
      break;
    }

    case "normalize-md-db": {
      const { normalizeMdDb } = await import("../shared/markdown/normalizer.js");
      const result = normalizeMdDb(paths.mdDbPath, { fix: true });
      if (result.fixed > 0 || result.issues.length > 0) {
        console.log(`[run-job] scanned=${result.scanned} issues=${result.issues.length} fixed=${result.fixed}`);
      }
      break;
    }

    case "health-check": {
      const axios = (await import("axios")).default;
      const Database = (await import("better-sqlite3")).default;
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
      break;
    }

    case "merge-preferences-inbox": {
      const { mergeInbox } = await import("../scheduler/jobs/merge-inbox.js");
      await mergeInbox(paths.mdDbPath);
      break;
    }

    default:
      throw new Error(`Unknown job: "${name}"`);
  }
}

run();
