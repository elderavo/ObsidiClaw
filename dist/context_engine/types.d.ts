/**
 * Context engine public types.
 *
 * TODO: Phase 1 — migrate to shared/types.ts once stable.
 */
export type NoteType = "tool" | "concept" | "index";
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
}
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
//# sourceMappingURL=types.d.ts.map