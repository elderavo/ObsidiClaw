/**
 * PruneClusterStorage — manages pruning metadata in SQLite.
 *
 * Lives alongside the graph cache; does NOT touch notes/edges schemas.
 */

import type { Database as DB } from "better-sqlite3";
import type {
  PruneCluster,
  PruneClusterMember,
  PruneMemberStatus,
} from "../types.js";

interface ClusterRow {
  cluster_id: string;
  representative_note_id: string;
  size: number;
  max_similarity: number;
  min_similarity: number;
  avg_similarity: number;
  created_at: string;
}

interface MemberRow {
  cluster_id: string;
  note_id: string;
  similarity: number;
  is_representative: number; // sqlite boolean
  status: string;
}

export interface ListClustersOptions {
  minSize?: number;
  status?: PruneMemberStatus;
}

export class PruneClusterStorage {
  constructor(private db: DB) {
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prune_clusters (
        cluster_id             TEXT PRIMARY KEY,
        representative_note_id TEXT NOT NULL,
        size                   INTEGER NOT NULL,
        max_similarity         REAL NOT NULL,
        min_similarity         REAL NOT NULL,
        avg_similarity         REAL NOT NULL,
        created_at             DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS prune_cluster_members (
        cluster_id       TEXT NOT NULL,
        note_id          TEXT NOT NULL,
        similarity       REAL NOT NULL,
        is_representative BOOLEAN NOT NULL DEFAULT FALSE,
        status           TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY (cluster_id, note_id)
      );

      CREATE INDEX IF NOT EXISTS idx_prune_members_cluster ON prune_cluster_members(cluster_id);
      CREATE INDEX IF NOT EXISTS idx_prune_members_status ON prune_cluster_members(status);
    `);
  }

  resetClusters(): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM prune_cluster_members").run();
      this.db.prepare("DELETE FROM prune_clusters").run();
    });
    tx();
  }

  storeClusters(clusters: PruneCluster[]): void {
    const insertCluster = this.db.prepare(
      `INSERT OR REPLACE INTO prune_clusters
       (cluster_id, representative_note_id, size, max_similarity, min_similarity, avg_similarity)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    const insertMember = this.db.prepare(
      `INSERT OR REPLACE INTO prune_cluster_members
       (cluster_id, note_id, similarity, is_representative, status)
       VALUES (?, ?, ?, ?, ?)`
    );

    const tx = this.db.transaction(() => {
      for (const cluster of clusters) {
        insertCluster.run(
          cluster.clusterId,
          cluster.representativeNoteId,
          cluster.stats.size,
          cluster.stats.maxSimilarity,
          cluster.stats.minSimilarity,
          cluster.stats.avgSimilarity,
        );

        for (const member of cluster.members) {
          insertMember.run(
            cluster.clusterId,
            member.noteId,
            member.similarity,
            member.isRepresentative ? 1 : 0,
            member.status,
          );
        }
      }
    });

    tx();
  }

  listClusters(options?: ListClustersOptions): PruneCluster[] {
    const minSize = options?.minSize ?? 1;
    const statusFilter = options?.status;

    const clusterRows = this.db
      .prepare("SELECT * FROM prune_clusters WHERE size >= ? ORDER BY size DESC, cluster_id")
      .all(minSize) as ClusterRow[];

    if (clusterRows.length === 0) return [];

    const memberRows = statusFilter
      ? (this.db
          .prepare(
            "SELECT * FROM prune_cluster_members WHERE status = ? ORDER BY cluster_id, is_representative DESC, similarity DESC",
          )
          .all(statusFilter) as MemberRow[])
      : (this.db
          .prepare(
            "SELECT * FROM prune_cluster_members ORDER BY cluster_id, is_representative DESC, similarity DESC",
          )
          .all() as MemberRow[]);

    const membersByCluster = new Map<string, MemberRow[]>();
    for (const row of memberRows) {
      if (!membersByCluster.has(row.cluster_id)) membersByCluster.set(row.cluster_id, []);
      membersByCluster.get(row.cluster_id)!.push(row);
    }

    return clusterRows.map((c) => this.toCluster(c, membersByCluster.get(c.cluster_id) ?? []));
  }

  getCluster(clusterId: string): PruneCluster | null {
    const cRow = this.db
      .prepare("SELECT * FROM prune_clusters WHERE cluster_id = ?")
      .get(clusterId) as ClusterRow | undefined;
    if (!cRow) return null;

    const mRows = this.db
      .prepare(
        "SELECT * FROM prune_cluster_members WHERE cluster_id = ? ORDER BY is_representative DESC, similarity DESC",
      )
      .all(clusterId) as MemberRow[];

    return this.toCluster(cRow, mRows);
  }

  updateMemberStatus(clusterId: string, noteId: string, status: PruneMemberStatus): void {
    this.db
      .prepare("UPDATE prune_cluster_members SET status = ? WHERE cluster_id = ? AND note_id = ?")
      .run(status, clusterId, noteId);
  }

  private toCluster(c: ClusterRow, members: MemberRow[]): PruneCluster {
    const mappedMembers: PruneClusterMember[] = members.map((m) => ({
      noteId: m.note_id,
      similarity: m.similarity,
      isRepresentative: Boolean(m.is_representative),
      status: m.status as PruneMemberStatus,
    }));

    return {
      clusterId: c.cluster_id,
      representativeNoteId: c.representative_note_id,
      members: mappedMembers,
      stats: {
        size: c.size,
        maxSimilarity: c.max_similarity,
        minSimilarity: c.min_similarity,
        avgSimilarity: c.avg_similarity,
      },
    };
  }
}
