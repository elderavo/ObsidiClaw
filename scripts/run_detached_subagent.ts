/**
 * Detached subagent runner.
 *
 * Reads a spec JSON file, initialises a ContextEngine, runs a subagent via the
 * shared pi session factory, logs to runs.db, and writes a result JSON.
 *
 * Invoked as a detached child process by spawn_subagent_detached / review worker.
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { dirname, resolve, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

import { ContextEngine, createContextEngineMcpServer } from "../context_engine/index.js";
import { RunLogger } from "../logger/run-logger.js";
import { createObsidiClawExtension } from "../extension/factory.js";
import { createPiAgentSession } from "../shared/pi-session-factory.js";
import { resolvePaths } from "../shared/config.js";

// ---------------------------------------------------------------------------
// Spec shape (matches what subagent.ts writes)
// ---------------------------------------------------------------------------

interface DetachedSubagentSpec {
  jobId?: string;
  sessionId?: string;
  rootDir?: string;
  mdDbPath?: string;
  plan: string;
  context?: string;
  successCriteria?: string;
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
    process.exit(1);
  }

  const spec: DetachedSubagentSpec = JSON.parse(readFileSync(specPath, "utf8"));
  const jobId = spec.jobId ?? randomUUID();
  const sessionId = spec.sessionId ?? `detached-${randomUUID()}`;
  const paths = resolvePaths(spec.rootDir);
  const mdDbPath = spec.mdDbPath ? resolve(spec.mdDbPath) : paths.mdDbPath;
  const resultPath = spec.resultPath ?? join(dirname(specPath), `${jobId}.result.json`);
  const logPath = spec.logPath ?? resultPath.replace(/\.result\.json$/, ".log");
  const startedAt = Date.now();

  mkdirSync(dirname(resultPath), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });

  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    appendFileSync(logPath, line, "utf8");
  };

  log(`spec: ${specPath}`);
  log(`job: ${jobId} session: ${sessionId}`);

  const logger = new RunLogger({ dbPath: paths.dbPath });
  logger.logEvent({
    type: "prompt_received",
    sessionId,
    runId: jobId,
    timestamp: startedAt,
    text: "(detached subagent)",
    isSubagent: true,
  });

  let status = "done";
  let output = "";
  let error: string | null = null;

  try {
    const engine = new ContextEngine({ mdDbPath });
    await engine.initialize();

    log("Context engine init");
    const pkg = await engine.buildSubagentPackage({
      prompt: spec.context?.trim() || spec.plan,
      plan: spec.plan,
      successCriteria: spec.successCriteria ?? "",
    });

    log("Subagent package built");
    const systemPrompt = pkg.formattedSystemPrompt;
    if (!systemPrompt) {
      throw new Error("No system prompt built for subagent");
    }

    const runPromise = runSubagent({
      systemPrompt,
      userPrompt: spec.plan,
      engine,
      log,
    });

    const timeoutMs = Math.max(1, spec.timeoutMinutes ?? 5) * 60 * 1000;
    const outcome = await Promise.race([
      runPromise,
      new Promise<"__timeout__">((resolve) => setTimeout(() => resolve("__timeout__"), timeoutMs)),
    ]);

    if (outcome === "__timeout__") {
      status = "timeout";
      error = `Timed out after ${timeoutMs / 60000}m`;
      logger.logEvent({
        type: "prompt_error",
        sessionId,
        runId: jobId,
        timestamp: Date.now(),
        error,
      });
      log(error);
    } else {
      output = outcome;
      logger.logEvent({
        type: "prompt_complete",
        sessionId,
        runId: jobId,
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
      });
      log("Subagent run complete");
    }

    engine.close();
  } catch (err) {
    status = "error";
    error = err instanceof Error ? err.message : String(err);
    logger.logEvent({
      type: "prompt_error",
      sessionId,
      runId: jobId,
      timestamp: Date.now(),
      error,
    });
    log(`ERROR: ${error}`);
    if (err instanceof Error && err.stack) log(err.stack);
  } finally {
    logger.close();
  }

  const finishedAt = Date.now();
  const result = { jobId, sessionId, status, output, error, startedAt, finishedAt, resultPath, logPath };
  writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8");
  log(`Result written: ${resultPath}`);
}

// ---------------------------------------------------------------------------
// Subagent runner — uses shared factory
// ---------------------------------------------------------------------------

async function runSubagent(opts: {
  systemPrompt: string;
  userPrompt: string;
  engine: ContextEngine;
  log: (msg: string) => void;
}): Promise<string> {
  const session = await createPiAgentSession({
    extensionFactories: [
      createObsidiClawExtension({
        mcpServer: createContextEngineMcpServer(opts.engine),
      }),
    ],
    systemPrompt: opts.systemPrompt,
  });

  await session.prompt(opts.userPrompt);

  const messages = (session.messages ?? []) as Array<{ role?: string; content?: unknown }>;
  const lastAssistant = [...messages].reverse().find((m) => m?.role === "assistant");
  const output = extractTextFromContent(lastAssistant?.content) ?? "";
  opts.log("Subagent response captured");
  session.dispose();
  return output;
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

function extractTextFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((c: unknown) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in c) return String((c as { text: unknown }).text);
        return null;
      })
      .filter(Boolean) as string[];
    return parts.join("\n") || null;
  }
  if (content && typeof content === "object" && "text" in content) {
    return String((content as { text: unknown }).text);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile || process.argv[1] === currentFile.replace(/\.ts$/, ".js")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
