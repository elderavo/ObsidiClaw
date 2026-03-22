/**
 * ContextEngine — subprocess bridge to the Python knowledge_graph service.
 *
 * Public API is identical to the original TS-native implementation.
 * Internally, all vector/graph operations are delegated to a long-lived
 * Python subprocess (knowledge_graph) via JSON-RPC over stdin/stdout.
 *
 * What stays in TS:
 *   - Context formatting (formatContext, formatSubagentSystemPrompt)
 *   - Context reviewer (direct Ollama /api/chat call)
 *   - Debug event emission (ce_* events)
 *   - Prune storage (SQLite via better-sqlite3)
 *   - All public types
 *
 * What moves to Python:
 *   - md_db scanning/parsing
 *   - PropertyGraphIndex (replaces LlamaIndex TS + SQLite BFS)
 *   - Hybrid retrieval (VectorContextRetriever + tag boosting)
 *   - Hash-based change detection
 */
import type { ContextEngineConfig, ContextPackage, SubagentInput, SubagentPackage, PruneCluster, PruneConfig } from "./types.js";
export declare class ContextEngine {
    private subprocess;
    private rl;
    private readonly pendingRpc;
    private initialized;
    private pythonPath;
    /** In-memory note cache populated on init/reindex. */
    private noteCache;
    private readonly config;
    private readonly onDebug;
    private readonly reviewer;
    private readonly pruneConfig;
    constructor(config: ContextEngineConfig);
    /**
     * Must be called before build(). Idempotent — safe to call multiple times.
     *
     * Spawns the Python subprocess, sends `initialize` RPC (which handles
     * fast/slow path internally), and populates the note cache.
     */
    initialize(): Promise<void>;
    /**
     * Build a ContextPackage for the given prompt.
     * Sends `retrieve` RPC → formats context in TS → runs reviewer in TS.
     */
    build(prompt: string): Promise<ContextPackage>;
    /**
     * Build a SubagentPackage for the given subagent input.
     */
    buildSubagentPackage(input: SubagentInput): Promise<SubagentPackage>;
    /**
     * Build pruning clusters via Python RPC, store in local prune.db.
     */
    buildPruneClusters(configOverride?: Partial<PruneConfig>): Promise<PruneCluster[]>;
    /**
     * Return the stripped body of a specific note by relative path.
     * Reads from in-memory cache — no RPC needed.
     */
    getNoteContent(relativePath: string): string | null;
    /**
     * Get graph statistics via Python RPC.
     */
    getGraphStats(): Promise<{
        noteCount: number;
        edgeCount: number;
        indexLoaded: boolean;
    }>;
    /**
     * Complete reindex via Python RPC. Updates local note cache.
     */
    reindex(): Promise<void>;
    /**
     * Close the subprocess and clean up resources.
     */
    close(): void;
    private ensureSubprocess;
    /**
     * Resolve the Python executable path for the obsidiclaw conda environment.
     * Uses direct path (no conda run — conda run doesn't forward stdin on Windows).
     */
    private resolvePythonPath;
    private rpc;
    private handleResponse;
    private ensureInitialized;
    private debug;
}
//# sourceMappingURL=context-engine.d.ts.map