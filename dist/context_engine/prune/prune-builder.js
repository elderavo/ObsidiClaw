/**
 * Prune cluster builder — computes vector-similarity clusters from the existing
 * vector index and graph store. Does NOT mutate the vector store or graph.
 */
import { randomUUID } from "crypto";
import { normalizeToken, extractTags } from "../../shared/markdown/tokens.js";
const DEFAULT_QUERY_SLICE = 1200; // characters
export async function buildPruneClusters(config, vectorIndex, graphStore) {
    const notes = graphStore.listAllNotes();
    const allowedTypes = new Set(config.includeNoteTypes);
    const excludedTags = new Set((config.excludeTags ?? []).map(normalizeToken));
    const candidates = notes.filter((n) => {
        if (!allowedTypes.has(n.note_type))
            return false;
        const tags = extractTags(n.frontmatter_json);
        return !tags.some((t) => excludedTags.has(t));
    });
    // Map for quick lookup
    const noteById = new Map(candidates.map((n) => [n.note_id, n]));
    // Build similarity edges (undirected)
    const edges = [];
    const retriever = vectorIndex.asRetriever({ similarityTopK: config.maxNeighborsPerNote });
    for (const note of candidates) {
        const query = buildQueryFromNote(note);
        const results = await retriever.retrieve(query);
        for (const r of results) {
            const path = String(r.node.metadata["file_path"] ?? "");
            if (!path || path === note.note_id)
                continue;
            const targetNote = noteById.get(path);
            if (!targetNote)
                continue; // ignore non-candidate types
            const score = r.score ?? 0;
            if (score < config.similarityThreshold)
                continue;
            const keyA = note.note_id < path ? note.note_id : path;
            const keyB = note.note_id < path ? path : note.note_id;
            // Dedup edges by keeping the max similarity
            const existing = edges.find((e) => e.a === keyA && e.b === keyB);
            if (existing) {
                if (score > existing.similarity)
                    existing.similarity = score;
            }
            else {
                edges.push({ a: keyA, b: keyB, similarity: score });
            }
        }
    }
    if (edges.length === 0)
        return [];
    // Build adjacency for components
    const adj = new Map();
    const addEdge = (u, v, sim) => {
        if (!adj.has(u))
            adj.set(u, new Map());
        adj.get(u).set(v, sim);
    };
    for (const e of edges) {
        addEdge(e.a, e.b, e.similarity);
        addEdge(e.b, e.a, e.similarity);
    }
    // Connected components over the similarity graph
    const visited = new Set();
    const clusters = [];
    for (const nodeId of adj.keys()) {
        if (visited.has(nodeId))
            continue;
        const stack = [nodeId];
        const component = [];
        const componentEdges = [];
        while (stack.length > 0) {
            const current = stack.pop();
            if (visited.has(current))
                continue;
            visited.add(current);
            component.push(current);
            const neighbors = adj.get(current);
            if (!neighbors)
                continue;
            for (const [nbr, sim] of neighbors.entries()) {
                componentEdges.push({ a: current, b: nbr, similarity: sim });
                if (!visited.has(nbr))
                    stack.push(nbr);
            }
        }
        // Require minimum cluster size
        const uniqueNodes = new Set(component);
        if (uniqueNodes.size < config.minClusterSize)
            continue;
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
        const undirectedKeys = new Set();
        const sims = [];
        for (const e of componentEdges) {
            const key = e.a < e.b ? `${e.a}::${e.b}` : `${e.b}::${e.a}`;
            if (undirectedKeys.has(key))
                continue;
            undirectedKeys.add(key);
            sims.push(e.similarity);
        }
        if (sims.length === 0)
            continue;
        const maxSim = Math.max(...sims);
        const minSim = Math.min(...sims);
        const avgSim = sims.reduce((a, b) => a + b, 0) / sims.length;
        const members = [];
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
function buildQueryFromNote(note) {
    const body = note.body.slice(0, DEFAULT_QUERY_SLICE);
    return `${note.title}\n\n${body}`;
}
//# sourceMappingURL=prune-builder.js.map