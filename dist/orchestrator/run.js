/**
 * Interactive entry point — launches a pi agent session with context injection.
 *
 * Flow:
 *   1. Context engine indexes md_db (LlamaIndex + Ollama embeddings)
 *   2. User types first prompt → context engine runs RAG → pi session created
 *      with retrieved context injected as system context
 *   3. User continues chatting — context engine does NOT re-run; pi session
 *      maintains full conversation history
 *
 * Usage:
 *   npx tsx orchestrator/run.ts
 *
 * Environment variables:
 *   OLLAMA_BASE_URL      — LLM endpoint   (default: http://10.0.132.100/v1)
 *   OLLAMA_MODEL         — LLM model      (default: llama3)
 *   OLLAMA_HOST          — embeddings host (default: 10.0.132.100)
 *   OLLAMA_EMBED_MODEL   — embeddings model (default: nomic-embed-text:v1.5)
 *   OBSIDI_CLAW_DEBUG    — set to 1/true to write all session events as JSONL
 *                          to .obsidi-claw/debug/{sessionId}.jsonl
 */
import { createInterface } from "readline";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { Orchestrator } from "./orchestrator.js";
import { RunLogger } from "../logger/index.js";
import { ContextEngine } from "../context_engine/index.js";
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const mdDbPath = resolve(__dirname, "../md_db");
// ── Boot ──────────────────────────────────────────────────────────────────
//console.log("[obsidi-claw] Initializing context engine...");
const contextEngine = new ContextEngine({ mdDbPath });
await contextEngine.initialize();
//console.log("[obsidi-claw] Context engine ready.\n");
const debugEnabled = ["1", "true"].includes((process.env["OBSIDI_CLAW_DEBUG"] ?? "").toLowerCase());
const logger = new RunLogger(debugEnabled ? { debugDir: resolve(__dirname, "../.obsidi-claw/debug") } : {});
const orchestrator = new Orchestrator(logger, contextEngine);
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
let activePrompt = null;
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
    activePrompt = session.prompt(text).then(() => { process.stdout.write("\n"); }, (err) => { console.error("\n[error]", err instanceof Error ? err.message : String(err)); }).finally(() => {
        activePrompt = null;
        rl.resume();
        rl.prompt();
    });
});
async function gracefulShutdown() {
    rl.pause();
    if (activePrompt)
        await activePrompt;
    try {
        await session.finalize();
    }
    catch (err) {
        console.error("\n[session_finalize_error]", err instanceof Error ? err.message : String(err));
    }
    finally {
        logger.close();
        process.exit(0);
    }
}
rl.on("close", () => { void gracefulShutdown(); });
process.on("SIGINT", () => {
    process.stdout.write("\n[obsidi-claw] Caught SIGINT, shutting down...\n");
    rl.close();
});
//# sourceMappingURL=run.js.map