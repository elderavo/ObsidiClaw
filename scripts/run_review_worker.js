#!/usr/bin/env node
// Detached session review runner.
// Reads a spec JSON file { jobId, sessionId, trigger, messages, compactionMeta?, mdDbPath? }.
// Runs runSessionReview with a child Pi session and writes a status result JSON.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { dirname, resolve, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { ContextEngine, createContextEngineMcpServer } from "../dist/context_engine/index.js";
import { createObsidiClawExtension } from "../dist/extension/factory.js";
import { RunLogger } from "../dist/logger/run-logger.js";
import { runSessionReview } from "../dist/insight_engine/session_review.js";

const OLLAMA_BASE_URL = process.env["OLLAMA_BASE_URL"] ?? "http://10.0.132.100/v1";
const OLLAMA_MODEL = process.env["OLLAMA_MODEL"] ?? "cogito:8b";

async function main() {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error("Usage: run_review_worker.js <specPath>");
    process.exit(1);
  }

  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const jobId = spec.jobId ?? randomUUID();
  const sessionId = spec.sessionId ?? `pi-tui-${randomUUID()}`;
  const trigger = spec.trigger ?? "session_end";
  const mdDbPath = resolve(spec.mdDbPath ?? "md_db");
  const resultPath = spec.resultPath ?? join(dirname(specPath), `${jobId}.result.json`);
  const logPath = spec.logPath ?? resultPath.replace(/\.result\.json$/, ".log");

  mkdirSync(dirname(resultPath), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });

  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    appendFileSync(logPath, line, "utf8");
  };

  const startedAt = Date.now();
  const logger = new RunLogger({ dbPath: join(process.cwd(), ".obsidi-claw", "runs.db") });
  log(`spec: ${specPath}`);
  log(`job: ${jobId} session: ${sessionId}`);

  logger.logEvent({
    type: "prompt_received",
    sessionId,
    runId: jobId,
    timestamp: startedAt,
    text: "(detached review)",
    isSubagent: true,
  });

  let status = "done";
  let error = null;

  try {
    const engine = new ContextEngine({ mdDbPath });
    await engine.initialize();

    log("Context engine init");
    await runSessionReview({
      trigger,
      sessionId,
      messages: spec.messages ?? [],
      compactionMeta: spec.compactionMeta,
      contextEngine: engine,
      rootDir: process.cwd(),
      createChildSession: (systemPrompt) => createChildRunner(systemPrompt, engine, log),
    });

    logger.logEvent({
      type: "prompt_complete",
      sessionId,
      runId: jobId,
      timestamp: Date.now(),
      durationMs: Date.now() - startedAt,
    });

    log("Review run complete");
    await engine.close();
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
    if (err?.stack) log(err.stack);
  } finally {
    logger.close();
  }

  const finishedAt = Date.now();
  const result = { jobId, sessionId, status, error, startedAt, finishedAt, trigger, resultPath, logPath };
  writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8");
  log(`Result written: ${resultPath}`);
}

function createChildRunner(systemPrompt, engine, log) {
  return createSimpleSession(systemPrompt, engine, log).then((session) => ({
    runReview: async (userMessage) => {
      await session.prompt(userMessage);
      return session.readOutput();
    },
    dispose: () => session.dispose(),
  }));
}

async function createSimpleSession(systemPrompt, engine, log) {
  const loader = new DefaultResourceLoader({
    extensionFactories: [
      (pi) => {
        pi.registerProvider("ollama", {
          baseUrl: OLLAMA_BASE_URL,
          apiKey: "ollama",
          api: "openai-completions",
          models: [
            {
              id: OLLAMA_MODEL,
              name: `Ollama / ${OLLAMA_MODEL}`,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32768,
              maxTokens: 4096,
              compat: {
                supportsDeveloperRole: false,
                maxTokensField: "max_tokens",
              },
            },
          ],
        });
      },
      createObsidiClawExtension({ mcpServer: createContextEngineMcpServer(engine) }),
    ],
    systemPromptOverride: () => systemPrompt,
  });

  await loader.reload();

  const { session } = await createAgentSession({
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
  });

  let buffer = "";

  const readOutput = () => {
    const messages = session.messages ?? [];
    const lastAssistant = [...messages].reverse().find((m) => m?.role === "assistant");
    return extractTextFromContent(lastAssistant?.content) ?? buffer;
  };

  return {
    prompt: async (text) => {
      log?.("Review child prompt start");
      await session.prompt(text);
      log?.("Review child prompt done");
    },
    readOutput,
    dispose: () => session.dispose(),
  };
}

function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in c) return String(c.text);
        return null;
      })
      .filter(Boolean);
    return parts.join("\n");
  }
  if (content && typeof content === "object" && "text" in content) return String(content.text);
  return null;
}

// Execute
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
