"""Shared types for the knowledge graph service."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

# ---------------------------------------------------------------------------
# Note types
# ---------------------------------------------------------------------------

NoteType = Literal["tool", "concept", "index", "codebase", "codeUnit"]

# ---------------------------------------------------------------------------
# Parsed note (output of markdown ingestion)
# ---------------------------------------------------------------------------


@dataclass
class ParsedNote:
    """A single md_db note after frontmatter/body parsing."""

    note_id: str  # == relative_path
    path: str
    title: str
    note_type: NoteType
    body: str
    frontmatter: dict
    links_out: list[str]
    tool_id: Optional[str] = None
    time_created: Optional[str] = None
    last_edited: Optional[str] = None
    tags: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Retrieved note (output of retrieval)
# ---------------------------------------------------------------------------


@dataclass
class RetrievedNote:
    """A note returned by the retriever, scored and annotated."""

    note_id: str
    path: str
    content: str
    score: float
    type: NoteType
    retrieval_source: str  # "vector" | "graph" | "hybrid"
    tool_id: Optional[str] = None
    tags: Optional[list[str]] = None
    linked_from: Optional[list[str]] = None
    depth: Optional[int] = None  # 0 = seed, 1+ = graph expansion


# ---------------------------------------------------------------------------
# Prune types
# ---------------------------------------------------------------------------

PruneMemberStatus = Literal["pending", "keep", "merge", "ignore"]


@dataclass
class PruneClusterMember:
    note_id: str
    similarity: float
    is_representative: bool
    status: PruneMemberStatus = "pending"


@dataclass
class PruneClusterStats:
    size: int
    max_similarity: float
    min_similarity: float
    avg_similarity: float


@dataclass
class PruneCluster:
    cluster_id: str
    representative_note_id: str
    members: list[PruneClusterMember]
    stats: PruneClusterStats


@dataclass
class PruneConfig:
    similarity_threshold: float
    max_neighbors_per_note: int
    min_cluster_size: int
    include_note_types: list[NoteType]
    exclude_tags: list[str] = field(default_factory=list)
