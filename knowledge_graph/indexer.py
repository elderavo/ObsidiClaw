"""Indexer — md_db scanning, note parsing, vector index + graph store construction.

Architecture (mirrors the old TS code):
  - VectorStoreIndex: owns text embeddings for semantic search (via OllamaEmbedding)
  - SimplePropertyGraphStore: owns wikilink graph (EntityNode + Relation edges)

Both persist to .obsidi-claw/knowledge_graph/.
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
from llama_index.embeddings.ollama import OllamaEmbedding

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
}


# ---------------------------------------------------------------------------
# Scan + parse
# ---------------------------------------------------------------------------


def _scan_md_db(md_db_path: str) -> list[ParsedNote]:
    """Recursively scan md_db and parse each .md file."""
    file_paths = collect_markdown_files(md_db_path)
    notes: list[ParsedNote] = []

    for fpath in file_paths:
        try:
            content = Path(fpath).read_text(encoding="utf-8")
        except Exception as exc:
            log.warning("Cannot read %s: %s", fpath, exc)
            continue

        rel_path = os.path.relpath(fpath, md_db_path).replace("\\", "/")
        fm, body = parse_frontmatter(content)
        note_type = infer_note_type(fm, rel_path)
        title = extract_title(fm, body, rel_path)
        links = extract_wikilinks(body)
        tags = extract_tags(fm)

        tool_id: Optional[str] = None
        if note_type == "tool":
            tool_id = str(fm.get("tool_id") or Path(rel_path).stem)

        notes.append(
            ParsedNote(
                note_id=rel_path,
                path=rel_path,
                title=title,
                note_type=note_type,
                body=body,
                frontmatter=fm,
                links_out=links,
                tool_id=tool_id,
                time_created=_str_or_none(fm.get("time_created") or fm.get("created")),
                last_edited=_str_or_none(fm.get("last_edited") or fm.get("updated")),
                tags=tags,
            )
        )

    log.info("Scanned %d notes from %s", len(notes), md_db_path)
    return notes


def _str_or_none(val: Any) -> Optional[str]:
    if val is None:
        return None
    s = str(val).strip()
    return s if s else None


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

    type_priority = {"tool": 0, "concept": 1, "index": 2, "codebase": 3}
    candidates.sort(key=lambda n: type_priority.get(n.note_type, 99))
    return candidates[0].note_id


# ---------------------------------------------------------------------------
# Build index (slow path)
# ---------------------------------------------------------------------------


def build_index(
    md_db_path: str,
    db_dir: str,
    embed_model: OllamaEmbedding,
) -> tuple[VectorStoreIndex, SimplePropertyGraphStore, list[ParsedNote]]:
    """Full rebuild: scan md_db → build VectorStoreIndex + graph store → persist."""
    notes = _scan_md_db(md_db_path)
    notes_by_id = {n.note_id: n for n in notes}

    # ── Graph store: entity nodes + wikilink relations ──────────────────
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

    # Persist graph store separately
    graph_store.persist(persist_path=os.path.join(db_dir, "property_graph_store.json"))

    # ── Vector index: text embeddings ───────────────────────────────────
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
    log.info("Index persisted to %s", db_dir)

    return vector_index, graph_store, notes


# ---------------------------------------------------------------------------
# Load index (fast path)
# ---------------------------------------------------------------------------


def load_index(
    db_dir: str,
    embed_model: OllamaEmbedding,
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
