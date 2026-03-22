/**
 * Headless entry point — for scripting, testing, and gateway integrations.
 *
 * For interactive use, run `pi` directly. The ObsidiClaw extension
 * (extension/factory.ts) provides the full stack: context injection,
 * scheduler, subagent tools, and event logging.
 *
 * This entry point creates its own readline loop and is useful when
 * Pi's TUI is not available or not desired (e.g., Telegram gateway,
 * CI pipelines, automated testing).
 *
 * Usage:
 *   npx tsx orchestrator/run.ts
 *
 * Environment variables:
 *   OLLAMA_BASE_URL      — LLM endpoint   (default: http://10.0.132.100/v1)
 *   OLLAMA_MODEL         — LLM model      (default: cogito:8b)
 *   OLLAMA_HOST          — embeddings host (default: 10.0.132.100)
 *   OLLAMA_EMBED_MODEL   — embeddings model (default: nomic-embed-text:v1.5)
 *   OBSIDI_CLAW_DEBUG    — set to 0/false to disable debug JSONL (ON by default)
 */

import { createInterface } from "readline";
import { resolve } from "path";
import { fileURLToPath } from "url";

import { Orchestrator } from "./orchestrator.js";
import { resolvePaths } from "../shared/config.js";
import { exitProcess, onSignal } from "../shared/os/process.js";
import { createObsidiClawStack } from "../shared/stack.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// When running from dist/, go up two levels (dist/orchestrator/ → project root).
// When running from source via tsx, go up one level (orchestrator/ → project root).
const paths = resolvePaths(resolve(__dirname, __dirname.includes("dist") ? "../.." : ".."));

// ── Boot ──────────────────────────────────────────────────────────────────

const stack = createObsidiClawStack({ rootDir: paths.rootDir });
await stack.initialize();

const orchestrator = new Orchestrator(stack.logger, stack.engine, stack.scheduler, stack.runner, stack.persistentBackend);

// ── Start session ─────────────────────────────────────────────────────────

const session = orchestrator.createSession({
  onOutput: (delta) => process.stdout.write(delta),
});

// console.log("[obsidi-claw] Session started. Type your prompt and press Enter.");
// console.log("[obsidi-claw] First prompt → context injection + pi session creation.");
// console.log("[obsidi-claw] Ctrl+C or Ctrl+D to exit.\n");

// ── Readline loop ─────────────────────────────────────────────────────────

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "you> ",
  terminal: true,
});

let activePrompt: Promise<void> | null = null;
let rlClosed = false;

rl.prompt();

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) {
    rl.prompt();
    return;
  }

  // Graceful shutdown via command
  if (text === "/quit" || text === "/exit") {
    rl.close();
    return;
  }

  rl.pause();
  process.stdout.write("\nagent> ");

  activePrompt = session.prompt(text).then(
    () => { process.stdout.write("\n"); },
    (err) => { console.error("\n[error]", err instanceof Error ? err.message : String(err)); },
  ).finally(() => {
    activePrompt = null;
    rl.resume();
    rl.prompt();
  });
});

async function gracefulShutdown() {
  if (rlClosed) return;
  rlClosed = true;
  try { rl.pause(); } catch { /* already closed */ }
  if (activePrompt) await activePrompt;
  try {
    await session.finalize();
  } catch (err) {
    console.error("\n[session_finalize_error]", err instanceof Error ? err.message : String(err));
  } finally {
    await stack.shutdown();
    exitProcess(0);
  }
}

rl.on("close", () => { void gracefulShutdown(); });

onSignal("SIGINT", () => {
  process.stdout.write("\n[obsidi-claw] Caught SIGINT, shutting down...\n");
  rl.close();
});
