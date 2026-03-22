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
import type { VectorStoreIndex } from "llamaindex";
import type { SqliteGraphStore, StoredNote } from "../store/graph-store.js";
import type { NoteType, RetrievedNote } from "../types.js";
import { normalizeToken, normalizeTokens, extractTags, normalizeTagList } from "../../shared/markdown/tokens.js";

const GRAPH_SCORE_DECAY = 0.7;
const TAG_BOOST_PER_MATCH = 0.1;
const MAX_TAG_BOOST = 0.3;

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
export async function hybridRetrieve(
  query: string,
  vectorIndex: VectorStoreIndex,
  graphStore: SqliteGraphStore,
  topK: number,
): Promise<HybridResult> {
  // ── Step 1: vector seeds ─────────────────────────────────────────────────

  const retriever = vectorIndex.asRetriever({ similarityTopK: topK });
  const rawResults = await retriever.retrieve(query);

  const allSeedNotes: RetrievedNote[] = [];

  for (const r of rawResults) {
    const path = String(r.node.metadata["file_path"] ?? "");
    if (!path) continue;

    const baseScore = r.score ?? 0;
    const stored = graphStore.getNoteByPath(path);
    const tags = extractTags(stored?.frontmatter_json);
    const score = applyTagBoost(baseScore, tags, query);

    allSeedNotes.push({
      noteId: path,
      path,
      content: r.node.getContent(MetadataMode.NONE),
      score,
      type: (stored?.note_type ?? inferNoteType(path)) as NoteType,
      toolId: stored?.tool_id ?? undefined,
      tags,
      retrievalSource: "vector",
      depth: 0,
    });
  }

  // Filter index-type notes — they are navigation/TOC files, not useful context
  const seedNotes = allSeedNotes.filter((n) => n.type !== "index");

  const seedScoreByNoteId = new Map<string, number>();
  for (const n of seedNotes) {
    seedScoreByNoteId.set(n.noteId, n.score);
  }

  // ── Step 2: graph expansion ───────────────────────────────────────────────

  const seedIds = seedNotes.map((n) => n.noteId);
  const neighbors = graphStore.getNeighbors(seedIds, 1);

  if (neighbors.length === 0) {
    return { seedNotes, expandedNotes: [] };
  }

  const storedNeighbors = graphStore.getNotesByIds(neighbors.map((n) => n.noteId));
  const storedByNoteId = new Map<string, StoredNote>(
    storedNeighbors.map((s) => [s.note_id, s]),
  );

  const expandedNotes: RetrievedNote[] = [];

  for (const neighbor of neighbors) {
    const stored = storedByNoteId.get(neighbor.noteId);
    if (!stored) continue;

    const parentScore = seedScoreByNoteId.get(neighbor.linkedFrom) ?? 0;
    const baseScore = parentScore * GRAPH_SCORE_DECAY;
    const tags = extractTags(stored.frontmatter_json);
    const score = applyTagBoost(baseScore, tags, query);

    expandedNotes.push({
      noteId: neighbor.noteId,
      path: stored.path,
      content: stored.body,
      score,
      type: stored.note_type as NoteType,
      toolId: stored.tool_id ?? undefined,
      tags,
      retrievalSource: "graph",
      depth: neighbor.depth,
      linkedFrom: [neighbor.linkedFrom],
    });
  }

  return {
    seedNotes,
    expandedNotes: expandedNotes.filter((n) => n.type !== "index"),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferNoteType(relativePath: string): NoteType {
  if (relativePath.startsWith("tools/")) return "tool";
  if (relativePath.startsWith("concepts/")) return "concept";
  return "index";
}

function applyTagBoost(score: number, tags: string[], query: string): number {
  if (score <= 0 || tags.length === 0) return score;
  const boost = computeTagBoost(tags, query);
  return score * (1 + boost);
}

function computeTagBoost(tags: string[], query: string): number {
  const normalizedQuery = normalizeToken(query);
  const queryTokens = new Set(normalizeTokens(query));

  let matches = 0;
  for (const tag of tags) {
    const normalizedTag = normalizeToken(tag);
    if (!normalizedTag) continue;

    if (queryTokens.has(normalizedTag) || normalizedQuery.includes(normalizedTag)) {
      matches++;
    }
  }

  if (matches === 0) return 0;
  return Math.min(MAX_TAG_BOOST, TAG_BOOST_PER_MATCH * matches);
}

