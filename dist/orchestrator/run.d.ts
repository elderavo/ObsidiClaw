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
export {};
//# sourceMappingURL=run.d.ts.map