/**
 * PruneClusterStorage — manages pruning metadata in SQLite.
 *
 * Lives alongside the graph cache; does NOT touch notes/edges schemas.
 */
import type { Database as DB } from "better-sqlite3";
import type { PruneCluster, PruneMemberStatus } from "../types.js";
export interface ListClustersOptions {
    minSize?: number;
    status?: PruneMemberStatus;
}
export declare class PruneClusterStorage {
    private db;
    constructor(db: DB);
    private initSchema;
    resetClusters(): void;
    storeClusters(clusters: PruneCluster[]): void;
    listClusters(options?: ListClustersOptions): PruneCluster[];
    getCluster(clusterId: string): PruneCluster | null;
    updateMemberStatus(clusterId: string, noteId: string, status: PruneMemberStatus): void;
    private toCluster;
}
//# sourceMappingURL=prune-storage.d.ts.map