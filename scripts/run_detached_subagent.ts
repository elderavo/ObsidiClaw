/**
 * Detached subagent runner.
 *
 * Reads a spec JSON file, initialises a ContextEngine + SubagentRunner,
 * runs the subagent, logs to runs.db, and writes a result JSON.
 *
 * Invoked as a detached child process by spawn_subagent_detached / review worker.
 */

import { fileURLToPath } from "url";
import { dirname, resolve, join } from "path";

import { ContextEngine } from "../context_engine/index.js";
import { SubagentRunner } from "../shared/agents/subagent-runner.js";
import { exitProcess } from "../shared/os/process.js";
import { resolvePaths } from "../shared/config.js";
import { readText, writeText, ensureDir, appendText } from "../shared/os/fs.js";

// ---------------------------------------------------------------------------
// Spec shape (matches what SubagentRunner.runDetached writes)
// ---------------------------------------------------------------------------

interface DetachedSubagentSpec {
  jobId?: string;
  rootDir?: string;
  mdDbPath?: string;
  plan: string;
  context?: string;
  successCriteria?: string;
  personality?: string;
  timeoutMinutes?: number;
  resultPath?: string;
  logPath?: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error("Usage: run_detached_subagent.js <specPath>");
    exitProcess(1);
  }

  const spec: DetachedSubagentSpec = JSON.parse(readText(specPath));
  const paths = resolvePaths(spec.rootDir);
  const mdDbPath = spec.mdDbPath ? resolve(spec.mdDbPath) : paths.mdDbPath;
  const resultPath = spec.resultPath ?? join(dirname(specPath), `${spec.jobId ?? "unknown"}.result.json`);
  const logPath = spec.logPath ?? resultPath.replace(/\.result\.json$/, ".log");
  const startedAt = Date.now();

  ensureDir(dirname(resultPath));
  ensureDir(dirname(logPath));

  const log = (msg: string) => {
    appendText(logPath, `[${new Date().toISOString()}] ${msg}\n`);
  };

  log(`spec: ${specPath}`);
  log(`job: ${spec.jobId ?? "unknown"}`);

  let status = "done";
  let output = "";
  let error: string | null = null;
  let runId = "";

  try {
    // Initialize context engine
    const engine = new ContextEngine({ mdDbPath });
    await engine.initialize();
    log("Context engine initialized");

    // Create runner and execute
    const runner = new SubagentRunner({
      dbPath: paths.dbPath,
      contextEngine: engine,
      rootDir: paths.rootDir,
    });

    const timeoutMs = Math.max(1, spec.timeoutMinutes ?? 5) * 60 * 1000;

    const result = await runner.run({
      prompt: spec.context?.trim() || spec.plan,
      plan: spec.plan,
      successCriteria: spec.successCriteria ?? "",
      personality: spec.personality,
      callerContext: spec.context,
      timeoutMs,
    });

    runId = result.runId;
    output = result.output;
    status = result.outcome;

    if (result.outcome === "error") {
      error = result.output;
    }

    log(`Subagent ${result.outcome} in ${result.durationMs}ms`);
    await engine.close();
  } catch (err) {
    status = "error";
    error = err instanceof Error ? err.message : String(err);
    log(`ERROR: ${error}`);
    if (err instanceof Error && err.stack) log(err.stack);
  }

  const finishedAt = Date.now();
  const resultJson = {
    jobId: spec.jobId,
    runId,
    status,
    output,
    error,
    startedAt,
    finishedAt,
    resultPath,
    logPath,
  };
  writeText(resultPath, JSON.stringify(resultJson, null, 2));
  log(`Result written: ${resultPath}`);
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile || process.argv[1] === currentFile.replace(/\.ts$/, ".js")) {
  main().catch((err) => {
    console.error(err);
    exitProcess(1);
  });
}
