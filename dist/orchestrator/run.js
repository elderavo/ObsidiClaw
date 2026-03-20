/**
 * Orchestrator demo entry point.
 *
 * Runs a single prompt through the full orchestrator lifecycle:
 *   init → context_inject (LlamaIndex RAG) → run (pi agent) → post_process → done
 *
 * Usage:
 *   npx tsx orchestrator/run.ts
 *   npx tsx orchestrator/run.ts "Your prompt here"
 *
 * Environment variables:
 *   OLLAMA_BASE_URL    — default: http://10.0.132.100/v1  (pi agent LLM)
 *   OLLAMA_MODEL       — default: llama3                  (pi agent model)
 *   OLLAMA_HOST        — default: 10.0.132.100            (embeddings host)
 *   OLLAMA_EMBED_MODEL — default: nomic-embed-text        (embedding model)
 */
import { resolve } from "path";
import { fileURLToPath } from "url";
import { Orchestrator } from "./orchestrator.js";
import { RunLogger } from "../logger/index.js";
import { ContextEngine } from "../context_engine/index.js";
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const mdDbPath = resolve(__dirname, "../md_db");
// Initialize context engine and build the index
const contextEngine = new ContextEngine({ mdDbPath });
await contextEngine.initialize();
const logger = new RunLogger();
const orchestrator = new Orchestrator(logger, contextEngine);
console.log("Starting orchestrator run...\n");
const result = await orchestrator.run({
    prompt: process.argv[2] ?? "What is 2 + 2?",
});
console.log("\n── Run complete ──────────────────────────────────");
console.log(`  run_id   : ${result.runId}`);
console.log(`  stage    : ${result.stage}`);
console.log(`  duration : ${result.durationMs}ms`);
if (result.error) {
    console.log(`  error    : ${result.error}`);
}
console.log("──────────────────────────────────────────────────");
//# sourceMappingURL=run.js.map