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
import type { VectorStoreIndex } from "llamaindex";
import type { SqliteGraphStore } from "../store/graph-store.js";
import type { RetrievedNote } from "../types.js";
export interface HybridResult {
    seedNotes: RetrievedNote[];
    expandedNotes: RetrievedNote[];
}
/**
 * Run hybrid retrieval for a query string.
 *
 * @param query       The user prompt / retrieval query.
 * @param vectorIndex LlamaIndex VectorStoreIndex (owns embeddings).
 * @param graphStore  SqliteGraphStore (owns wikilink graph).
 * @param topK        Number of vector seed notes to retrieve.
 */
export declare function hybridRetrieve(query: string, vectorIndex: VectorStoreIndex, graphStore: SqliteGraphStore, topK: number): Promise<HybridResult>;
//# sourceMappingURL=hybrid-retrieval.d.ts.map