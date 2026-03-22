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
export {};
//# sourceMappingURL=run.d.ts.map