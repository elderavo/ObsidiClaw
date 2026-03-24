"""Indexer — md_db scanning, note parsing, vector index + graph store construction.

Architecture:
  - VectorStoreIndex: owns text embeddings for semantic search (via embedding provider)
  - SimplePropertyGraphStore: owns wikilink graph (EntityNode + Relation edges)

Both persist to .obsidi-claw/knowledge_graph/.

Ingestion uses markdown_utils (our own frontmatter/wikilink/title/type parser)
rather than LlamaIndex's ObsidianReader, so parsing is fully under our control
and the MD5 hash stays byte-identical across TS and Python.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Optional

from llama_index.core import VectorStoreIndex, StorageContext, load_index_from_storage
from llama_index.core.graph_stores import (
    EntityNode,
    Relation,
    SimplePropertyGraphStore,
)
from llama_index.core.schema import TextNode

from .markdown_utils import (
    collect_markdown_files,
    extract_tags,
    extract_title,
    extract_wikilinks,
    infer_note_type,
    parse_frontmatter,
)
from .models import NoteType, ParsedNote

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Note label mapping
# ---------------------------------------------------------------------------

_LABEL_MAP: dict[str, str] = {
    "tool": "TOOL",
    "concept": "CONCEPT",
    "index": "INDEX",
    "codebase": "CODEBASE",
    "codeUnit": "CODEUNIT",
}


# ---------------------------------------------------------------------------
# Scan + parse (via markdown_utils)
# ---------------------------------------------------------------------------


def _scan_md_db(md_db_path: str) -> list[ParsedNote]:
    """Scan md_db directory and parse all .md files into ParsedNote objects."""
    file_paths = collect_markdown_files(md_db_path)
    notes: list[ParsedNote] = []

    for abs_path in file_paths:
        try:
            content = Path(abs_path).read_text(encoding="utf-8")
        except Exception as exc:
            log.warning("Failed to read %s: %s", abs_path, exc)
            continue

        rel_path = os.path.relpath(abs_path, md_db_path).replace("\\", "/")
        frontmatter, body = parse_frontmatter(content)

        note_type = infer_note_type(frontmatter, rel_path)
        title = extract_title(frontmatter, body, rel_path)
        tags = extract_tags(frontmatter)
        links = extract_wikilinks(body)

        tool_id: Optional[str] = None
        if note_type == "tool":
            tool_id = str(frontmatter.get("tool_id") or Path(rel_path).stem)

        time_created = _first_str(
            frontmatter.get("time_created"),
            frontmatter.get("created"),
        )
        last_edited = _first_str(
            frontmatter.get("last_edited"),
            frontmatter.get("updated"),
        )

        notes.append(
            ParsedNote(
                note_id=rel_path,
                path=rel_path,
                title=title,
                note_type=note_type,  # type: ignore[arg-type]
                body=body,
                frontmatter=frontmatter,
                links_out=links,
                tool_id=tool_id,
                time_created=time_created,
                last_edited=last_edited,
                tags=tags,
            )
        )

    log.info("Scanned %d notes from %s", len(notes), md_db_path)
    return notes


def _first_str(*values: object) -> Optional[str]:
    """Return the first non-empty string value, or None."""
    for v in values:
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


# ---------------------------------------------------------------------------
# Wikilink resolution
# ---------------------------------------------------------------------------


def _resolve_link(target: str, notes_by_id: dict[str, ParsedNote]) -> Optional[str]:
    """Resolve a wikilink target to a note_id.

    Priority: exact match > suffix match (tool > concept > index).
    """
    # Exact match
    if target in notes_by_id:
        return target

    # Try with .md
    if not target.endswith(".md"):
        with_md = target + ".md"
        if with_md in notes_by_id:
            return with_md

    # Suffix match
    candidates: list[ParsedNote] = []
    for note in notes_by_id.values():
        norm_path = note.path.replace("\\", "/")
        check_target = target if target.endswith(".md") else target + ".md"
        if norm_path.endswith("/" + check_target) or norm_path == check_target:
            candidates.append(note)

    if not candidates:
        # Try stem match
        target_stem = Path(target).stem.lower()
        for note in notes_by_id.values():
            if Path(note.path).stem.lower() == target_stem:
                candidates.append(note)

    if not candidates:
        return None

    if len(candidates) == 1:
        return candidates[0].note_id

    type_priority = {"tool": 0, "concept": 1, "codeUnit": 2, "index": 3, "codebase": 4}
    candidates.sort(key=lambda n: type_priority.get(n.note_type, 99))
    return candidates[0].note_id


# ---------------------------------------------------------------------------
# Graph store construction (separated from vector index)
# ---------------------------------------------------------------------------


def _build_graph_store(
    notes: list[ParsedNote],
    notes_by_id: dict[str, ParsedNote],
) -> SimplePropertyGraphStore:
    """Build a SimplePropertyGraphStore from parsed notes.

    Creates entity nodes and wikilink relations. Does NOT require an
    embedding provider — pure graph structure.
    """
    graph_store = SimplePropertyGraphStore()

    entity_nodes: list[EntityNode] = []
    for note in notes:
        label = _LABEL_MAP.get(note.note_type, "CONCEPT")
        entity = EntityNode(
            name=note.note_id,
            label=label,
            properties={
                "path": note.path,
                "title": note.title,
                "tool_id": note.tool_id or "",
                "tags": ",".join(note.tags),
                "note_type": note.note_type,
            },
        )
        entity_nodes.append(entity)

    graph_store.upsert_nodes(entity_nodes)

    relations: list[Relation] = []
    for note in notes:
        for link_target in note.links_out:
            resolved = _resolve_link(link_target, notes_by_id)
            if resolved and resolved != note.note_id:
                relations.append(Relation(
                    label="LINKS_TO",
                    source_id=note.note_id,
                    target_id=resolved,
                ))

    if relations:
        graph_store.upsert_relations(relations)
    log.info("Graph: %d nodes, %d relations", len(entity_nodes), len(relations))

    return graph_store


# ---------------------------------------------------------------------------
# Vector index construction (requires embedding provider)
# ---------------------------------------------------------------------------


def _build_vector_index(
    notes: list[ParsedNote],
    embed_model: Any,
    db_dir: str,
) -> VectorStoreIndex:
    """Build a VectorStoreIndex from parsed notes and persist to disk.

    Requires a working embedding provider (OllamaEmbedding, OpenAIEmbedding, etc).
    """
    text_nodes: list[TextNode] = []
    for note in notes:
        text_nodes.append(TextNode(
            text=f"{note.title}\n\n{note.body}",
            id_=note.note_id,
            metadata={
                "file_path": note.path,
                "note_type": note.note_type,
                "title": note.title,
                "tool_id": note.tool_id or "",
                "tags": ",".join(note.tags),
            },
        ))

    vector_index = VectorStoreIndex(
        nodes=text_nodes,
        embed_model=embed_model,
        show_progress=True,
    )

    # Persist vector index
    vector_index.storage_context.persist(persist_dir=db_dir)
    log.info("Vector index persisted to %s", db_dir)

    return vector_index


# ---------------------------------------------------------------------------
# Combined build (legacy — kept for backward compat)
# ---------------------------------------------------------------------------


def build_index(
    md_db_path: str,
    db_dir: str,
    embed_model: Any,
) -> tuple[VectorStoreIndex, SimplePropertyGraphStore, list[ParsedNote]]:
    """Full rebuild: scan md_db → build VectorStoreIndex + graph store → persist.

    Note: prefer using _scan_md_db, _build_graph_store, and _build_vector_index
    separately for better control over degraded mode.
    """
    notes = _scan_md_db(md_db_path)
    notes_by_id = {n.note_id: n for n in notes}

    graph_store = _build_graph_store(notes, notes_by_id)
    graph_store.persist(persist_path=os.path.join(db_dir, "property_graph_store.json"))

    vector_index = _build_vector_index(notes, embed_model, db_dir)

    return vector_index, graph_store, notes


# ---------------------------------------------------------------------------
# Load index (fast path)
# ---------------------------------------------------------------------------


def load_index(
    db_dir: str,
    embed_model: Any,
    md_db_path: str,
) -> tuple[VectorStoreIndex, SimplePropertyGraphStore, list[ParsedNote]]:
    """Load persisted VectorStoreIndex + graph store from disk."""
    # Load graph store
    graph_store = SimplePropertyGraphStore.from_persist_path(
        os.path.join(db_dir, "property_graph_store.json")
    )

    # Load vector index
    storage_context = StorageContext.from_defaults(persist_dir=db_dir)
    vector_index = load_index_from_storage(
        storage_context=storage_context,
        embed_model=embed_model,
    )

    # Re-scan for note bodies (fast — no embedding, just file reads)
    notes = _scan_md_db(md_db_path)

    log.info("Loaded from %s — %d notes", db_dir, len(notes))
    return vector_index, graph_store, notes
