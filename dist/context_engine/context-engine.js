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
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { spawn, execSync } from "child_process";
import { createInterface } from "readline";
import { existsSync } from "fs";
import { ensureDir } from "../shared/os/fs.js";
import { stripFrontmatter, estimateTokens } from "./frontmatter-utils.js";
import { loadPersonality } from "../shared/agents/personality-loader.js";
import { ContextReviewer } from "./review/context-reviewer.js";
import { PruneClusterStorage } from "./prune/prune-storage.js";
import Database from "better-sqlite3";
const DEFAULT_OLLAMA_HOST = process.env["OLLAMA_HOST"] ?? "http://10.0.132.100:11434";
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
const RPC_TIMEOUT_MS = 120_000; // 2 minutes for long operations (indexing)
// ---------------------------------------------------------------------------
// ContextEngine — subprocess bridge
// ---------------------------------------------------------------------------
export class ContextEngine {
    subprocess = null;
    rl = null;
    pendingRpc = new Map();
    initialized = false;
    pythonPath = null;
    /** In-memory note cache populated on init/reindex. */
    noteCache = new Map();
    config;
    onDebug;
    reviewer;
    pruneConfig;
    constructor(config) {
        const mdDbPath = config.mdDbPath;
        const defaultDbPath = join(dirname(mdDbPath), ".obsidi-claw", "knowledge_graph");
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
    // =========================================================================
    // Public API
    // =========================================================================
    /**
     * Must be called before build(). Idempotent — safe to call multiple times.
     *
     * Spawns the Python subprocess, sends `initialize` RPC (which handles
     * fast/slow path internally), and populates the note cache.
     */
    async initialize() {
        if (this.initialized)
            return;
        const t0 = Date.now();
        this.debug({ type: "ce_init_start", timestamp: t0, path: "subprocess" });
        ensureDir(this.config.dbPath);
        await this.ensureSubprocess();
        const result = await this.rpc("initialize", {
            md_db_path: this.config.mdDbPath,
            db_dir: this.config.dbPath,
            ollama_host: this.config.ollamaHost,
            embed_model: this.config.embeddingModel,
            top_k: this.config.topK,
        });
        // Populate note cache
        this.noteCache.clear();
        for (const [key, val] of Object.entries(result.note_cache)) {
            this.noteCache.set(key, val);
        }
        this.initialized = true;
        this.debug({
            type: "ce_init_end",
            timestamp: Date.now(),
            path: result.path,
            durationMs: Date.now() - t0,
            noteCount: result.note_count,
        });
    }
    /**
     * Build a ContextPackage for the given prompt.
     * Sends `retrieve` RPC → formats context in TS → runs reviewer in TS.
     */
    async build(prompt) {
        this.ensureInitialized();
        const t0 = Date.now();
        this.debug({ type: "ce_retrieval_start", timestamp: t0, query: prompt.slice(0, 200), topK: this.config.topK });
        const tVector = Date.now();
        const rpcResult = await this.rpc("retrieve", {
            query: prompt,
            top_k: this.config.topK,
        });
        const seedNotes = rpcResult.seed_notes.map(rpcNoteToRetrievedNote);
        const expandedNotes = rpcResult.expanded_notes.map(rpcNoteToRetrievedNote);
        this.debug({ type: "ce_vector_done", timestamp: Date.now(), seedCount: seedNotes.length, durationMs: Date.now() - tVector });
        const tGraph = Date.now();
        const allNotes = [...seedNotes, ...expandedNotes].sort((a, b) => b.score - a.score);
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
     */
    async buildSubagentPackage(input) {
        this.ensureInitialized();
        const query = [input.plan, input.prompt].filter(Boolean).join(" ").slice(0, 1000);
        const contextPackage = await this.build(query);
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
     * Build pruning clusters via Python RPC, store in local prune.db.
     */
    async buildPruneClusters(configOverride) {
        this.ensureInitialized();
        const effectiveConfig = {
            ...this.pruneConfig,
            ...(configOverride ?? {}),
        };
        const result = await this.rpc("build_prune_clusters", {
            similarity_threshold: effectiveConfig.similarityThreshold,
            max_neighbors: effectiveConfig.maxNeighborsPerNote,
            min_cluster_size: effectiveConfig.minClusterSize,
            include_types: effectiveConfig.includeNoteTypes,
            exclude_tags: effectiveConfig.excludeTags ?? [],
        });
        // Store clusters in local prune.db
        const pruneDbPath = join(dirname(this.config.dbPath), "prune.db");
        const db = new Database(pruneDbPath);
        try {
            const storage = new PruneClusterStorage(db);
            storage.resetClusters();
            storage.storeClusters(result.clusters);
        }
        finally {
            db.close();
        }
        return result.clusters;
    }
    /**
     * Return the stripped body of a specific note by relative path.
     * Reads from in-memory cache — no RPC needed.
     */
    getNoteContent(relativePath) {
        return this.noteCache.get(relativePath) ?? null;
    }
    /**
     * Get graph statistics via Python RPC.
     */
    async getGraphStats() {
        if (!this.initialized) {
            return { noteCount: 0, edgeCount: 0, indexLoaded: false };
        }
        const result = await this.rpc("get_graph_stats", {});
        return {
            noteCount: result.note_count,
            edgeCount: result.edge_count,
            indexLoaded: result.index_loaded,
        };
    }
    /**
     * Complete reindex via Python RPC. Updates local note cache.
     */
    async reindex() {
        this.ensureInitialized();
        const t0 = Date.now();
        const result = await this.rpc("reindex", {});
        if (result.skipped) {
            this.debug({ type: "ce_reindex_start", timestamp: t0, path: "skipped" });
            this.debug({ type: "ce_reindex_done", timestamp: Date.now(), durationMs: Date.now() - t0, noteCount: 0, skipped: true });
            return;
        }
        // Update note cache
        this.noteCache.clear();
        for (const [key, val] of Object.entries(result.note_cache)) {
            this.noteCache.set(key, val);
        }
        this.debug({ type: "ce_reindex_start", timestamp: t0, path: "full" });
        this.debug({ type: "ce_reindex_done", timestamp: Date.now(), durationMs: Date.now() - t0, noteCount: result.note_count, skipped: false });
        console.log("[context_engine] Full reindex completed");
    }
    /**
     * Close the subprocess and clean up resources.
     */
    close() {
        if (this.subprocess) {
            try {
                // Send shutdown RPC (fire-and-forget)
                const id = randomUUID();
                const line = JSON.stringify({ id, method: "shutdown", params: {} }) + "\n";
                this.subprocess.stdin?.write(line);
            }
            catch {
                // Subprocess may already be dead
            }
            // Kill the subprocess
            this.subprocess.kill("SIGTERM");
            this.subprocess = null;
            this.rl = null;
        }
        // Reject all pending RPCs
        for (const [id, pending] of this.pendingRpc) {
            clearTimeout(pending.timer);
            pending.reject(new Error("ContextEngine closed"));
        }
        this.pendingRpc.clear();
        this.initialized = false;
        this.noteCache.clear();
    }
    // =========================================================================
    // Subprocess management
    // =========================================================================
    async ensureSubprocess() {
        if (this.subprocess && !this.subprocess.killed)
            return;
        const pythonExe = this.resolvePythonPath();
        const cwd = join(dirname(fileURLToPath(import.meta.url)), "..");
        const proc = spawn(pythonExe, ["-m", "knowledge_graph"], {
            stdio: ["pipe", "pipe", "pipe"],
            cwd,
        });
        this.subprocess = proc;
        // Read stdout line-by-line for JSON-RPC responses
        this.rl = createInterface({ input: proc.stdout });
        this.rl.on("line", (line) => {
            this.handleResponse(line);
        });
        // Log stderr (Python logging)
        const stderrRl = createInterface({ input: proc.stderr });
        stderrRl.on("line", (line) => {
            console.log(`[knowledge_graph] ${line}`);
        });
        // Handle subprocess death
        proc.on("exit", (code, signal) => {
            console.warn(`[context_engine] Python subprocess exited (code=${code}, signal=${signal})`);
            this.subprocess = null;
            this.rl = null;
            this.initialized = false;
            // Reject all pending RPCs
            for (const [id, pending] of this.pendingRpc) {
                clearTimeout(pending.timer);
                pending.reject(new Error(`Python subprocess exited (code=${code})`));
            }
            this.pendingRpc.clear();
        });
        // Give the subprocess a moment to start
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    /**
     * Resolve the Python executable path for the obsidiclaw conda environment.
     * Uses direct path (no conda run — conda run doesn't forward stdin on Windows).
     */
    resolvePythonPath() {
        if (this.pythonPath)
            return this.pythonPath;
        // Check common conda env locations
        const home = process.env["USERPROFILE"] ?? process.env["HOME"] ?? "";
        const condaDirs = [
            process.env["CONDA_PREFIX"] ? dirname(process.env["CONDA_PREFIX"]) : "",
            join(home, "miniconda3", "envs"),
            join(home, "anaconda3", "envs"),
            join(home, ".conda", "envs"),
        ].filter(Boolean);
        for (const base of condaDirs) {
            // Windows
            const winPath = join(base, "obsidiclaw", "python.exe");
            if (existsSync(winPath)) {
                this.pythonPath = winPath;
                return winPath;
            }
            // Unix
            const unixPath = join(base, "obsidiclaw", "bin", "python");
            if (existsSync(unixPath)) {
                this.pythonPath = unixPath;
                return unixPath;
            }
        }
        // Fall back: ask conda for the path
        try {
            const result = execSync('conda run -n obsidiclaw python -c "import sys; print(sys.executable)"', { encoding: "utf-8", timeout: 15_000 }).trim();
            if (result && existsSync(result)) {
                this.pythonPath = result;
                return result;
            }
        }
        catch {
            // conda not available or env not found
        }
        throw new Error("Could not find Python for conda env 'obsidiclaw'. " +
            "Ensure the environment exists: conda env create -f knowledge_graph/environment.yml");
    }
    // =========================================================================
    // JSON-RPC
    // =========================================================================
    async rpc(method, params) {
        await this.ensureSubprocess();
        if (!this.subprocess?.stdin?.writable) {
            throw new Error("Python subprocess stdin not writable");
        }
        const id = randomUUID();
        const line = JSON.stringify({ id, method, params }) + "\n";
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRpc.delete(id);
                reject(new Error(`RPC timeout: ${method} (${RPC_TIMEOUT_MS}ms)`));
            }, RPC_TIMEOUT_MS);
            this.pendingRpc.set(id, { resolve, reject, timer });
            this.subprocess.stdin.write(line, (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.pendingRpc.delete(id);
                    reject(new Error(`Failed to write to subprocess: ${err.message}`));
                }
            });
        });
    }
    handleResponse(line) {
        let data;
        try {
            data = JSON.parse(line);
        }
        catch {
            // Not JSON — might be stray Python output. Log and ignore.
            console.warn(`[context_engine] Non-JSON from subprocess: ${line.slice(0, 200)}`);
            return;
        }
        if (!data.id)
            return;
        const pending = this.pendingRpc.get(data.id);
        if (!pending)
            return;
        clearTimeout(pending.timer);
        this.pendingRpc.delete(data.id);
        if (data.error) {
            pending.reject(new Error(`RPC error (${data.error.code}): ${data.error.message}`));
        }
        else {
            pending.resolve(data.result);
        }
    }
    // =========================================================================
    // Helpers
    // =========================================================================
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error("ContextEngine not initialized. Call initialize() first.");
        }
    }
    debug(event) {
        this.onDebug?.(event);
    }
}
function rpcNoteToRetrievedNote(n) {
    return {
        noteId: n.noteId,
        path: n.path,
        content: n.content,
        score: n.score,
        type: n.type,
        toolId: n.toolId ?? undefined,
        tags: n.tags ?? undefined,
        retrievalSource: n.retrievalSource,
        linkedFrom: n.linkedFrom ?? undefined,
        depth: n.depth ?? undefined,
    };
}
// ---------------------------------------------------------------------------
// Subagent system prompt formatting (unchanged from original)
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
// Context formatting (unchanged from original)
// ---------------------------------------------------------------------------
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