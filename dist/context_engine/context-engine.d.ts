/**
 * ContextEngine — the RAG heart of ObsidiClaw.
 *
 * Responsibilities:
 * 1. On initialize(): configure Ollama embeddings, build VectorStoreIndex from md_db
 * 2. On build(prompt): retrieve top-K relevant notes, classify tool vs concept nodes,
 *    format a context package ready for injection into the pi session
 *
 * The orchestrator calls this in the `context_inject` lifecycle stage, before
 * creating the pi agent session. The returned ContextPackage is injected into
 * the session via agentsFilesOverride, becoming part of the agent's system context.
 *
 * TODO: Phase 5 — graph traversal: follow [[wikilinks]] in retrieved notes to
 *   pull in linked nodes (breadth-first up to depth 2)
 * TODO: Phase 6 — tool execution: orchestrator runs suggestedTools, and their
 *   outputs are appended to formattedContext before agent sees it
 */
import type { ContextEngineConfig, ContextPackage } from "./types.js";
export declare class ContextEngine {
    private index;
    private readonly config;
    constructor(config: ContextEngineConfig);
    /**
     * Must be called before build(). Configures the embedding model and
     * builds the VectorStoreIndex from md_db.
     *
     * Idempotent — safe to call multiple times (only indexes once).
     */
    initialize(): Promise<void>;
    /**
     * Build a ContextPackage for the given prompt.
     * Retrieves top-K relevant notes from md_db via vector similarity.
     *
     * Throws if initialize() has not been called.
     */
    build(prompt: string): Promise<ContextPackage>;
}
//# sourceMappingURL=context-engine.d.ts.map