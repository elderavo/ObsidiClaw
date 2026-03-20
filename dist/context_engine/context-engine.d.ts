/**
 * ContextEngine — the retrieval heart of ObsidiClaw.
 *
 * Responsibilities:
 * 1. initialize(): configure Ollama embeddings, open/sync SQLite graph,
 *    build VectorStoreIndex from graph notes
 * 2. build(prompt): hybrid retrieval (vector seeds + graph expansion),
 *    package results into a ContextPackage for pi session injection
 *
 * The orchestrator calls this in the `context_inject` lifecycle stage, before
 * creating the pi agent session. The returned ContextPackage is injected into
 * the session via agentsFilesOverride, becoming part of the agent's system context.
 *
 * TODO: Phase 6 — tool execution: orchestrator runs suggestedTools and their
 *   outputs are appended to formattedContext before the agent sees it
 */
import type { ContextEngineConfig, ContextPackage } from "./types.js";
export declare class ContextEngine {
    private vectorIndex;
    private graphStore;
    private readonly config;
    constructor(config: ContextEngineConfig);
    /**
     * Must be called before build(). Idempotent — safe to call multiple times.
     *
     * 1. Configures LlamaIndex embedding model (Ollama)
     * 2. Opens the SQLite graph store (creates .obsidi-claw/ dir if needed)
     * 3. Syncs md_db markdown files into the graph (two-pass: notes, then edges)
     * 4. Builds in-memory VectorStoreIndex from graph notes
     */
    initialize(): Promise<void>;
    /**
     * Build a ContextPackage for the given prompt.
     * Runs hybrid retrieval: vector seeds + graph-expanded neighbors.
     *
     * Throws if initialize() has not been called.
     */
    build(prompt: string): Promise<ContextPackage>;
    /**
     * Close the underlying SQLite database.
     * Call when the context engine is no longer needed.
     */
    close(): void;
}
//# sourceMappingURL=context-engine.d.ts.map