"""ObsidiClawRetriever — hybrid retrieval with vector seeds + tier-aware graph expansion.

Replaces the TS hybrid-retrieval.ts:
  - VectorStoreIndex.as_retriever() for semantic vector search (seeds)
  - SimplePropertyGraphStore.get_triplets() for depth-1 graph expansion
  - Tier-aware score multipliers (vs. flat 0.7 decay)
  - Tag boosting + index note filtering

Tier-aware expansion heuristics
────────────────────────────────
Going UP (always):
  DEFINED_IN   tier-1 → tier-2   0.80×   symbol's parent file
  BELONGS_TO   tier-2 → tier-3   0.50×   file's parent module

Going DOWN (selective — only when seed score ≥ DOWN_SEED_THRESHOLD):
  CONTAINS_SYMBOL  tier-2 → tier-1   0.90×   symbols inside a file
  CONTAINS         tier-3 → tier-2   0.85×   files inside a module

Going SIDEWAYS (conditional — only when neighbor name overlaps query):
  CALLS    tier-1 → tier-1   0.60×
  IMPORTS  tier-2 → tier-2   0.60×

Generic (non-code notes):
  LINKS_TO  any   0.70×
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from llama_index.core import VectorStoreIndex
from llama_index.core.graph_stores import SimplePropertyGraphStore
from llama_index.embeddings.ollama import OllamaEmbedding

from .markdown_utils import normalize_token
from .models import ParsedNote, RetrievedNote

log = logging.getLogger(__name__)


class WorkspaceScopeViolationError(RuntimeError):
    """Raised when scoped vector retrieval returns a note outside requested workspace."""

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

TAG_BOOST_PER_TAG = 0.10   # +10% per matching tag
TAG_BOOST_MAX = 0.30       # cap at +30%

# Score multipliers for each edge type
_EDGE_MULTIPLIER: dict[str, float] = {
    "DEFINED_IN": 0.80,         # up: symbol → file
    "BELONGS_TO": 0.50,         # up: file → module
    "CONTAINS_SYMBOL": 0.90,    # down: file → symbol
    "CONTAINS": 0.85,           # down: module → file
    "CALLS": 0.60,              # sideways: symbol → symbol
    "IMPORTS": 0.60,            # sideways: file → file
    "LINKS_TO": 0.70,           # generic non-code wikilink
}

# Only follow downward edges when the seed has a strong enough score
DOWN_SEED_THRESHOLD = 0.60

# Only follow CALLS/IMPORTS when neighbor name overlaps the query
SIDEWAYS_REQUIRE_QUERY_OVERLAP = True


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _name_tokens(note: ParsedNote) -> set[str]:
    """Normalized tokens from a note's title and path stem."""
    stem = Path(note.path).stem
    tokens: set[str] = set()
    for word in (note.title + " " + stem).split():
        t = normalize_token(word)
        if t:
            tokens.add(t)
    return tokens


def _overlaps_query(note: ParsedNote, query_tokens: set[str]) -> bool:
    """True if any name token appears in the query."""
    return bool(_name_tokens(note) & query_tokens)


def _apply_tag_boost(score: float, note_tags: list[str], query_tokens: set[str]) -> float:
    """Boost score by +10% per matching tag, capped at +30%."""
    if not note_tags or not query_tokens:
        return score
    matching = sum(1 for t in note_tags if t in query_tokens)
    boost = min(matching * TAG_BOOST_PER_TAG, TAG_BOOST_MAX)
    return score * (1.0 + boost)


def _should_skip_edge(
    edge_label: str,
    is_outgoing: bool,
    seed_score: float,
    neighbor_parsed: ParsedNote,
    query_tokens: set[str],
) -> bool:
    """Return True if this expansion edge should be skipped."""
    # Downward edges: only follow when seed is strong
    if edge_label in ("CONTAINS_SYMBOL", "CONTAINS"):
        if not is_outgoing:
            # Incoming CONTAINS_SYMBOL/CONTAINS means neighbor is the container
            # — that's "going up", allow.
            return False
        if seed_score < DOWN_SEED_THRESHOLD:
            return True

    # Sideways edges: only follow when neighbor name overlaps query
    if edge_label in ("CALLS", "IMPORTS") and SIDEWAYS_REQUIRE_QUERY_OVERLAP:
        if not _overlaps_query(neighbor_parsed, query_tokens):
            return True

    return False


def expand_graph_neighbors(
    graph_store: Optional[SimplePropertyGraphStore],
    parsed_notes: dict[str, ParsedNote],
    seed_notes: list[RetrievedNote],
    query_tokens: set[str],
    workspace: str | None = None,
) -> list[RetrievedNote]:
    """Expand seed notes to depth-1 neighbors using tier-aware edge heuristics."""
    if not graph_store or not seed_notes:
        return []

    seed_ids = {n.note_id for n in seed_notes}
    seed_scores = {n.note_id: n.score for n in seed_notes}

    expanded: list[RetrievedNote] = []
    expanded_ids: set[str] = set()

    for seed in seed_notes:
        seed_id = seed.note_id
        seed_score = seed_scores.get(seed_id, 0.5)

        try:
            triplets = graph_store.get_triplets(entity_names=[seed_id])
        except Exception as exc:
            log.warning("get_triplets failed for %s: %s", seed_id, exc)
            continue

        for source_node, relation, target_node in triplets:
            source_name = getattr(source_node, "name", "")
            target_name = getattr(target_node, "name", "")
            edge_label = getattr(relation, "label", "LINKS_TO")

            is_outgoing = source_name == seed_id
            neighbor_id = target_name if is_outgoing else source_name

            if not neighbor_id or neighbor_id in seed_ids or neighbor_id in expanded_ids:
                continue

            neighbor_parsed = parsed_notes.get(neighbor_id)
            if not neighbor_parsed or neighbor_parsed.note_type == "index":
                continue

            if workspace and neighbor_parsed.workspace != workspace:
                continue

            if _should_skip_edge(
                edge_label=edge_label,
                is_outgoing=is_outgoing,
                seed_score=seed_score,
                neighbor_parsed=neighbor_parsed,
                query_tokens=query_tokens,
            ):
                continue

            multiplier = _EDGE_MULTIPLIER.get(edge_label, 0.70)
            neighbor_score = seed_score * multiplier
            boosted = _apply_tag_boost(neighbor_score, neighbor_parsed.tags, query_tokens)

            expanded.append(
                RetrievedNote(
                    note_id=neighbor_id,
                    path=neighbor_id,
                    content=neighbor_parsed.body,
                    score=boosted,
                    type=neighbor_parsed.note_type,  # type: ignore[arg-type]
                    tool_id=neighbor_parsed.tool_id,
                    tags=neighbor_parsed.tags,
                    retrieval_source="graph",
                    linked_from=[seed_id],
                    depth=1,
                    tier=neighbor_parsed.tier,
                    workspace=neighbor_parsed.workspace,
                    title=neighbor_parsed.title,
                )
            )
            expanded_ids.add(neighbor_id)

    expanded.sort(key=lambda n: n.score, reverse=True)
    return expanded


# ---------------------------------------------------------------------------
# Retriever
# ---------------------------------------------------------------------------


class ObsidiClawRetriever:
    """Hybrid retrieval: vector seeds + tier-aware graph-expanded neighbors.

    1. VectorStoreIndex.as_retriever() for top-k semantic seeds
    2. SimplePropertyGraphStore.get_triplets() for depth-1 expansion
       with per-edge-type score multipliers
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

    def retrieve(self, query: str, workspace: str | None = None) -> tuple[list[RetrievedNote], list[RetrievedNote]]:
        """Run hybrid retrieval.

        Returns (seed_notes, expanded_notes) — both lists filtered and scored.
        If workspace is set, only notes from that workspace are returned as seeds.
        Graph-expanded notes are also filtered to the same workspace.
        """
        query_tokens = set(
            normalize_token(w) for w in query.lower().split() if normalize_token(w)
        )

        # ── Step 1: Vector seeds ──────────────────────────────────────────
        retriever_kwargs: dict = {"similarity_top_k": self.similarity_top_k}
        if workspace:
            from llama_index.core.vector_stores.types import (
                MetadataFilters,
                MetadataFilter,
                FilterOperator,
            )

            retriever_kwargs["filters"] = MetadataFilters(
                filters=[
                    MetadataFilter(
                        key="workspace", value=workspace, operator=FilterOperator.EQ
                    ),
                ]
            )

        retriever = self.index.as_retriever(**retriever_kwargs)
        raw_results = retriever.retrieve(query)

        seeds: list[RetrievedNote] = []
        seed_ids: set[str] = set()
        seed_scores: dict[str, float] = {}

        for r in raw_results:
            node = r.node
            score = r.score or 0.0
            raw_id = node.id_ or ""
            metadata = getattr(node, "metadata", {}) or {}

            # Chunk dedup: map chunk IDs back to parent note
            parent_id = str(metadata.get("parent_note_id", ""))
            note_id = parent_id if parent_id else raw_id
            file_path = str(metadata.get("file_path", note_id))
            note_type_str = str(metadata.get("note_type", "concept"))

            if note_type_str == "index":
                continue

            parsed = self.parsed_notes.get(file_path)
            tags = parsed.tags if parsed else []
            tool_id = parsed.tool_id if parsed else metadata.get("tool_id")
            content = parsed.body if parsed else getattr(node, "text", "")
            tier = parsed.tier if parsed else ""
            ws = parsed.workspace if parsed else str(metadata.get("workspace", ""))

            # Workspace scope is a hard contract for scoped retrieval.
            # If the vector backend violates metadata filtering, fail this path
            # and let the engine fall back to deterministic keyword retrieval.
            if workspace and ws != workspace:
                raise WorkspaceScopeViolationError(
                    f"workspace scope violated: requested={workspace!r} got={ws!r} note={file_path!r}"
                )

            boosted_score = _apply_tag_boost(score, tags, query_tokens)

            # If we already have a seed for this note (from another chunk), keep highest score
            if file_path in seed_ids:
                if boosted_score > seed_scores.get(file_path, 0.0):
                    seed_scores[file_path] = boosted_score
                    # Update the existing seed's score
                    for s in seeds:
                        if s.note_id == file_path:
                            s.score = boosted_score
                            break
                continue

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
                    tier=tier,
                    workspace=ws,
                    title=parsed.title if parsed else str(metadata.get("title", "")),
                )
            )
            seed_ids.add(file_path)
            seed_scores[file_path] = boosted_score

        # ── Step 2: Tier-aware graph expansion ────────────────────────────
        expanded = expand_graph_neighbors(
            graph_store=self.graph_store,
            parsed_notes=self.parsed_notes,
            seed_notes=seeds,
            query_tokens=query_tokens,
            workspace=workspace,
        )

        seeds.sort(key=lambda n: n.score, reverse=True)

        log.info(
            "Retrieved %d seeds + %d expanded for query: %.60s...",
            len(seeds),
            len(expanded),
            query,
        )

        return seeds, expanded
