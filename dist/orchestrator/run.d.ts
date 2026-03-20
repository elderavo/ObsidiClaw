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
 *   OLLAMA_BASE_URL    — LLM endpoint   (default: http://10.0.132.100/v1)
 *   OLLAMA_MODEL       — LLM model      (default: llama3)
 *   OLLAMA_HOST        — embeddings host (default: 10.0.132.100)
 *   OLLAMA_EMBED_MODEL — embeddings model (default: nomic-embed-text:v1.5)
 */
export {};
//# sourceMappingURL=run.d.ts.map