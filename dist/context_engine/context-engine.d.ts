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
 */
import { VectorStoreIndex } from "llamaindex";
import { SqliteGraphStore } from "./store/graph-store.js";
import type { ContextEngineConfig, ContextPackage, SubagentInput, SubagentPackage, PruneCluster, PruneConfig } from "./types.js";
export declare class ContextEngine {
    private vectorIndex;
    private graphStore;
    private readonly config;
    private readonly onDebug;
    private readonly reviewer;
    private readonly pruneConfig;
    constructor(config: ContextEngineConfig);
    /**
     * Must be called before build(). Idempotent — safe to call multiple times.
     *
     * Fast path (md_db unchanged since last run):
     *   Loads the persisted vector index from disk — no file parsing, no Ollama calls.
     *
     * Slow path (first run, or md_db files added/modified/removed):
     *   Syncs md_db → SQLite graph (two-pass: notes, then edges), re-embeds all
     *   notes via Ollama, persists the vector index to .obsidi-claw/vector-index/,
     *   and saves an mtime fingerprint so the next startup can use the fast path.
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
     * Build a SubagentPackage for the given subagent input.
     *
     * Runs hybrid retrieval against the plan (the richest query signal),
     * then bundles the input + retrieved context into a formatted system prompt
     * ready to inject into a child Pi session.
     *
     * Throws if initialize() has not been called.
     */
    buildSubagentPackage(input: SubagentInput): Promise<SubagentPackage>;
    /**
     * Build pruning clusters from the current vector index + graph store.
     * Writes results into prune_clusters tables and returns the in-memory clusters.
     */
    buildPruneClusters(configOverride?: Partial<PruneConfig>): Promise<PruneCluster[]>;
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
     * Complete reindex after md_db files change at runtime.
     * Performs full pipeline: sync markdown → rebuild vector index → rebuild link graph.
     *
     * Call this when the system adds/modifies/deletes files in md_db during runtime.
     */
    reindex(): Promise<void>;
    /**
     * Rebuild just the link graph after md_db changes.
     * More efficient than full reindex if only link relationships changed.
     */
    rebuildLinkGraph(): Promise<void>;
    /**
     * Close the underlying SQLite database.
     * Call when the context engine is no longer needed.
     */
    close(): void;
    private debug;
}
//# sourceMappingURL=context-engine.d.ts.map