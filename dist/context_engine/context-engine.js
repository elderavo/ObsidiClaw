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
import { Settings, MetadataMode } from "llamaindex";
import { OllamaEmbedding } from "@llamaindex/ollama";
import { buildIndex } from "./indexer.js";
const DEFAULT_OLLAMA_HOST = process.env["OLLAMA_HOST"] ?? "10.0.132.100";
const DEFAULT_EMBED_MODEL = process.env["OLLAMA_EMBED_MODEL"] ?? "nomic-embed-text:v1.5";
const DEFAULT_TOP_K = 5;
export class ContextEngine {
    index = null;
    config;
    constructor(config) {
        this.config = {
            mdDbPath: config.mdDbPath,
            ollamaHost: config.ollamaHost ?? DEFAULT_OLLAMA_HOST,
            embeddingModel: config.embeddingModel ?? DEFAULT_EMBED_MODEL,
            topK: config.topK ?? DEFAULT_TOP_K,
        };
    }
    /**
     * Must be called before build(). Configures the embedding model and
     * builds the VectorStoreIndex from md_db.
     *
     * Idempotent — safe to call multiple times (only indexes once).
     */
    async initialize() {
        if (this.index)
            return;
        // Configure LlamaIndex to use Ollama for embeddings
        Settings.embedModel = new OllamaEmbedding({
            model: this.config.embeddingModel,
            config: { host: this.config.ollamaHost },
        });
        console.log(`[context_engine] Indexing ${this.config.mdDbPath} ` +
            `with embedding model "${this.config.embeddingModel}" ` +
            `@ ${this.config.ollamaHost}`);
        this.index = await buildIndex(this.config.mdDbPath);
        console.log("[context_engine] Index ready");
    }
    /**
     * Build a ContextPackage for the given prompt.
     * Retrieves top-K relevant notes from md_db via vector similarity.
     *
     * Throws if initialize() has not been called.
     */
    async build(prompt) {
        if (!this.index) {
            throw new Error("ContextEngine not initialized. Call initialize() first.");
        }
        const t0 = Date.now();
        const retriever = this.index.asRetriever({ similarityTopK: this.config.topK });
        const rawResults = await retriever.retrieve(prompt);
        const retrievedNotes = rawResults
            .filter((r) => r.node.metadata["file_path"] !== undefined)
            .map((r) => {
            const path = String(r.node.metadata["file_path"] ?? "");
            const type = inferNoteType(path);
            const toolId = type === "tool" ? path.replace(/^tools\//, "").replace(/\.md$/, "") : undefined;
            return {
                path,
                content: r.node.getContent(MetadataMode.NONE),
                score: r.score ?? 0,
                type,
                toolId,
            };
        })
            .sort((a, b) => b.score - a.score);
        const suggestedTools = retrievedNotes
            .filter((n) => n.type === "tool" && n.toolId !== undefined)
            .map((n) => n.toolId);
        const formattedContext = formatContext(prompt, retrievedNotes);
        const retrievalMs = Date.now() - t0;
        return {
            query: prompt,
            retrievedNotes,
            suggestedTools,
            formattedContext,
            retrievalMs,
            builtAt: Date.now(),
        };
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function inferNoteType(relativePath) {
    if (relativePath.startsWith("tools/"))
        return "tool";
    if (relativePath.startsWith("concepts/"))
        return "concept";
    return "index";
}
/**
 * Format the retrieved notes into a markdown block suitable for injection
 * into the pi agent's context via agentsFilesOverride.
 *
 * The agent sees this as additional system-level context before the user prompt.
 *
 * TODO: Phase 5 — refine format based on what the agent responds best to
 * TODO: Phase 6 — append tool execution outputs here
 */
function formatContext(query, notes) {
    if (notes.length === 0) {
        return "<!-- ObsidiClaw: no relevant knowledge base context found for this query -->";
    }
    const conceptNotes = notes.filter((n) => n.type === "concept" || n.type === "index");
    const toolNotes = notes.filter((n) => n.type === "tool");
    const lines = [
        "<!-- ObsidiClaw Knowledge Base Context -->",
        "<!-- Retrieved via RAG from md_db based on your query -->",
        "",
        "# Knowledge Base Context",
        "",
    ];
    if (conceptNotes.length > 0) {
        lines.push("## Relevant Notes");
        for (const note of conceptNotes) {
            lines.push(`\n### ${note.path} (score: ${note.score.toFixed(3)})`);
            lines.push(note.content.trim());
        }
        lines.push("");
    }
    if (toolNotes.length > 0) {
        lines.push("## Suggested Tools");
        lines.push("The following tools from the knowledge base may be relevant to this query.");
        lines.push("Tool outputs will be available in a future phase.");
        for (const note of toolNotes) {
            lines.push(`\n### Tool: ${note.toolId} (${note.path})`);
            lines.push(note.content.trim());
        }
        lines.push("");
    }
    lines.push("<!-- End ObsidiClaw Context -->");
    return lines.join("\n");
}
//# sourceMappingURL=context-engine.js.map