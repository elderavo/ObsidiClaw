/**
 * Prune cluster builder — computes vector-similarity clusters from the existing
 * vector index and graph store. Does NOT mutate the vector store or graph.
 */

import { randomUUID } from "crypto";
import type { VectorStoreIndex } from "llamaindex";
import type { SqliteGraphStore, StoredNote } from "../store/graph-store.js";
import type { NoteType, PruneCluster, PruneClusterMember, PruneConfig } from "../types.js";

interface Edge {
  a: string;
  b: string;
  similarity: number;
}

const DEFAULT_QUERY_SLICE = 1200; // characters

export async function buildPruneClusters(
  config: PruneConfig,
  vectorIndex: VectorStoreIndex,
  graphStore: SqliteGraphStore,
): Promise<PruneCluster[]> {
  const notes = graphStore.listAllNotes();
  const allowedTypes = new Set<NoteType>(config.includeNoteTypes);
  const excludedTags = new Set((config.excludeTags ?? []).map(normalizeToken));

  const candidates = notes.filter((n) => {
    if (!allowedTypes.has(n.note_type as NoteType)) return false;
    const tags = extractTags(n.frontmatter_json);
    return !tags.some((t) => excludedTags.has(t));
  });

  // Map for quick lookup
  const noteById = new Map<string, StoredNote>(candidates.map((n) => [n.note_id, n]));

  // Build similarity edges (undirected)
  const edges: Edge[] = [];
  const retriever = vectorIndex.asRetriever({ similarityTopK: config.maxNeighborsPerNote });

  for (const note of candidates) {
    const query = buildQueryFromNote(note);
    const results = await retriever.retrieve(query);

    for (const r of results) {
      const path = String(r.node.metadata["file_path"] ?? "");
      if (!path || path === note.note_id) continue;

      const targetNote = noteById.get(path);
      if (!targetNote) continue; // ignore non-candidate types

      const score = r.score ?? 0;
      if (score < config.similarityThreshold) continue;

      const keyA = note.note_id < path ? note.note_id : path;
      const keyB = note.note_id < path ? path : note.note_id;

      // Dedup edges by keeping the max similarity
      const existing = edges.find((e) => e.a === keyA && e.b === keyB);
      if (existing) {
        if (score > existing.similarity) existing.similarity = score;
      } else {
        edges.push({ a: keyA, b: keyB, similarity: score });
      }
    }
  }

  if (edges.length === 0) return [];

  // Build adjacency for components
  const adj = new Map<string, Map<string, number>>();
  const addEdge = (u: string, v: string, sim: number) => {
    if (!adj.has(u)) adj.set(u, new Map());
    adj.get(u)!.set(v, sim);
  };

  for (const e of edges) {
    addEdge(e.a, e.b, e.similarity);
    addEdge(e.b, e.a, e.similarity);
  }

  // Connected components over the similarity graph
  const visited = new Set<string>();
  const clusters: PruneCluster[] = [];

  for (const nodeId of adj.keys()) {
    if (visited.has(nodeId)) continue;

    const stack = [nodeId];
    const component: string[] = [];
    const componentEdges: Edge[] = [];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);

      const neighbors = adj.get(current);
      if (!neighbors) continue;
      for (const [nbr, sim] of neighbors.entries()) {
        componentEdges.push({ a: current, b: nbr, similarity: sim });
        if (!visited.has(nbr)) stack.push(nbr);
      }
    }

    // Require minimum cluster size
    const uniqueNodes = new Set(component);
    if (uniqueNodes.size < config.minClusterSize) continue;

    // Representative: highest degree (ties by noteId lex)
    let representative = nodeId;
    let bestDegree = -1;
    for (const n of uniqueNodes) {
      const deg = adj.get(n)?.size ?? 0;
      if (deg > bestDegree || (deg === bestDegree && n < representative)) {
        representative = n;
        bestDegree = deg;
      }
    }

    // Similarity stats (from component edges, unique undirected)
    const undirectedKeys = new Set<string>();
    const sims: number[] = [];
    for (const e of componentEdges) {
      const key = e.a < e.b ? `${e.a}::${e.b}` : `${e.b}::${e.a}`;
      if (undirectedKeys.has(key)) continue;
      undirectedKeys.add(key);
      sims.push(e.similarity);
    }

    if (sims.length === 0) continue;

    const maxSim = Math.max(...sims);
    const minSim = Math.min(...sims);
    const avgSim = sims.reduce((a, b) => a + b, 0) / sims.length;

    const members: PruneClusterMember[] = [];
    for (const n of uniqueNodes) {
      const simToRep = n === representative ? 1 : adj.get(representative)?.get(n) ?? 0;
      members.push({
        noteId: n,
        similarity: simToRep,
        isRepresentative: n === representative,
        status: "pending",
      });
    }

    clusters.push({
      clusterId: randomUUID(),
      representativeNoteId: representative,
      members,
      stats: {
        size: uniqueNodes.size,
        maxSimilarity: maxSim,
        minSimilarity: minSim,
        avgSimilarity: avgSim,
      },
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildQueryFromNote(note: StoredNote): string {
  const body = note.body.slice(0, DEFAULT_QUERY_SLICE);
  return `${note.title}\n\n${body}`;
}

function extractTags(frontmatterJson?: string | null): string[] {
  if (!frontmatterJson) return [];
  try {
    const parsed = JSON.parse(frontmatterJson) as Record<string, unknown>;
    const rawTags = parsed["tags"];

    const tags: string[] = [];
    if (Array.isArray(rawTags)) {
      tags.push(...rawTags.map((t) => String(t)));
    } else if (typeof rawTags === "string") {
      tags.push(...rawTags.split(",").map((t) => t.trim()));
    }

    return tags.map(normalizeToken).filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
