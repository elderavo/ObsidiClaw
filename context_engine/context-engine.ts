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
import { spawn, execSync, type ChildProcess } from "child_process";
import { createInterface, type Interface as ReadlineInterface } from "readline";
import { existsSync } from "fs";
import { ensureDir } from "../shared/os/fs.js";
import { stripFrontmatter, estimateTokens } from "./frontmatter-utils.js";
import { loadPersonality } from "../shared/agents/personality-loader.js";
import { ContextReviewer } from "./review/context-reviewer.js";
import { PruneClusterStorage } from "./prune/prune-storage.js";
import Database from "better-sqlite3";
import type { PersonalityConfig } from "../shared/agents/types.js";
import type {
  ContextEngineConfig,
  ContextEngineEvent,
  ContextPackage,
  RetrievedNote,
  SubagentInput,
  SubagentPackage,
  PruneCluster,
  PruneConfig,
} from "./types.js";

const DEFAULT_OLLAMA_HOST = process.env["OLLAMA_HOST"] ?? "http://10.0.132.100:11434";
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

const RPC_TIMEOUT_MS = 120_000; // 2 minutes for long operations (indexing)

// ---------------------------------------------------------------------------
// RPC types
// ---------------------------------------------------------------------------

interface RpcPending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// ContextEngine — subprocess bridge
// ---------------------------------------------------------------------------

export class ContextEngine {
  private subprocess: ChildProcess | null = null;
  private rl: ReadlineInterface | null = null;
  private subprocessExitPromise: Promise<void> | null = null;
  private resolveSubprocessExit: (() => void) | null = null;
  private readonly pendingRpc = new Map<string, RpcPending>();
  private initialized = false;
  private pythonPath: string | null = null;
  private startupError: Error | null = null;
  private recentSubprocessStderr: string[] = [];

  /** In-memory note cache populated on init/reindex. */
  private noteCache = new Map<string, string>();

  private readonly config: Required<Omit<ContextEngineConfig, "review" | "pruneConfig" | "onDebug">> & {
    review?: ContextEngineConfig["review"];
    pruneConfig?: ContextEngineConfig["pruneConfig"];
  };
  private readonly onDebug: ((event: ContextEngineEvent) => void) | undefined;
  private readonly reviewer: ContextReviewer | null;
  private readonly pruneConfig: PruneConfig;

  constructor(config: ContextEngineConfig) {
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
  async initialize(): Promise<void> {
    if (this.initialized) return;

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
    }) as { path: string; duration_ms: number; note_count: number; note_cache: Record<string, string> };

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
  async build(prompt: string): Promise<ContextPackage> {
    this.ensureInitialized();

    const t0 = Date.now();

    this.debug({ type: "ce_retrieval_start", timestamp: t0, query: prompt.slice(0, 200), topK: this.config.topK });

    const tVector = Date.now();
    const rpcResult = await this.rpc("retrieve", {
      query: prompt,
      top_k: this.config.topK,
    }) as { seed_notes: RpcRetrievedNote[]; expanded_notes: RpcRetrievedNote[] };

    const seedNotes = rpcResult.seed_notes.map(rpcNoteToRetrievedNote);
    const expandedNotes = rpcResult.expanded_notes.map(rpcNoteToRetrievedNote);

    this.debug({ type: "ce_vector_done", timestamp: Date.now(), seedCount: seedNotes.length, durationMs: Date.now() - tVector });

    const tGraph = Date.now();
    const allNotes = [...seedNotes, ...expandedNotes].sort((a, b) => b.score - a.score);

    this.debug({ type: "ce_graph_done", timestamp: Date.now(), expandedCount: expandedNotes.length, durationMs: Date.now() - tGraph });

    // ── Format raw context ──────────────────────────────────────────────
    const suggestedTools = allNotes
      .filter((n) => n.type === "tool" && n.toolId !== undefined)
      .map((n) => n.toolId!);

    const rawChars = allNotes.reduce((sum, n) => sum + n.content.length, 0);

    const filteredSeeds = allNotes.filter((n) => n.depth === 0 || n.retrievalSource === "vector");
    const filteredExpanded = allNotes.filter((n) => (n.depth ?? 0) > 0 && n.retrievalSource !== "vector");
    const rawFormattedContext = formatContext(filteredSeeds, filteredExpanded);

    // ── Optional context review / synthesis ───────────────────────────────
    let formattedContext = rawFormattedContext;
    let reviewResult: ContextPackage["reviewResult"] | undefined;

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
  async buildSubagentPackage(input: SubagentInput): Promise<SubagentPackage> {
    this.ensureInitialized();

    const query = [input.plan, input.prompt].filter(Boolean).join(" ").slice(0, 1000);
    const contextPackage = await this.build(query);

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
   * Build pruning clusters via Python RPC, store in local prune.db.
   */
  async buildPruneClusters(configOverride?: Partial<PruneConfig>): Promise<PruneCluster[]> {
    this.ensureInitialized();

    const effectiveConfig: PruneConfig = {
      ...this.pruneConfig,
      ...(configOverride ?? {}),
    };

    const result = await this.rpc("build_prune_clusters", {
      similarity_threshold: effectiveConfig.similarityThreshold,
      max_neighbors: effectiveConfig.maxNeighborsPerNote,
      min_cluster_size: effectiveConfig.minClusterSize,
      include_types: effectiveConfig.includeNoteTypes,
      exclude_tags: effectiveConfig.excludeTags ?? [],
    }) as { clusters: PruneCluster[] };

    // Store clusters in local prune.db
    const pruneDbPath = join(dirname(this.config.dbPath), "prune.db");
    const db = new Database(pruneDbPath);
    try {
      const storage = new PruneClusterStorage(db);
      storage.resetClusters();
      storage.storeClusters(result.clusters);
    } finally {
      db.close();
    }

    return result.clusters;
  }

  /**
   * Return the stripped body of a specific note by relative path.
   * Reads from in-memory cache — no RPC needed.
   */
  getNoteContent(relativePath: string): string | null {
    return this.noteCache.get(relativePath) ?? null;
  }

  /**
   * Get graph statistics via Python RPC.
   */
  async getGraphStats(): Promise<{ noteCount: number; edgeCount: number; indexLoaded: boolean }> {
    if (!this.initialized) {
      return { noteCount: 0, edgeCount: 0, indexLoaded: false };
    }
    const result = await this.rpc("get_graph_stats", {}) as {
      note_count: number;
      edge_count: number;
      index_loaded: boolean;
    };
    return {
      noteCount: result.note_count,
      edgeCount: result.edge_count,
      indexLoaded: result.index_loaded,
    };
  }

  /**
   * Complete reindex via Python RPC. Updates local note cache.
   */
  async reindex(): Promise<void> {
    this.ensureInitialized();

    const t0 = Date.now();

    const result = await this.rpc("reindex", {}) as {
      skipped: boolean;
      duration_ms: number;
      note_count: number;
      note_cache: Record<string, string>;
    };

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
    this.debug({ type: "ce_subprocess_log", timestamp: Date.now(), message: "Full reindex completed" });
  }

  /**
   * Close the subprocess and clean up resources.
   */
  async close(): Promise<void> {
    const waitForExit = this.waitForSubprocessExit();

    if (this.subprocess) {
      try {
        // Send shutdown RPC (fire-and-forget)
        const id = randomUUID();
        const line = JSON.stringify({ id, method: "shutdown", params: {} }) + "\n";
        this.subprocess.stdin?.write(line);
      } catch {
        // Subprocess may already be dead
      }

      try {
        this.subprocess.kill("SIGTERM");
      } catch {
        // Already dead
      }
    }

    await waitForExit;

    // Reject all pending RPCs (if any remain)
    for (const [id, pending] of this.pendingRpc) {
      clearTimeout(pending.timer);
      pending.reject(new Error("ContextEngine closed"));
    }
    this.pendingRpc.clear();

    this.subprocess = null;
    this.rl = null;
    this.initialized = false;
    this.noteCache.clear();
  }

  // =========================================================================
  // Subprocess management
  // =========================================================================

  private async ensureSubprocess(): Promise<void> {
    if (this.subprocess && !this.subprocess.killed) return;

    const pythonExe = this.resolvePythonPath();
    // Run from repo root so `python -m knowledge_graph` can import the package
    // (the compiled JS lives in dist/, knowledge_graph/ lives at repo root).
    const cwd = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    this.debug({ type: "ce_subprocess_log", timestamp: Date.now(), message: `Spawning python in cwd=${cwd}` });

    const proc = spawn(pythonExe, ["-m", "knowledge_graph"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
    });

    this.subprocessExitPromise = new Promise<void>((resolve) => {
      this.resolveSubprocessExit = resolve;
    });

    this.subprocess = proc;

    // Read stdout line-by-line for JSON-RPC responses
    this.rl = createInterface({ input: proc.stdout! });
    this.rl.on("line", (line: string) => {
      this.handleResponse(line);
    });

    // Relay stderr (Python logging) through debug callback only
    const stderrRl = createInterface({ input: proc.stderr! });
    stderrRl.on("line", (line: string) => {
      this.debug({ type: "ce_subprocess_log", timestamp: Date.now(), message: line });
    });

    // Handle subprocess death
    proc.on("exit", (code, signal) => {
      this.debug({ type: "ce_subprocess_log", timestamp: Date.now(), message: `Python subprocess exited (code=${code}, signal=${signal})` });
      this.subprocess = null;
      this.rl = null;
      this.initialized = false;

      // Reject all pending RPCs
      for (const [id, pending] of this.pendingRpc) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Python subprocess exited (code=${code})`));
      }
      this.pendingRpc.clear();

      this.resolveSubprocessExit?.();
      this.resolveSubprocessExit = null;
      this.subprocessExitPromise = null;
    });

    // Give the subprocess a moment to start
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }

  private async waitForSubprocessExit(timeoutMs = 2000): Promise<void> {
    const exitPromise = this.subprocessExitPromise;
    if (!exitPromise) return;

    await Promise.race([
      exitPromise.catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  /**
   * Resolve the Python executable path for the obsidiclaw conda environment.
   * Uses direct path (no conda run — conda run doesn't forward stdin on Windows).
   */
  private resolvePythonPath(): string {
    if (this.pythonPath) return this.pythonPath;

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
      const result = execSync(
        'conda run -n obsidiclaw python -c "import sys; print(sys.executable)"',
        { encoding: "utf-8", timeout: 15_000 },
      ).trim();
      if (result && existsSync(result)) {
        this.pythonPath = result;
        return result;
      }
    } catch {
      // conda not available or env not found
    }

    throw new Error(
      "Could not find Python for conda env 'obsidiclaw'. " +
      "Ensure the environment exists: conda env create -f knowledge_graph/environment.yml"
    );
  }

  // =========================================================================
  // JSON-RPC
  // =========================================================================

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.ensureSubprocess();

    if (!this.subprocess?.stdin?.writable) {
      throw new Error("Python subprocess stdin not writable");
    }

    const id = randomUUID();
    const line = JSON.stringify({ id, method, params }) + "\n";

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`RPC timeout: ${method} (${RPC_TIMEOUT_MS}ms)`));
      }, RPC_TIMEOUT_MS);

      this.pendingRpc.set(id, { resolve, reject, timer });

      this.subprocess!.stdin!.write(line, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRpc.delete(id);
          reject(new Error(`Failed to write to subprocess: ${err.message}`));
        }
      });
    });
  }

  private handleResponse(line: string): void {
    let data: { id?: string; result?: unknown; error?: { code: number; message: string } };
    try {
      data = JSON.parse(line);
    } catch {
      // Not JSON — might be stray Python output. Log and ignore.
      this.debug({ type: "ce_subprocess_log", timestamp: Date.now(), message: `Non-JSON from subprocess: ${line.slice(0, 200)}` });
      return;
    }

    if (!data.id) return;

    const pending = this.pendingRpc.get(data.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRpc.delete(data.id);

    if (data.error) {
      pending.reject(new Error(`RPC error (${data.error.code}): ${data.error.message}`));
    } else {
      pending.resolve(data.result);
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("ContextEngine not initialized. Call initialize() first.");
    }
  }

  private debug(event: ContextEngineEvent): void {
    this.onDebug?.(event);
  }
}

// ---------------------------------------------------------------------------
// RPC note type (matches Python server output)
// ---------------------------------------------------------------------------

interface RpcRetrievedNote {
  noteId: string;
  path: string;
  content: string;
  score: number;
  type: string;
  toolId?: string | null;
  tags?: string[] | null;
  retrievalSource: string;
  linkedFrom?: string[] | null;
  depth?: number | null;
}

function rpcNoteToRetrievedNote(n: RpcRetrievedNote): RetrievedNote {
  return {
    noteId: n.noteId,
    path: n.path,
    content: n.content,
    score: n.score,
    type: n.type as RetrievedNote["type"],
    toolId: n.toolId ?? undefined,
    tags: n.tags ?? undefined,
    retrievalSource: n.retrievalSource as RetrievedNote["retrievalSource"],
    linkedFrom: n.linkedFrom ?? undefined,
    depth: n.depth ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Subagent system prompt formatting (unchanged from original)
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
// Context formatting (unchanged from original)
// ---------------------------------------------------------------------------

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
      "_Tool nodes from the knowledge base._",
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
