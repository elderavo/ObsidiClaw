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
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { Settings } from "llamaindex";
import { OllamaEmbedding } from "@llamaindex/ollama";
import { syncMdDbToGraph, buildVectorIndexFromGraph } from "./indexer.js";
import { hybridRetrieve } from "./retrieval/hybrid.js";
import { SqliteGraphStore } from "./store/sqlite_graph.js";
import { stripFrontmatter, estimateTokens } from "./frontmatter.js";
const DEFAULT_OLLAMA_HOST = process.env["OLLAMA_HOST"] ?? "10.0.132.100";
const DEFAULT_EMBED_MODEL = process.env["OLLAMA_EMBED_MODEL"] ?? "nomic-embed-text:v1.5";
const DEFAULT_TOP_K = 5;
export class ContextEngine {
    vectorIndex = null;
    graphStore = null;
    config;
    constructor(config) {
        const mdDbPath = config.mdDbPath;
        const defaultDbPath = join(dirname(mdDbPath), ".obsidi-claw", "graph.db");
        this.config = {
            mdDbPath,
            dbPath: config.dbPath ?? defaultDbPath,
            ollamaHost: config.ollamaHost ?? DEFAULT_OLLAMA_HOST,
            embeddingModel: config.embeddingModel ?? DEFAULT_EMBED_MODEL,
            topK: config.topK ?? DEFAULT_TOP_K,
        };
    }
    /**
     * Must be called before build(). Idempotent — safe to call multiple times.
     *
     * 1. Configures LlamaIndex embedding model (Ollama)
     * 2. Opens the SQLite graph store (creates .obsidi-claw/ dir if needed)
     * 3. Syncs md_db markdown files into the graph (two-pass: notes, then edges)
     * 4. Builds in-memory VectorStoreIndex from graph notes
     */
    async initialize() {
        if (this.vectorIndex)
            return;
        // Ensure .obsidi-claw/ directory exists
        mkdirSync(dirname(this.config.dbPath), { recursive: true });
        // Configure LlamaIndex embeddings
        Settings.embedModel = new OllamaEmbedding({
            model: this.config.embeddingModel,
            config: { host: this.config.ollamaHost },
        });
        // console.log(
        //   `[context_engine] Initializing — mdDb: ${this.config.mdDbPath}, ` +
        //     `db: ${this.config.dbPath}, ` +
        //     `embed: ${this.config.embeddingModel} @ ${this.config.ollamaHost}`,
        // );
        // Open graph store
        this.graphStore = new SqliteGraphStore(this.config.dbPath);
        // Sync md_db → graph (parse + upsert notes, then resolve wikilinks)
        await syncMdDbToGraph(this.config.mdDbPath, this.graphStore);
        // Build vector index from graph notes
        this.vectorIndex = await buildVectorIndexFromGraph(this.graphStore);
        //console.log("[context_engine] Ready");
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
        const { seedNotes, expandedNotes } = await hybridRetrieve(prompt, this.vectorIndex, this.graphStore, this.config.topK);
        const allNotes = [...seedNotes, ...expandedNotes].sort((a, b) => b.score - a.score);
        const suggestedTools = allNotes
            .filter((n) => n.type === "tool" && n.toolId !== undefined)
            .map((n) => n.toolId);
        const rawChars = allNotes.reduce((sum, n) => sum + n.content.length, 0);
        const formattedContext = formatContext(seedNotes, expandedNotes);
        const retrievalMs = Date.now() - t0;
        return {
            query: prompt,
            retrievedNotes: allNotes,
            suggestedTools,
            formattedContext,
            retrievalMs,
            builtAt: Date.now(),
            seedNoteIds: seedNotes.map((n) => n.noteId),
            expandedNoteIds: expandedNotes.map((n) => n.noteId),
            rawChars,
            strippedChars: formattedContext.length,
            estimatedTokens: estimateTokens(formattedContext),
        };
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
     * Close the underlying SQLite database.
     * Call when the context engine is no longer needed.
     */
    close() {
        this.graphStore?.close();
        this.graphStore = null;
        this.vectorIndex = null;
    }
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
        lines.push("_Tool nodes from the knowledge base. Tool outputs will be injected in Phase 6._");
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