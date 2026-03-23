/**
 * Context engine public types.
 */

// ---------------------------------------------------------------------------
// Note types
// ---------------------------------------------------------------------------

export type NoteType = "tool" | "concept" | "index" | "codebase" | "codeUnit";

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

  /** Normalized tags from frontmatter (if available). */
  tags?: string[];

  /** How this note entered the result set. */
  retrievalSource: "vector" | "graph" | "hybrid" | "keyword";

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

  /** Tool IDs from retrieved tool nodes. */
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

  /** Review/synthesis result, if context review was performed. */
  reviewResult?: {
    reviewMs: number;
    skipped: boolean;
    skipReason?: string;
  };
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

  /** Optional personality name (loads from shared/agents/personalities/). */
  personality?: string;
}

export interface SubagentPackage {
  /** Original input from the main agent. */
  input: SubagentInput;

  /** RAG result retrieved against the plan. */
  contextPackage: ContextPackage;

  /**
   * Ready-to-inject system prompt for the subagent session.
   * Combines: personality + task + plan + retrieved context + success criteria.
   */
  formattedSystemPrompt: string;

  /** Resolved personality config (if a personality was specified). */
  personalityConfig?: import("../shared/agents/types.js").PersonalityConfig;

  /** Unix timestamp (ms) when the package was built. */
  builtAt: number;
}

// ---------------------------------------------------------------------------
// Pruning types
// ---------------------------------------------------------------------------

export type PruneMemberStatus = "pending" | "keep" | "merge" | "ignore";

export interface PruneClusterMember {
  noteId: string;
  similarity: number;
  isRepresentative: boolean;
  status: PruneMemberStatus;
}

export interface PruneClusterStats {
  size: number;
  maxSimilarity: number;
  minSimilarity: number;
  avgSimilarity: number;
}

export interface PruneCluster {
  clusterId: string;
  representativeNoteId: string;
  members: PruneClusterMember[];
  stats: PruneClusterStats;
}

export interface PruneConfig {
  similarityThreshold: number;
  maxNeighborsPerNote: number;
  minClusterSize: number;
  includeNoteTypes: NoteType[];
  excludeTags?: string[];
}

// ---------------------------------------------------------------------------
// ContextEngineConfig
// ---------------------------------------------------------------------------

export interface ContextEngineConfig {
  /**
   * Absolute path to the md_db directory.
   */
  mdDbPath: string;

  /**
   * Absolute path to the SQLite graph database.
   * Defaults to: path.join(path.dirname(mdDbPath), '.obsidi-claw', 'graph.db')
   * The .obsidi-claw/ directory is created automatically on initialize().
   */
  dbPath?: string;

  /**
   * Number of vector seed notes to retrieve per query.
   * Default: 5
   */
  topK?: number;

  /**
   * Path to the subagent personalities directory.
   * Default: shared/agents/personalities/ (relative to context_engine)
   */
  personalitiesDir?: string;

  /**
   * Context review configuration. Always-on by default.
   * Set `enabled: false` to explicitly disable.
   * Falls back to raw context on LLM/network errors.
   */
  review?: {
    enabled?: boolean;
    personality?: string;
    maxLatencyMs?: number;
  };

  /**
   * Optional pruning configuration. Overrides defaults used by buildPruneClusters().
   */
  pruneConfig?: Partial<PruneConfig>;

  /**
   * Debug event callback. Called at each internal state transition
   * (init, retrieval steps, review, reindex). Wire this to the orchestrator's
   * event logger for full context engine visibility.
   */
  onDebug?: (event: ContextEngineEvent) => void;
}

// ---------------------------------------------------------------------------
// Debug events — emitted via onDebug callback
// ---------------------------------------------------------------------------

export interface ContextEngineEvent {
  type: string;
  timestamp: number;
  [key: string]: unknown;
}
