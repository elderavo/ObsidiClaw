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

import { mkdirSync, existsSync } from "fs";
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
import type { PersonalityConfig } from "../shared/agents/types.js";
import type {
  ContextEngineConfig,
  ContextPackage,
  RetrievedNote,
  SubagentInput,
  SubagentPackage,
  PruneCluster,
  PruneConfig,
} from "./types.js";

const DEFAULT_OLLAMA_HOST = process.env["OLLAMA_HOST"] ?? "10.0.132.100";
const DEFAULT_EMBED_MODEL = process.env["OLLAMA_EMBED_MODEL"] ?? "nomic-embed-text:v1.5";
const DEFAULT_TOP_K = 5;
const DEFAULT_PERSONALITIES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "agents", "personalities");
const DEFAULT_PRUNE_CONFIG: PruneConfig = {
  similarityThreshold: 0.9,
  maxNeighborsPerNote: 10,
  minClusterSize: 2,
  includeNoteTypes: ["concept"],
  excludeTags: [],
};

export class ContextEngine {
  private vectorIndex: VectorStoreIndex | null = null;
  private graphStore: SqliteGraphStore | null = null;
  private readonly config: Required<Omit<ContextEngineConfig, "review" | "pruneConfig">> & {
    review?: ContextEngineConfig["review"];
    pruneConfig?: ContextEngineConfig["pruneConfig"];
  };
  private readonly reviewer: ContextReviewer | null;
  private readonly pruneConfig: PruneConfig;

  constructor(config: ContextEngineConfig) {
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

    this.pruneConfig = {
      ...DEFAULT_PRUNE_CONFIG,
      ...(config.pruneConfig ?? {}),
    };

    // Initialize context reviewer if enabled
    this.reviewer = config.review?.enabled
      ? new ContextReviewer({
          ...config.review,
          personalitiesDir: this.config.personalitiesDir,
        })
      : null;
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
  async initialize(): Promise<void> {
    if (this.vectorIndex) return;

    mkdirSync(dirname(this.config.dbPath), { recursive: true });

    Settings.embedModel = new OllamaEmbedding({
      model: this.config.embeddingModel,
      config: { host: this.config.ollamaHost },
    });

    this.graphStore = new SqliteGraphStore(this.config.dbPath);

    const vectorDir  = join(dirname(this.config.dbPath), "vector-index");
    const vectorFile = join(vectorDir, "vector_store.json");
    const currentHash = await computeMdDbHash(this.config.mdDbPath);
    const storedHash  = this.graphStore.getState("md_db_hash");

    if (currentHash === storedHash && existsSync(vectorFile)) {
      // ── Fast path: nothing changed ─────────────────────────────────────────
      // Load the persisted vector index from disk. The SQLite graph is already
      // current (it was written on the last slow-path run). No Ollama calls.
      const storageContext = await storageContextFromDefaults({ persistDir: vectorDir });
      this.vectorIndex = await VectorStoreIndex.init({ storageContext });
      return;
    }

    // ── Slow path: md_db changed (or first run) ─────────────────────────────
    // Sync markdown files → SQLite graph, re-embed via Ollama, persist to disk.
    await syncMdDbToGraph(this.config.mdDbPath, this.graphStore);

    const storageContext = await storageContextFromDefaults({ persistDir: vectorDir });
    this.vectorIndex = await buildVectorIndexFromGraph(this.graphStore, storageContext);

    // Record the hash so the next startup can take the fast path.
    this.graphStore.setState("md_db_hash", currentHash);
  }

  /**
   * Build a ContextPackage for the given prompt.
   * Runs hybrid retrieval: vector seeds + graph-expanded neighbors.
   *
   * Throws if initialize() has not been called.
   */
  async build(prompt: string): Promise<ContextPackage> {
    if (!this.vectorIndex || !this.graphStore) {
      throw new Error("ContextEngine not initialized. Call initialize() first.");
    }

    const t0 = Date.now();

    const { seedNotes, expandedNotes } = await hybridRetrieve(
      prompt,
      this.vectorIndex,
      this.graphStore,
      this.config.topK,
    );

    let allNotes = [...seedNotes, ...expandedNotes].sort((a, b) => b.score - a.score);

    // ── Optional context review gate ──────────────────────────────────────
    let reviewResult: ContextPackage["reviewResult"] | undefined;

    if (this.reviewer) {
      const review = await this.reviewer.review(prompt, allNotes);
      reviewResult = {
        filteredCount: review.filteredNoteIds.length,
        reviewMs: review.reviewMs,
        skipped: review.skipped,
        skipReason: review.skipReason,
      };

      if (!review.skipped && review.filteredNoteIds.length > 0) {
        const filtered = new Set(review.filteredNoteIds);
        allNotes = allNotes.filter((n) => !filtered.has(n.noteId));
      }
    }

    // ── Format and return ─────────────────────────────────────────────────
    const suggestedTools = allNotes
      .filter((n) => n.type === "tool" && n.toolId !== undefined)
      .map((n) => n.toolId!);

    const rawChars = allNotes.reduce((sum, n) => sum + n.content.length, 0);

    // Re-split into seeds and expanded for formatting (post-filter)
    const filteredSeeds = allNotes.filter((n) => n.depth === 0 || n.retrievalSource === "vector");
    const filteredExpanded = allNotes.filter((n) => (n.depth ?? 0) > 0 && n.retrievalSource !== "vector");
    const formattedContext = formatContext(filteredSeeds, filteredExpanded);
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
  async buildSubagentPackage(input: SubagentInput): Promise<SubagentPackage> {
    if (!this.vectorIndex || !this.graphStore) {
      throw new Error("ContextEngine not initialized. Call initialize() first.");
    }

    // Combine plan + prompt for retrieval; plan carries the most signal
    const query = [input.plan, input.prompt].filter(Boolean).join(" ").slice(0, 1000);
    const contextPackage = await this.build(query);

    // Resolve personality if specified
    let personalityConfig: PersonalityConfig | undefined;
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
  async buildPruneClusters(configOverride?: Partial<PruneConfig>): Promise<PruneCluster[]> {
    if (!this.vectorIndex || !this.graphStore) {
      throw new Error("ContextEngine not initialized. Call initialize() first.");
    }

    const effectiveConfig: PruneConfig = {
      ...this.pruneConfig,
      ...(configOverride ?? {}),
    };

    const clusters = await buildPruneClustersOp(
      effectiveConfig,
      this.vectorIndex,
      this.graphStore,
    );

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
  getNoteContent(relativePath: string): string | null {
    return this.graphStore?.getNoteByPath(relativePath)?.body ?? null;
  }

  /**
   * Get access to the underlying SQLite graph store.
   * Returns null if the engine is not initialized.
   * 
   * This allows extensions to add additional content to the same graph.
   */
  getGraphStore(): SqliteGraphStore | null {
    return this.graphStore;
  }

  /**
   * Get access to the vector index for rebuilding after adding new documents.
   * Returns null if the engine is not initialized.
   */
  getVectorIndex(): VectorStoreIndex | null {
    return this.vectorIndex;
  }

  /**
   * Rebuild the vector index from current graph content.
   * Call this after adding new documents to the graph store.
   */
  async rebuildVectorIndex(): Promise<void> {
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
  async reindex(): Promise<void> {
    if (!this.graphStore) {
      throw new Error("ContextEngine not initialized. Call initialize() first.");
    }

    try {
      await syncMdDbToGraph(this.config.mdDbPath, this.graphStore);

      const vectorDir = join(dirname(this.config.dbPath), "vector-index");
      const storageContext = await storageContextFromDefaults({ persistDir: vectorDir });
      this.vectorIndex = await buildVectorIndexFromGraph(this.graphStore, storageContext);

      // Update hash so next startup fast-paths correctly
      const newHash = await computeMdDbHash(this.config.mdDbPath);
      this.graphStore.setState("md_db_hash", newHash);

      console.log("[context_engine] Full reindex completed");

    } catch (error) {
      console.error("[context_engine] Full reindex failed:", error);
      throw error;
    }
  }

  /**
   * Rebuild just the link graph after md_db changes.
   * More efficient than full reindex if only link relationships changed.
   */
  async rebuildLinkGraph(): Promise<void> {
    if (!this.graphStore) {
      throw new Error("ContextEngine not initialized. Call initialize() first.");
    }

    const { LinkGraphProcessor } = await import("./link_graph/index.js");
    
    try {
      const linkProcessor = new LinkGraphProcessor(
        this.graphStore.getDatabase(), 
        this.config.mdDbPath
      );
      
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
      
    } catch (error) {
      console.error('[context_engine] Link graph rebuild failed:', error);
      throw error;
    }
  }

  /**
   * Close the underlying SQLite database.
   * Call when the context engine is no longer needed.
   */
  close(): void {
    this.graphStore?.close();
    this.graphStore = null;
    this.vectorIndex = null;
  }
}

// ---------------------------------------------------------------------------
// Subagent system prompt formatting
// ---------------------------------------------------------------------------

function formatSubagentSystemPrompt(
  input: SubagentInput,
  ctx: ContextPackage,
  personalityContent?: string,
): string {
  const sections: string[] = ["# Subagent Task"];

  if (personalityContent) {
    sections.push("", "## Personality", personalityContent);
  }

  sections.push(
    "",
    "## Your Task",
    input.prompt,
    "",
    "## Implementation Plan",
    input.plan,
    "",
    "## Success Criteria",
    input.successCriteria,
    "",
    "## Retrieved Context",
    ctx.formattedContext,
    "",
    "---",
    "Focus exclusively on the plan above. Work systematically towards the success criteria.",
    "Use `retrieve_context` for additional knowledge lookup.",
  );

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
function formatContext(seedNotes: RetrievedNote[], expandedNotes: RetrievedNote[]): string {
  const allNotes = [...seedNotes, ...expandedNotes];

  if (allNotes.length === 0) {
    return "<!-- ObsidiClaw: no relevant knowledge base context found for this query -->";
  }

  const lines: string[] = [
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
      const linkedFromPart =
        note.linkedFrom && note.linkedFrom.length > 0
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
    lines.push(
      "_Tool nodes from the knowledge base. Tool outputs will be injected in Phase 6._",
    );
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
