"""Indexer — md_db scanning, note parsing, vector index + graph store construction.

Architecture (mirrors the old TS code):
  - VectorStoreIndex: owns text embeddings for semantic search (via OllamaEmbedding)
  - SimplePropertyGraphStore: owns wikilink graph (EntityNode + Relation edges)

Both persist to .obsidi-claw/knowledge_graph/.

This version leans on LlamaIndex's ObsidianReader for ingestion to avoid
bespoke frontmatter/wikilink parsing.
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
from llama_index.readers.obsidian import ObsidianReader

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

CANONICAL_NOTE_TYPES: dict[str, str] = {
    "tool": "tool",
    "concept": "concept",
    "index": "index",
    "codebase": "codebase",
    "codeunit": "codeUnit",
}


# ---------------------------------------------------------------------------
# Scan + parse (via ObsidianReader)
# ---------------------------------------------------------------------------


def _scan_md_db(md_db_path: str) -> list[ParsedNote]:
    """Use ObsidianReader to ingest markdown files with frontmatter + wikilinks."""
    # TODO: ObsidianReader metadata uses `file_name` + `folder_path` keys —
    #       update _relative_path() to construct path from those when
    #       `file_path`/`path`/`source` are missing.
    # TODO: ObsidianReader may flatten frontmatter fields directly into metadata
    #       instead of nesting under meta["frontmatter"]. Make _extract_tags(),
    #       _infer_note_type(), and frontmatter access robust to both layouts.
    reader = ObsidianReader(
        input_dir=md_db_path,
    )

    try:
        docs = reader.load_data()
    except Exception as exc:
        log.error("ObsidianReader failed: %s", exc)
        return []

    notes: list[ParsedNote] = []

    for doc in docs:
        meta = doc.metadata or {}
        frontmatter = meta.get("frontmatter", {})
        if not isinstance(frontmatter, dict):
            frontmatter = {}

        rel_path = _relative_path(meta, md_db_path)
        if not rel_path:
            log.warning("Skipping doc with unknown path metadata: %s", meta)
            continue

        title = _pick_title(meta, rel_path)
        note_type = _infer_note_type(frontmatter, rel_path)
        tags = _extract_tags(frontmatter, meta)

        raw_links = meta.get("wikilinks", []) or []
        links = _dedupe_links(raw_links)

        tool_id: Optional[str] = None
        if note_type == "tool":
            tool_id = str(frontmatter.get("tool_id") or Path(rel_path).stem)

        time_created = _first_non_empty(
            frontmatter.get("time_created"),
            frontmatter.get("created"),
            meta.get("time_created"),
            meta.get("created"),
        )
        last_edited = _first_non_empty(
            frontmatter.get("last_edited"),
            frontmatter.get("updated"),
            meta.get("last_edited"),
            meta.get("updated"),
        )

        notes.append(
            ParsedNote(
                note_id=rel_path,
                path=rel_path,
                title=title,
                note_type=note_type,
                body=doc.text or "",
                frontmatter=frontmatter,
                links_out=links,
                tool_id=tool_id,
                time_created=_str_or_none(time_created),
                last_edited=_str_or_none(last_edited),
                tags=tags,
            )
        )

    log.info("Scanned %d notes from %s via ObsidianReader", len(notes), md_db_path)
    return notes


def _relative_path(meta: dict, md_db_path: str) -> str | None:
    """Derive a vault-relative path from ObsidianReader metadata."""
    candidate = None
    for key in ("file_path", "path", "source"):
        val = meta.get(key)
        if isinstance(val, str) and val.strip():
            candidate = val
            break

    if not candidate:
        return None

    candidate = candidate.replace("\\", "/")
    # If absolute, rebase to md_db
    try:
        if os.path.isabs(candidate):
            rel = os.path.relpath(candidate, md_db_path)
        else:
            rel = candidate
    except Exception:
        rel = candidate

    return rel.replace("\\", "/")


def _pick_title(meta: dict, rel_path: str) -> str:
    title = meta.get("title")
    if isinstance(title, str) and title.strip():
        return title.strip()
    stem = Path(rel_path).stem
    return stem.replace("_", " ").replace("-", " ").title()


def _infer_note_type(frontmatter: dict, rel_path: str) -> NoteType:
    val = frontmatter.get("type") or frontmatter.get("note_type")
    if isinstance(val, str) and val.strip():
        normalized = val.strip().lower()
        if normalized in CANONICAL_NOTE_TYPES:
            return CANONICAL_NOTE_TYPES[normalized]  # type: ignore[return-value]

    norm_path = rel_path.replace("\\", "/")
    if norm_path.startswith("tools/"):
        return "tool"  # type: ignore[return-value]
    if norm_path.startswith("concepts/"):
        return "concept"  # type: ignore[return-value]

    if Path(rel_path).stem.lower() == "index":
        return "index"  # type: ignore[return-value]

    return "concept"  # type: ignore[return-value]


def _extract_tags(frontmatter: dict, meta: dict) -> list[str]:
    raw = frontmatter.get("tags") or meta.get("tags") or []
    tags: list[str] = []
    if isinstance(raw, list):
        tags = [str(t).strip() for t in raw if str(t).strip()]
    elif isinstance(raw, str):
        parts = [t.strip() for t in raw.replace("\n", ",").split(",") if t.strip()]
        tags = parts
    seen: set[str] = set()
    deduped: list[str] = []
    for t in tags:
        key = t.lower()
        if key not in seen:
            seen.add(key)
            deduped.append(t)
    return deduped


def _dedupe_links(raw_links: Any) -> list[str]:
    links: list[str] = []
    if isinstance(raw_links, list):
        links = [str(l).strip() for l in raw_links if str(l).strip()]
    seen: set[str] = set()
    result: list[str] = []
    for link in links:
        cleaned = link.split("|", 1)[0].strip()
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            result.append(cleaned)
    return result


def _first_non_empty(*values: Any) -> Optional[str]:
    for v in values:
        if isinstance(v, str) and v.strip():
            return v
    return None


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

    type_priority = {"tool": 0, "concept": 1, "codeUnit": 2, "index": 3, "codebase": 4}
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
