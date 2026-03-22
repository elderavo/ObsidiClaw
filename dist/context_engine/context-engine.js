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
import { ensureDir, fileExists } from "../shared/os/fs.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Settings, VectorStoreIndex, storageContextFromDefaults } from "llamaindex";
import { OllamaEmbedding } from "@llamaindex/ollama";
import { syncMdDbToGraph, buildVectorIndexFromGraph, computeMdDbHash } from "./graph-indexer.js";
import { hybridRetrieve } from "./retrieval/hybrid-retrieval.js";
import { SqliteGraphStore } from "./store/graph-store.js";
import { stripFrontmatter, estimateTokens } from "./frontmatter-utils.js";
import { loadPersonality } from "../shared/agents/personality-loader.js";
import { ContextReviewer } from "./review/context-reviewer.js";
import { PruneClusterStorage } from "./prune/prune-storage.js";
import { buildPruneClusters as buildPruneClustersOp } from "./prune/prune-builder.js";
const DEFAULT_OLLAMA_HOST = process.env["OLLAMA_HOST"] ?? "10.0.132.100";
const DEFAULT_EMBED_MODEL = process.env["OLLAMA_EMBED_MODEL"] ?? "nomic-embed-text:v1.5";
const DEFAULT_TOP_K = 5;
const DEFAULT_PERSONALITIES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "agents", "personalities");
const DEFAULT_PRUNE_CONFIG = {
    similarityThreshold: 0.9,
    maxNeighborsPerNote: 10,
    minClusterSize: 2,
    includeNoteTypes: ["concept"],
    excludeTags: [],
};
export class ContextEngine {
    vectorIndex = null;
    graphStore = null;
    config;
    onDebug;
    reviewer;
    pruneConfig;
    constructor(config) {
        const mdDbPath = config.mdDbPath;
        const defaultDbPath = join(dirname(mdDbPath), ".obsidi-claw", "graph.db");
        this.config = {
            mdDbPath,
            dbPath: config.dbPath ?? defaultDbPath,
            ollamaHost: config.ollamaHost ?? DEFAULT_OLLAMA_HOST,
            embeddingModel: config.embeddingModel ?? DEFAULT_EMBED_MODEL,
            topK: config.topK ?? DEFAULT_TOP_K,
            personalitiesDir: config.personalitiesDir ?? DEFAULT_PERSONALITIES_DIR,
            review: config.review,
            pruneConfig: config.pruneConfig,
        };
        this.onDebug = config.onDebug;
        this.pruneConfig = {
            ...DEFAULT_PRUNE_CONFIG,
            ...(config.pruneConfig ?? {}),
        };
        // Initialize context reviewer — always-on unless explicitly disabled
        this.reviewer = config.review?.enabled === false
            ? null
            : new ContextReviewer({
                ...(config.review ?? {}),
                personalitiesDir: this.config.personalitiesDir,
            });
    }
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
    async initialize() {
        if (this.vectorIndex)
            return;
        const t0 = Date.now();
        ensureDir(dirname(this.config.dbPath));
        Settings.embedModel = new OllamaEmbedding({
            model: this.config.embeddingModel,
            config: { host: this.config.ollamaHost },
        });
        this.graphStore = new SqliteGraphStore(this.config.dbPath);
        const vectorDir = join(dirname(this.config.dbPath), "vector-index");
        const vectorFile = join(vectorDir, "vector_store.json");
        const currentHash = await computeMdDbHash(this.config.mdDbPath);
        const storedHash = this.graphStore.getState("md_db_hash");
        if (currentHash === storedHash && fileExists(vectorFile)) {
            // ── Fast path: nothing changed ─────────────────────────────────────────
            this.debug({ type: "ce_init_start", timestamp: Date.now(), path: "fast" });
            const storageContext = await storageContextFromDefaults({ persistDir: vectorDir });
            this.vectorIndex = await VectorStoreIndex.init({ storageContext });
            this.debug({ type: "ce_init_end", timestamp: Date.now(), path: "fast", durationMs: Date.now() - t0, noteCount: this.graphStore.listAllNotes().length });
            return;
        }
        // ── Slow path: md_db changed (or first run) ─────────────────────────────
        this.debug({ type: "ce_init_start", timestamp: Date.now(), path: "slow" });
        await syncMdDbToGraph(this.config.mdDbPath, this.graphStore);
        const storageContext = await storageContextFromDefaults({ persistDir: vectorDir });
        this.vectorIndex = await buildVectorIndexFromGraph(this.graphStore, storageContext);
        // Record the hash so the next startup can take the fast path.
        this.graphStore.setState("md_db_hash", currentHash);
        this.debug({ type: "ce_init_end", timestamp: Date.now(), path: "slow", durationMs: Date.now() - t0, noteCount: this.graphStore.listAllNotes().length });
    }
    /**
     * Build a ContextPackage for the given prompt.
     * Runs hybrid retrieval: vector seeds + graph-expanded neighbors.
     *
     * Throws if initialize() has not been called.
     */
    async build(prompt) {
        if (!this.vectorIndex || !this.graphStore) {
            throw new Error("ContextEngine not initialized. Call initialize() first.");
        }
        const t0 = Date.now();
        this.debug({ type: "ce_retrieval_start", timestamp: t0, query: prompt.slice(0, 200), topK: this.config.topK });
        const tVector = Date.now();
        const { seedNotes, expandedNotes } = await hybridRetrieve(prompt, this.vectorIndex, this.graphStore, this.config.topK);
        this.debug({ type: "ce_vector_done", timestamp: Date.now(), seedCount: seedNotes.length, durationMs: Date.now() - tVector });
        const tGraph = Date.now();
        let allNotes = [...seedNotes, ...expandedNotes].sort((a, b) => b.score - a.score);
        this.debug({ type: "ce_graph_done", timestamp: Date.now(), expandedCount: expandedNotes.length, durationMs: Date.now() - tGraph });
        // ── Format raw context ──────────────────────────────────────────────
        const suggestedTools = allNotes
            .filter((n) => n.type === "tool" && n.toolId !== undefined)
            .map((n) => n.toolId);
        const rawChars = allNotes.reduce((sum, n) => sum + n.content.length, 0);
        const filteredSeeds = allNotes.filter((n) => n.depth === 0 || n.retrievalSource === "vector");
        const filteredExpanded = allNotes.filter((n) => (n.depth ?? 0) > 0 && n.retrievalSource !== "vector");
        const rawFormattedContext = formatContext(filteredSeeds, filteredExpanded);
        // ── Optional context review / synthesis ───────────────────────────────
        let formattedContext = rawFormattedContext;
        let reviewResult;
        if (this.reviewer) {
            const avgScore = allNotes.length > 0 ? allNotes.reduce((sum, n) => sum + n.score, 0) / allNotes.length : 0;
            this.debug({ type: "ce_review_start", timestamp: Date.now(), noteCount: allNotes.length, avgScore });
            const review = await this.reviewer.review(prompt, allNotes, rawFormattedContext);
            reviewResult = {
                reviewMs: review.reviewMs,
                skipped: review.skipped,
                skipReason: review.skipReason,
            };
            this.debug({
                type: "ce_review_done",
                timestamp: Date.now(),
                skipped: review.skipped,
                skipReason: review.skipReason,
                reviewMs: review.reviewMs,
                inputChars: rawFormattedContext.length,
                outputChars: review.synthesizedContext?.length,
            });
            if (!review.skipped && review.synthesizedContext) {
                formattedContext = review.synthesizedContext;
            }
        }
        const retrievalMs = Date.now() - t0;
        return {
            query: prompt,
            retrievedNotes: allNotes,
            suggestedTools,
            formattedContext,
            retrievalMs,
            builtAt: Date.now(),
            seedNoteIds: filteredSeeds.map((n) => n.noteId),
            expandedNoteIds: filteredExpanded.map((n) => n.noteId),
            rawChars,
            strippedChars: formattedContext.length,
            estimatedTokens: estimateTokens(formattedContext),
            reviewResult,
        };
    }
    /**
     * Build a SubagentPackage for the given subagent input.
     *
     * Runs hybrid retrieval against the plan (the richest query signal),
     * then bundles the input + retrieved context into a formatted system prompt
     * ready to inject into a child Pi session.
     *
     * Throws if initialize() has not been called.
     */
    async buildSubagentPackage(input) {
        if (!this.vectorIndex || !this.graphStore) {
            throw new Error("ContextEngine not initialized. Call initialize() first.");
        }
        // Combine plan + prompt for retrieval; plan carries the most signal
        const query = [input.plan, input.prompt].filter(Boolean).join(" ").slice(0, 1000);
        const contextPackage = await this.build(query);
        // Resolve personality if specified
        let personalityConfig;
        if (input.personality) {
            personalityConfig = loadPersonality(input.personality, this.config.personalitiesDir) ?? undefined;
        }
        return {
            input,
            contextPackage,
            formattedSystemPrompt: formatSubagentSystemPrompt(input, contextPackage, personalityConfig?.content),
            personalityConfig,
            builtAt: Date.now(),
        };
    }
    /**
     * Build pruning clusters from the current vector index + graph store.
     * Writes results into prune_clusters tables and returns the in-memory clusters.
     */
    async buildPruneClusters(configOverride) {
        if (!this.vectorIndex || !this.graphStore) {
            throw new Error("ContextEngine not initialized. Call initialize() first.");
        }
        const effectiveConfig = {
            ...this.pruneConfig,
            ...(configOverride ?? {}),
        };
        const clusters = await buildPruneClustersOp(effectiveConfig, this.vectorIndex, this.graphStore);
        const storage = new PruneClusterStorage(this.graphStore.getDatabase());
        storage.resetClusters();
        storage.storeClusters(clusters);
        return clusters;
    }
    /**
     * Return the stripped body of a specific note by relative path.
     * Returns null if the note is not in the graph or the engine is not initialized.
     *
     * The body is already frontmatter-stripped (stored without frontmatter by the parser).
     */
    getNoteContent(relativePath) {
        return this.graphStore?.getNoteByPath(relativePath)?.body ?? null;
    }
    /**
     * Get access to the underlying SQLite graph store.
     * Returns null if the engine is not initialized.
     *
     * This allows extensions to add additional content to the same graph.
     */
    getGraphStore() {
        return this.graphStore;
    }
    /**
     * Get access to the vector index for rebuilding after adding new documents.
     * Returns null if the engine is not initialized.
     */
    getVectorIndex() {
        return this.vectorIndex;
    }
    /**
     * Rebuild the vector index from current graph content.
     * Call this after adding new documents to the graph store.
     */
    async rebuildVectorIndex() {
        if (!this.graphStore) {
            throw new Error("ContextEngine not initialized. Call initialize() first.");
        }
        this.vectorIndex = await buildVectorIndexFromGraph(this.graphStore);
    }
    /**
     * Complete reindex after md_db files change at runtime.
     * Performs full pipeline: sync markdown → rebuild vector index → rebuild link graph.
     *
     * Call this when the system adds/modifies/deletes files in md_db during runtime.
     */
    async reindex() {
        if (!this.graphStore) {
            throw new Error("ContextEngine not initialized. Call initialize() first.");
        }
        const t0 = Date.now();
        // Fast path: skip if md_db hasn't changed since last sync
        const currentHash = await computeMdDbHash(this.config.mdDbPath);
        const storedHash = this.graphStore.getState("md_db_hash");
        if (currentHash === storedHash) {
            this.debug({ type: "ce_reindex_start", timestamp: t0, path: "skipped" });
            this.debug({ type: "ce_reindex_done", timestamp: Date.now(), durationMs: Date.now() - t0, noteCount: 0, skipped: true });
            return;
        }
        this.debug({ type: "ce_reindex_start", timestamp: t0, path: "full" });
        try {
            await syncMdDbToGraph(this.config.mdDbPath, this.graphStore);
            const vectorDir = join(dirname(this.config.dbPath), "vector-index");
            const storageContext = await storageContextFromDefaults({ persistDir: vectorDir });
            this.vectorIndex = await buildVectorIndexFromGraph(this.graphStore, storageContext);
            // Update hash so next check fast-paths
            this.graphStore.setState("md_db_hash", currentHash);
            this.debug({ type: "ce_reindex_done", timestamp: Date.now(), durationMs: Date.now() - t0, noteCount: this.graphStore.listAllNotes().length, skipped: false });
            console.log("[context_engine] Full reindex completed");
        }
        catch (error) {
            console.error("[context_engine] Full reindex failed:", error);
            throw error;
        }
    }
    /**
     * Rebuild just the link graph after md_db changes.
     * More efficient than full reindex if only link relationships changed.
     */
    async rebuildLinkGraph() {
        if (!this.graphStore) {
            throw new Error("ContextEngine not initialized. Call initialize() first.");
        }
        const { LinkGraphProcessor } = await import("./link_graph/index.js");
        try {
            const linkProcessor = new LinkGraphProcessor(this.graphStore.getDatabase(), this.config.mdDbPath);
            // Rebuild the enhanced link graph
            await linkProcessor.buildFromMarkdownFiles();
            // Check for issues and warn if found  
            const isHealthy = await linkProcessor.isHealthy();
            if (!isHealthy) {
                const issues = await linkProcessor.getIntegrityIssues();
                const errorCount = issues.filter(i => i.severity === 'error').length;
                const warningCount = issues.filter(i => i.severity === 'warning').length;
                if (errorCount > 0) {
                    console.warn(`[context_engine] Link graph rebuild: ${errorCount} errors, ${warningCount} warnings`);
                }
            }
        }
        catch (error) {
            console.error('[context_engine] Link graph rebuild failed:', error);
            throw error;
        }
    }
    /**
     * Close the underlying SQLite database.
     * Call when the context engine is no longer needed.
     */
    close() {
        this.graphStore?.close();
        this.graphStore = null;
        this.vectorIndex = null;
    }
    // ── Debug helper ──────────────────────────────────────────────────────────
    debug(event) {
        this.onDebug?.(event);
    }
}
// ---------------------------------------------------------------------------
// Subagent system prompt formatting
// ---------------------------------------------------------------------------
function formatSubagentSystemPrompt(input, ctx, personalityContent) {
    const sections = ["# Subagent Task"];
    if (personalityContent) {
        sections.push("", "## Personality", personalityContent);
    }
    sections.push("", "## Your Task", input.prompt, "", "## Implementation Plan", input.plan, "", "## Success Criteria", input.successCriteria, "", "## Retrieved Context", ctx.formattedContext, "", "---", "Focus exclusively on the plan above. Work systematically towards the success criteria.", "Use `retrieve_context` for additional knowledge lookup.");
    return sections.join("\n");
}
// ---------------------------------------------------------------------------
// Context formatting
// ---------------------------------------------------------------------------
/**
 * Format retrieved notes into a markdown block for injection into the pi
 * agent's context via agentsFilesOverride.
 *
 * Structure:
 *   ## Seed Notes        — direct vector matches (depth 0)
 *   ## Linked Notes      — graph-expanded neighbors (depth >= 1)
 *   ## Suggested Tools   — tool nodes from either tier
 */
function formatContext(seedNotes, expandedNotes) {
    const allNotes = [...seedNotes, ...expandedNotes];
    if (allNotes.length === 0) {
        return "<!-- ObsidiClaw: no relevant knowledge base context found for this query -->";
    }
    const lines = [
        "<!-- ObsidiClaw Knowledge Base Context -->",
        "",
        "# Knowledge Base Context",
        "",
    ];
    // Seed notes (non-tool)
    const seedConcepts = seedNotes.filter((n) => n.type !== "tool");
    if (seedConcepts.length > 0) {
        lines.push("## Seed Notes");
        lines.push("_Directly relevant notes retrieved by semantic similarity._");
        lines.push("");
        for (const note of seedConcepts) {
            lines.push(`### ${note.path} (score: ${note.score.toFixed(3)})`);
            lines.push(stripFrontmatter(note.content));
            lines.push("");
        }
    }
    // Graph-expanded notes (non-tool)
    const expandedConcepts = expandedNotes.filter((n) => n.type !== "tool");
    if (expandedConcepts.length > 0) {
        lines.push("## Linked Supporting Notes");
        lines.push("_Notes linked to seed notes via [[wikilinks]]._");
        lines.push("");
        for (const note of expandedConcepts) {
            const linkedFromPart = note.linkedFrom && note.linkedFrom.length > 0
                ? ` | Linked from: ${note.linkedFrom.join(", ")}`
                : "";
            lines.push(`### ${note.path} (score: ${note.score.toFixed(3)}${linkedFromPart})`);
            lines.push(stripFrontmatter(note.content));
            lines.push("");
        }
    }
    // Tool nodes (both tiers)
    const toolNotes = allNotes.filter((n) => n.type === "tool");
    if (toolNotes.length > 0) {
        lines.push("## Suggested Tools");
        lines.push("_Tool nodes from the knowledge base._");
        lines.push("");
        for (const note of toolNotes) {
            lines.push(`### Tool: ${note.toolId} (${note.path})`);
            lines.push(stripFrontmatter(note.content));
            lines.push("");
        }
    }
    lines.push("<!-- End ObsidiClaw Context -->");
    return lines.join("\n");
}
//# sourceMappingURL=context-engine.js.map