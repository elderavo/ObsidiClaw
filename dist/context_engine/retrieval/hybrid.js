/**
 * Hybrid retrieval — combines LlamaIndex vector seeds with SQLite graph expansion.
 *
 * Pipeline:
 *   1. Vector retrieval: top-K notes by embedding similarity (LlamaIndex)
 *   2. Graph expansion: BFS depth-1 neighbors of seed notes (SqliteGraphStore)
 *   3. Neighbor scores: parentSeedScore × GRAPH_SCORE_DECAY
 *
 * Seed notes always take precedence; duplicate noteIds are not returned twice.
 */
import { MetadataMode } from "llamaindex";
const GRAPH_SCORE_DECAY = 0.7;
/**
 * Run hybrid retrieval for a query string.
 *
 * @param query       The user prompt / retrieval query.
 * @param vectorIndex LlamaIndex VectorStoreIndex (owns embeddings).
 * @param graphStore  SqliteGraphStore (owns wikilink graph).
 * @param topK        Number of vector seed notes to retrieve.
 */
export async function hybridRetrieve(query, vectorIndex, graphStore, topK) {
    // ── Step 1: vector seeds ─────────────────────────────────────────────────
    const retriever = vectorIndex.asRetriever({ similarityTopK: topK });
    const rawResults = await retriever.retrieve(query);
    const seedNotes = [];
    const seedScoreByNoteId = new Map();
    for (const r of rawResults) {
        const path = String(r.node.metadata["file_path"] ?? "");
        if (!path)
            continue;
        const score = r.score ?? 0;
        const stored = graphStore.getNoteByPath(path);
        seedNotes.push({
            noteId: path,
            path,
            content: r.node.getContent(MetadataMode.NONE),
            score,
            type: (stored?.note_type ?? inferNoteType(path)),
            toolId: stored?.tool_id ?? undefined,
            retrievalSource: "vector",
            depth: 0,
        });
        seedScoreByNoteId.set(path, score);
    }
    // ── Step 2: graph expansion ───────────────────────────────────────────────
    const seedIds = seedNotes.map((n) => n.noteId);
    const neighbors = graphStore.getNeighbors(seedIds, 1);
    if (neighbors.length === 0) {
        return { seedNotes, expandedNotes: [] };
    }
    const storedNeighbors = graphStore.getNotesByIds(neighbors.map((n) => n.noteId));
    const storedByNoteId = new Map(storedNeighbors.map((s) => [s.note_id, s]));
    const expandedNotes = [];
    for (const neighbor of neighbors) {
        const stored = storedByNoteId.get(neighbor.noteId);
        if (!stored)
            continue;
        const parentScore = seedScoreByNoteId.get(neighbor.linkedFrom) ?? 0;
        const score = parentScore * GRAPH_SCORE_DECAY;
        expandedNotes.push({
            noteId: neighbor.noteId,
            path: stored.path,
            content: stored.body,
            score,
            type: stored.note_type,
            toolId: stored.tool_id ?? undefined,
            retrievalSource: "graph",
            depth: neighbor.depth,
            linkedFrom: [neighbor.linkedFrom],
        });
    }
    return { seedNotes, expandedNotes };
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
//# sourceMappingURL=hybrid.js.map