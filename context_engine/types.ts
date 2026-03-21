/**
 * Context engine public types.
 *
 * TODO: Phase 1 — migrate to shared/types.ts once stable.
 */

// ---------------------------------------------------------------------------
// Note types
// ---------------------------------------------------------------------------

export type NoteType = "tool" | "concept" | "index" | "codebase";

// ---------------------------------------------------------------------------
// RetrievedNote — a note that has entered the result set
// ---------------------------------------------------------------------------

export interface RetrievedNote {
  /** Graph identity key (== relative path). */
  noteId: string;

  /** Relative path within md_db (e.g. "tools/network.md"). */
  path: string;

  /** Raw markdown body text. */
  content: string;

  /** Retrieval score (0–1). Seed notes: vector similarity. Graph notes: derived score. */
  score: number;

  type: NoteType;

  /** Stem of path for tool notes (e.g. "network"). */
  toolId?: string;

  /** How this note entered the result set. */
  retrievalSource: "vector" | "graph" | "hybrid";

  /**
   * NoteIds of notes that linked to this one.
   * Only set for graph-retrieved notes.
   */
  linkedFrom?: string[];

  /**
   * Graph traversal depth.
   * 0 = direct vector match (seed).
   * 1 = one hop from a seed, etc.
   */
  depth?: number;
}

// ---------------------------------------------------------------------------
// ContextPackage — what context_engine returns to the orchestrator
// ---------------------------------------------------------------------------

export interface ContextPackage {
  /** Original prompt used for retrieval. */
  query: string;

  /** All retrieved notes, sorted by score descending. */
  retrievedNotes: RetrievedNote[];

  /**
   * Tool IDs from retrieved tool nodes.
   * TODO: Phase 6 — orchestrator runs these tools; outputs appended to context.
   */
  suggestedTools: string[];

  /** Formatted markdown ready for injection into the pi session via agentsFilesOverride. */
  formattedContext: string;

  /** Wall-clock time for the full retrieval in ms. */
  retrievalMs: number;

  /** Unix timestamp (ms) when the package was built. */
  builtAt: number;

  /** NoteIds of vector seed notes (depth 0). */
  seedNoteIds?: string[];

  /** NoteIds of graph-expanded notes (depth >= 1). */
  expandedNoteIds?: string[];

  /** Total raw character count across all retrieved note bodies (before stripping). */
  rawChars: number;

  /** Character count of formattedContext (after frontmatter stripping). */
  strippedChars: number;

  /** Rough token estimate of formattedContext (chars ÷ 4). */
  estimatedTokens: number;
}

// ---------------------------------------------------------------------------
// SubagentInput / SubagentPackage — input and output of buildSubagentPackage()
// ---------------------------------------------------------------------------

export interface SubagentInput {
  /** Top-level task description passed to the subagent. */
  prompt: string;

  /** Detailed implementation plan produced by the main agent. */
  plan: string;

  /** Unambiguous, measurable criteria for task completion. */
  successCriteria: string;
}

export interface SubagentPackage {
  /** Original input from the main agent. */
  input: SubagentInput;

  /** RAG result retrieved against the plan. */
  contextPackage: ContextPackage;

  /**
   * Ready-to-inject system prompt for the subagent session.
   * Combines: task + plan + retrieved context + success criteria.
   */
  formattedSystemPrompt: string;

  /** Unix timestamp (ms) when the package was built. */
  builtAt: number;
}

// ---------------------------------------------------------------------------
// ContextEngineConfig
// ---------------------------------------------------------------------------

export interface ContextEngineConfig {
  /**
   * Absolute path to the md_db directory.
   * TODO: Phase 1 — pull from shared/config.ts
   */
  mdDbPath: string;

  /**
   * Absolute path to the SQLite graph database.
   * Defaults to: path.join(path.dirname(mdDbPath), '.obsidi-claw', 'graph.db')
   * The .obsidi-claw/ directory is created automatically on initialize().
   */
  dbPath?: string;

  /**
   * Ollama host (no path, no trailing slash).
   * Default: "10.0.132.100"
   */
  ollamaHost?: string;

  /**
   * Ollama embedding model.
   * Must be a text-embedding model (e.g. "nomic-embed-text:v1.5").
   * Override with OLLAMA_EMBED_MODEL env var.
   */
  embeddingModel?: string;

  /**
   * Number of vector seed notes to retrieve per query.
   * Default: 5
   */
  topK?: number;
}
