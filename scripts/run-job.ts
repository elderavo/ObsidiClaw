/**
 * OS job runner — entry point for all scheduled jobs.
 *
 * Called by Windows Task Scheduler as:
 *   node dist/scripts/run-job.js <job-name>
 *
 * Working directory is set to project root by the schtasks command wrapper.
 * Job logic lives in scheduler/jobs/<name>.ts — this file is a thin dispatcher.
 */

import { randomUUID } from "crypto";
import { resolvePaths, type ObsidiClawPaths } from "../shared/config.js";
import { RunLogger } from "../logger/run-logger.js";
import * as reindex from "../scheduler/jobs/reindex.js";
import * as normalize from "../scheduler/jobs/normalize.js";
import * as healthCheck from "../scheduler/jobs/health-check.js";
import * as mergeInbox from "../scheduler/jobs/merge-inbox.js";

type JobModule = { run: (paths: ObsidiClawPaths) => Promise<void> };

const JOBS: Record<string, JobModule> = {
  "reindex-md-db":           reindex,
  "normalize-md-db":         normalize,
  "health-check":            healthCheck,
  "merge-preferences-inbox": mergeInbox,
};

const jobName = process.argv[2];

if (!jobName) {
  console.error("[run-job] usage: node run-job.js <job-name>");
  console.error("[run-job] available:", Object.keys(JOBS).join(", "));
  process.exit(1);
}

if (!JOBS[jobName]) {
  console.error(`[run-job] unknown job: "${jobName}"`);
  console.error("[run-job] available:", Object.keys(JOBS).join(", "));
  process.exit(1);
}

const paths = resolvePaths();

async function run(): Promise<void> {
  const logger = new RunLogger({ dbPath: paths.dbPath });
  const runId = randomUUID();
  const startTime = Date.now();

  logger.insertJobRun(runId, "scheduler", startTime, jobName);

  try {
    await JOBS[jobName].run(paths);
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

run();
