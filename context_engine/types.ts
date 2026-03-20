/**
 * Context engine type definitions.
 *
 * TODO: Phase 1 — migrate to shared/types.ts once interfaces stabilize.
 */

// ---------------------------------------------------------------------------
// Retrieved node from the knowledge graph
// ---------------------------------------------------------------------------

export type NoteType = "tool" | "concept" | "index";

export interface RetrievedNote {
  /** Relative path within md_db (e.g. "tools/network.md") */
  path: string;

  /** Raw markdown content */
  content: string;

  /** Similarity score from vector retrieval (0–1) */
  score: number;

  /** Inferred from path: tools/ → "tool", concepts/ → "concept", else "index" */
  type: NoteType;

  /**
   * Tool ID for tool nodes (filename without extension).
   * e.g. "tools/network.md" → "network"
   * undefined for concept/index nodes.
   */
  toolId?: string;
}

// ---------------------------------------------------------------------------
// Context package — what context_engine returns to the orchestrator
// ---------------------------------------------------------------------------

export interface ContextPackage {
  /** Original prompt used for retrieval */
  query: string;

  /** Retrieved notes, sorted by score descending */
  retrievedNotes: RetrievedNote[];

  /**
   * Tool IDs detected in retrieved tool nodes.
   * These are candidates for tool execution before the agent run.
   * TODO: Phase 6 — orchestrator runs these tools and injects their outputs.
   */
  suggestedTools: string[];

  /**
   * Formatted context string ready for injection into the pi session.
   * This becomes part of the system prompt (via agentsFilesOverride).
   */
  formattedContext: string;

  /** Retrieval wall-clock time in ms */
  retrievalMs: number;

  /** Unix timestamp (ms) when the package was built */
  builtAt: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ContextEngineConfig {
  /**
   * Absolute path to the md_db directory.
   * TODO: Phase 1 — pull from shared/config.ts
   */
  mdDbPath: string;

  /**
   * Ollama host (no path, no trailing slash).
   * Used for OllamaEmbedding.
   * Default: "10.0.132.100"
   * TODO: Phase 1 — pull from shared/config.ts OllamaConfig
   */
  ollamaHost?: string;

  /**
   * Embedding model loaded in Ollama.
   * Must be a text-embedding model (e.g. "nomic-embed-text", "mxbai-embed-large").
   * Override with OLLAMA_EMBED_MODEL env var.
   * Default: "nomic-embed-text"
   */
  embeddingModel?: string;

  /**
   * Number of notes to retrieve per query.
   * Default: 5
   */
  topK?: number;
}
