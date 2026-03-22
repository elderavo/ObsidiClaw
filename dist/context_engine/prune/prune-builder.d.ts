/**
 * Prune cluster builder — computes vector-similarity clusters from the existing
 * vector index and graph store. Does NOT mutate the vector store or graph.
 */
import type { VectorStoreIndex } from "llamaindex";
import type { SqliteGraphStore } from "../store/graph-store.js";
import type { PruneCluster, PruneConfig } from "../types.js";
export declare function buildPruneClusters(config: PruneConfig, vectorIndex: VectorStoreIndex, graphStore: SqliteGraphStore): Promise<PruneCluster[]>;
//# sourceMappingURL=prune-builder.d.ts.map