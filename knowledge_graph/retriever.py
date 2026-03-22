"""ObsidiClawRetriever — hybrid retrieval with vector seeds + graph expansion.

Replaces the TS hybrid-retrieval.ts:
  - VectorStoreIndex.as_retriever() for semantic vector search (seeds)
  - SimplePropertyGraphStore.get_triplets() for depth-1 graph expansion (neighbors)
  - Tag boosting + index note filtering
"""

from __future__ import annotations

import logging
from typing import Optional

from llama_index.core import VectorStoreIndex
from llama_index.core.graph_stores import SimplePropertyGraphStore
from llama_index.embeddings.ollama import OllamaEmbedding

from .markdown_utils import normalize_token
from .models import ParsedNote, RetrievedNote

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants (match TS behaviour)
# ---------------------------------------------------------------------------

NEIGHBOR_SCORE_DECAY = 0.7  # expanded score = parent score × 0.7
TAG_BOOST_PER_TAG = 0.10  # +10% per matching tag
TAG_BOOST_MAX = 0.30  # max +30%


# ---------------------------------------------------------------------------
# Retriever
# ---------------------------------------------------------------------------


class ObsidiClawRetriever:
    """Hybrid retrieval: vector seeds + graph-expanded neighbors.

    1. VectorStoreIndex.as_retriever() for top-k semantic seeds
    2. SimplePropertyGraphStore.get_triplets() for depth-1 graph neighbors
    3. Tag boosting applied to both
    4. Index notes filtered from both
    """

    def __init__(
        self,
        index: VectorStoreIndex,
        graph_store: Optional[SimplePropertyGraphStore],
        embed_model: OllamaEmbedding,
        parsed_notes: dict[str, ParsedNote],
        similarity_top_k: int = 8,
    ) -> None:
        self.index = index
        self.graph_store = graph_store
        self.embed_model = embed_model
        self.parsed_notes = parsed_notes
        self.similarity_top_k = similarity_top_k

    def retrieve(self, query: str) -> tuple[list[RetrievedNote], list[RetrievedNote]]:
        """Run hybrid retrieval.

        Returns (seed_notes, expanded_notes) — both lists already filtered
        and scored.
        """
        query_tokens = set(
            normalize_token(w) for w in query.lower().split() if normalize_token(w)
        )

        # ── Step 1: Vector seeds ──────────────────────────────────────────
        retriever = self.index.as_retriever(similarity_top_k=self.similarity_top_k)
        raw_results = retriever.retrieve(query)

        seeds: list[RetrievedNote] = []
        seed_ids: set[str] = set()
        seed_scores: dict[str, float] = {}

        for r in raw_results:
            node = r.node
            score = r.score or 0.0
            note_id = node.id_ or ""
            metadata = getattr(node, "metadata", {}) or {}
            file_path = str(metadata.get("file_path", note_id))
            note_type_str = str(metadata.get("note_type", "concept"))

            # Skip index notes
            if note_type_str == "index":
                continue

            parsed = self.parsed_notes.get(file_path)
            tags = parsed.tags if parsed else []
            tool_id = parsed.tool_id if parsed else metadata.get("tool_id")
            content = parsed.body if parsed else getattr(node, "text", "")

            boosted_score = self._apply_tag_boost(score, tags, query_tokens)

            seeds.append(
                RetrievedNote(
                    note_id=file_path,
                    path=file_path,
                    content=content,
                    score=boosted_score,
                    type=note_type_str,  # type: ignore[arg-type]
                    tool_id=tool_id,
                    tags=tags,
                    retrieval_source="vector",
                    linked_from=None,
                    depth=0,
                )
            )
            seed_ids.add(file_path)
            seed_scores[file_path] = boosted_score

        # ── Step 2: Graph expansion (depth-1 neighbors) ──────────────────
        expanded: list[RetrievedNote] = []
        expanded_ids: set[str] = set()

        if self.graph_store:
            for seed_id in list(seed_ids):
                try:
                    triplets = self.graph_store.get_triplets(entity_names=[seed_id])
                except Exception as exc:
                    log.warning("get_triplets failed for %s: %s", seed_id, exc)
                    continue

                for source_node, _relation, target_node in triplets:
                    source_name = getattr(source_node, "name", "")
                    target_name = getattr(target_node, "name", "")

                    # Determine the neighbor (the other end of the relation)
                    if source_name == seed_id:
                        neighbor_id = target_name
                    else:
                        neighbor_id = source_name

                    # Skip if already a seed or already expanded
                    if neighbor_id in seed_ids or neighbor_id in expanded_ids:
                        continue

                    parsed = self.parsed_notes.get(neighbor_id)
                    if not parsed:
                        continue

                    if parsed.note_type == "index":
                        continue

                    # Neighbor score = parent score × decay
                    parent_score = seed_scores.get(seed_id, 0.5)
                    neighbor_score = parent_score * NEIGHBOR_SCORE_DECAY
                    boosted = self._apply_tag_boost(
                        neighbor_score, parsed.tags, query_tokens
                    )

                    expanded.append(
                        RetrievedNote(
                            note_id=neighbor_id,
                            path=neighbor_id,
                            content=parsed.body,
                            score=boosted,
                            type=parsed.note_type,  # type: ignore[arg-type]
                            tool_id=parsed.tool_id,
                            tags=parsed.tags,
                            retrieval_source="graph",
                            linked_from=[seed_id],
                            depth=1,
                        )
                    )
                    expanded_ids.add(neighbor_id)

        # Sort by score descending
        seeds.sort(key=lambda n: n.score, reverse=True)
        expanded.sort(key=lambda n: n.score, reverse=True)

        log.info(
            "Retrieved %d seeds + %d expanded for query: %.60s...",
            len(seeds),
            len(expanded),
            query,
        )

        return seeds, expanded

    @staticmethod
    def _apply_tag_boost(
        score: float, note_tags: list[str], query_tokens: set[str]
    ) -> float:
        """Boost score by +10% per matching tag, capped at +30%."""
        if not note_tags or not query_tokens:
            return score

        matching = sum(1 for t in note_tags if t in query_tokens)
        boost = min(matching * TAG_BOOST_PER_TAG, TAG_BOOST_MAX)
        return score * (1.0 + boost)
