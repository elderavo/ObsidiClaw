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
import { VectorStoreIndex } from "llamaindex";
import { SqliteGraphStore } from "./store/sqlite_graph.js";
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
     * Return the stripped body of a specific note by relative path.
     * Returns null if the note is not in the graph or the engine is not initialized.
     *
     * The body is already frontmatter-stripped (stored without frontmatter by the parser).
     */
    getNoteContent(relativePath: string): string | null;
    /**
     * Get access to the underlying SQLite graph store.
     * Returns null if the engine is not initialized.
     *
     * This allows extensions to add additional content to the same graph.
     */
    getGraphStore(): SqliteGraphStore | null;
    /**
     * Get access to the vector index for rebuilding after adding new documents.
     * Returns null if the engine is not initialized.
     */
    getVectorIndex(): VectorStoreIndex | null;
    /**
     * Rebuild the vector index from current graph content.
     * Call this after adding new documents to the graph store.
     */
    rebuildVectorIndex(): Promise<void>;
    /**
     * Close the underlying SQLite database.
     * Call when the context engine is no longer needed.
     */
    close(): void;
}
//# sourceMappingURL=context-engine.d.ts.map