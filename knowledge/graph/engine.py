"""KnowledgeGraphEngine — VectorStoreIndex + graph store lifecycle management.

Owns the vector index, embedding model, graph store, and persistence directory.
Called by the JSON-RPC server handlers.

Supports graceful degradation:
  - "full" mode: vector embeddings + graph + keyword (all available)
  - "degraded" mode: graph + keyword only (embedding provider unavailable or set to "local")
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

from llama_index.core import VectorStoreIndex, Settings
from llama_index.core.graph_stores import SimplePropertyGraphStore
from llama_index.core.schema import TextNode, Document

from .indexer import build_index, load_index, _scan_md_db, _build_graph_store
from .keyword_retriever import KeywordRetriever
from .markdown_utils import compute_md_db_hash
from .models import ParsedNote, RetrievedNote
from .providers import get_embed_config, check_reachable, create_embedding

log = logging.getLogger(__name__)


def _content_hash(text: str) -> str:
    """Fast MD5 hash of note body text for change detection."""
    return hashlib.md5(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class KnowledgeGraphEngine:
    """Manages VectorStoreIndex + SimplePropertyGraphStore for hybrid retrieval."""

    def __init__(self) -> None:
        self.index: Optional[VectorStoreIndex] = None
        self.embed_model: Optional[Any] = None
        self.graph_store: Optional[SimplePropertyGraphStore] = None
        self.keyword_retriever: Optional[KeywordRetriever] = None

        # Mode tracking
        self._mode: str = "degraded"  # "full" | "degraded"
        self._degraded_reason: str = ""

        # Config (set during initialize)
        self.md_db_path: str = ""
        self.db_dir: str = ""
        self.top_k: int = 8

        # In-memory note cache: {relative_path: stripped_body}
        self.note_cache: dict[str, str] = {}

        # Parsed notes for retrieval metadata
        self._parsed_notes: dict[str, ParsedNote] = {}

        # Per-note content hash for incremental updates: {note_id: md5_hex}
        self._note_hashes: dict[str, str] = {}

    # ------------------------------------------------------------------
    # Initialize
    # ------------------------------------------------------------------

    def initialize(
        self,
        md_db_path: str,
        db_dir: str,
        top_k: int = 8,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Boot the engine: scan notes, build graph, optionally build vector index.

        Keyword args (backward compat):
            ollama_host: str — maps to embed config host override
            embed_model: str — maps to embed config model override

        Returns init metadata for the TS bridge.
        """
        t0 = time.time()
        self.md_db_path = md_db_path
        self.db_dir = db_dir
        self.top_k = top_k

        # Ensure persistence dir exists
        os.makedirs(db_dir, exist_ok=True)

        # ── Step 1: Scan + parse all notes (always — no provider needed) ─
        notes = _scan_md_db(md_db_path)
        notes_by_id = {n.note_id: n for n in notes}
        self._parsed_notes = notes_by_id

        # ── Step 2: Build graph store (always — no provider needed) ──────
        self.graph_store = _build_graph_store(notes, notes_by_id)
        # Persist graph store
        self.graph_store.persist(
            persist_path=os.path.join(db_dir, "property_graph_store.json")
        )

        # ── Step 3: Build keyword retriever (always) ────────────────────
        self.keyword_retriever = KeywordRetriever(notes_by_id)

        # ── Step 4: Build note cache + per-note hashes (always) ──────────
        self.note_cache = {n.note_id: n.body for n in notes}
        self._note_hashes = {n.note_id: _content_hash(n.body) for n in notes}

        # ── Step 5: Resolve embed config ────────────────────────────────
        embed_config = get_embed_config()

        # Backward compat: TS may pass ollama_host/embed_model via kwargs
        if "ollama_host" in kwargs and kwargs["ollama_host"]:
            embed_config["host"] = kwargs["ollama_host"]
        if "embed_model" in kwargs and kwargs["embed_model"]:
            embed_config["model"] = kwargs["embed_model"]

        # ── Step 6: Create embedding model ──────────────────────────────
        embed_model_obj = create_embedding(embed_config)

        # Disable LlamaIndex's default OpenAI LLM — we don't use it
        Settings.llm = None

        if embed_model_obj is None:
            # provider="local" — no vector index
            self._mode = "degraded"
            self._degraded_reason = "Embedding provider set to 'local'"
            self.embed_model = None
            self.index = None
            log.info("Initialized in degraded mode: %s", self._degraded_reason)

        elif check_reachable(embed_config):
            # Provider available — build or load vector index
            self.embed_model = embed_model_obj
            Settings.embed_model = embed_model_obj
            self._build_or_load_vector_index(notes, notes_by_id, embed_model_obj)
            self._mode = "full"
            self._degraded_reason = ""

        else:
            # Provider configured but unreachable
            host = embed_config.get("host", "")
            self.embed_model = embed_model_obj

            if self._has_persisted_index():
                # Try loading cached index (doesn't hit provider until query time)
                try:
                    self.index = self._load_vector_index_only(embed_model_obj)
                    Settings.embed_model = embed_model_obj
                    self._mode = "degraded"
                    self._degraded_reason = f"Embedding provider unreachable at {host}; loaded cached index"
                    log.info("Loaded cached vector index despite unreachable provider")
                except Exception as exc:
                    log.warning("Failed to load cached vector index: %s", exc)
                    self.index = None
                    self._mode = "degraded"
                    self._degraded_reason = f"Embedding provider unreachable at {host}"
            else:
                self.index = None
                self._mode = "degraded"
                self._degraded_reason = f"Embedding provider unreachable at {host}"

            log.info("Initialized in degraded mode: %s", self._degraded_reason)

        duration_ms = int((time.time() - t0) * 1000)
        path_type = "full" if self._mode == "full" else "degraded"
        log.info(
            "Initialized (%s) in %dms — %d notes",
            path_type,
            duration_ms,
            len(notes),
        )

        return {
            "path": path_type,
            "mode": self._mode,
            "degraded_reason": self._degraded_reason,
            "duration_ms": duration_ms,
            "note_count": len(notes),
            "note_cache": self.note_cache,
        }

    # ------------------------------------------------------------------
    # Retrieve
    # ------------------------------------------------------------------

    def retrieve(self, query: str, top_k: Optional[int] = None, workspace: Optional[str] = None) -> dict[str, Any]:
        """Run hybrid retrieval: vector seeds + graph expansion, with keyword fallback.

        If workspace is set, only notes from that workspace are returned.
        """
        k = top_k or self.top_k
        seed_notes: list[RetrievedNote] = []
        expanded_notes: list[RetrievedNote] = []

        # Try vector retrieval first
        if self.index is not None:
            try:
                from .retriever import ObsidiClawRetriever

                retriever = ObsidiClawRetriever(
                    index=self.index,
                    graph_store=self.graph_store,
                    embed_model=self.embed_model,
                    parsed_notes=self._parsed_notes,
                    similarity_top_k=k,
                )
                seed_notes, expanded_notes = retriever.retrieve(query, workspace=workspace)
            except Exception as exc:
                log.warning("Vector retrieval failed, falling back to keyword: %s", exc)
                seed_notes = []
                expanded_notes = []

        # Fallback to keyword retrieval if vector produced no results
        if not seed_notes and self.keyword_retriever is not None:
            seed_notes = self.keyword_retriever.retrieve(query, top_k=k)
            expanded_notes = self._expand_via_graph(seed_notes)

        return {
            "seed_notes": [self._note_to_dict(n) for n in seed_notes],
            "expanded_notes": [self._note_to_dict(n) for n in expanded_notes],
        }

    # ------------------------------------------------------------------
    # Graph expansion (reusable)
    # ------------------------------------------------------------------

    def _expand_via_graph(self, seed_notes: list[RetrievedNote]) -> list[RetrievedNote]:
        """Expand seed notes via graph store (depth-1 neighbors)."""
        if not self.graph_store or not seed_notes:
            return []

        from .retriever import NEIGHBOR_SCORE_DECAY

        seed_ids = {n.note_id for n in seed_notes}
        seed_scores = {n.note_id: n.score for n in seed_notes}
        expanded: list[RetrievedNote] = []
        expanded_ids: set[str] = set()

        for seed in seed_notes:
            try:
                triplets = self.graph_store.get_triplets(entity_names=[seed.note_id])
            except Exception as exc:
                log.warning("get_triplets failed for %s: %s", seed.note_id, exc)
                continue

            for source_node, _relation, target_node in triplets:
                source_name = getattr(source_node, "name", "")
                target_name = getattr(target_node, "name", "")
                neighbor_id = target_name if source_name == seed.note_id else source_name

                if neighbor_id in seed_ids or neighbor_id in expanded_ids:
                    continue

                parsed = self._parsed_notes.get(neighbor_id)
                if not parsed or parsed.note_type == "index":
                    continue

                parent_score = seed_scores.get(seed.note_id, 0.5)
                neighbor_score = parent_score * NEIGHBOR_SCORE_DECAY

                expanded.append(
                    RetrievedNote(
                        note_id=neighbor_id,
                        path=neighbor_id,
                        content=parsed.body,
                        score=neighbor_score,
                        type=parsed.note_type,
                        tool_id=parsed.tool_id,
                        tags=parsed.tags,
                        retrieval_source="graph",
                        linked_from=[seed.note_id],
                        depth=1,
                    )
                )
                expanded_ids.add(neighbor_id)

        expanded.sort(key=lambda n: n.score, reverse=True)
        return expanded

    # ------------------------------------------------------------------
    # Note content
    # ------------------------------------------------------------------

    def get_note_content(self, relative_path: str) -> Optional[str]:
        """Get cached note body by relative path."""
        return self.note_cache.get(relative_path)

    # ------------------------------------------------------------------
    # Reindex
    # ------------------------------------------------------------------

    def reindex(self) -> dict[str, Any]:
        """Re-scan md_db and rebuild if changed."""
        if not self.md_db_path:
            raise RuntimeError("Engine not initialized")

        t0 = time.time()
        current_hash = compute_md_db_hash(self.md_db_path)
        hash_path = os.path.join(self.db_dir, ".md_db_hash")
        stored_hash = ""
        if os.path.exists(hash_path):
            stored_hash = Path(hash_path).read_text().strip()

        if current_hash == stored_hash:
            return {
                "skipped": True,
                "duration_ms": int((time.time() - t0) * 1000),
                "note_count": len(self.note_cache),
                "note_cache": self.note_cache,
            }

        # Always re-scan notes and rebuild graph + keyword retriever
        notes = _scan_md_db(self.md_db_path)
        notes_by_id = {n.note_id: n for n in notes}
        self._parsed_notes = notes_by_id
        self.graph_store = _build_graph_store(notes, notes_by_id)
        self.graph_store.persist(
            persist_path=os.path.join(self.db_dir, "property_graph_store.json")
        )
        self.keyword_retriever = KeywordRetriever(notes_by_id)
        self.note_cache = {n.note_id: n.body for n in notes}

        # Rebuild vector index if we have an embedding model
        if self.embed_model is not None:
            try:
                from .indexer import _build_vector_index
                self.index = _build_vector_index(notes, self.embed_model, self.db_dir)
                self._mode = "full"
                self._degraded_reason = ""
            except Exception as exc:
                log.warning("Vector index rebuild failed: %s", exc)
                self.index = None
                self._mode = "degraded"
                self._degraded_reason = f"Vector index rebuild failed: {exc}"

        # Update hash
        Path(hash_path).write_text(current_hash)

        duration_ms = int((time.time() - t0) * 1000)
        return {
            "skipped": False,
            "duration_ms": duration_ms,
            "note_count": len(notes),
            "note_cache": self.note_cache,
        }

    # ------------------------------------------------------------------
    # Incremental update
    # ------------------------------------------------------------------

    def incremental_update(
        self,
        changed_paths: list[str],
        deleted_paths: list[str],
    ) -> dict[str, Any]:
        """Update only the notes that changed/were added/deleted.

        changed_paths: relative paths within md_db of files that were
                       added or modified (re-parsed and re-embedded).
        deleted_paths: relative paths of files that were removed.

        Returns update metadata for the TS bridge.
        """
        if not self.md_db_path:
            raise RuntimeError("Engine not initialized")

        t0 = time.time()
        added = 0
        updated = 0
        removed = 0

        # ── Handle deletions ─────────────────────────────────────────────
        for rel_path in deleted_paths:
            if rel_path not in self._parsed_notes:
                continue
            self._remove_note(rel_path)
            removed += 1

        # ── Handle additions/modifications ───────────────────────────────
        from .markdown_utils import (
            extract_tags,
            extract_title,
            extract_workspace,
            extract_wikilinks,
            infer_note_type,
            parse_frontmatter,
        )

        new_notes: list[ParsedNote] = []
        for rel_path in changed_paths:
            abs_path = os.path.join(self.md_db_path, rel_path.replace("/", os.sep))
            if not os.path.isfile(abs_path):
                # File listed as changed but doesn't exist — treat as delete
                if rel_path in self._parsed_notes:
                    self._remove_note(rel_path)
                    removed += 1
                continue

            try:
                content = Path(abs_path).read_text(encoding="utf-8")
            except Exception as exc:
                log.warning("Failed to read %s: %s", abs_path, exc)
                continue

            frontmatter, body = parse_frontmatter(content)
            new_hash = _content_hash(body)

            # Skip if content hasn't actually changed
            if rel_path in self._note_hashes and self._note_hashes[rel_path] == new_hash:
                continue

            note_type = infer_note_type(frontmatter, rel_path)
            title = extract_title(frontmatter, body, rel_path)
            tags = extract_tags(frontmatter)
            links = extract_wikilinks(body)

            tool_id: Optional[str] = None
            if note_type == "tool":
                tool_id = str(frontmatter.get("tool_id") or Path(rel_path).stem)

            note = ParsedNote(
                note_id=rel_path,
                path=rel_path,
                title=title,
                note_type=note_type,  # type: ignore[arg-type]
                body=body,
                frontmatter=frontmatter,
                links_out=links,
                tool_id=tool_id,
                time_created=None,
                last_edited=None,
                tags=tags,
                workspace=extract_workspace(frontmatter),
            )

            is_new = rel_path not in self._parsed_notes
            new_notes.append(note)

            # Update in-memory state
            self._parsed_notes[rel_path] = note
            self.note_cache[rel_path] = body
            self._note_hashes[rel_path] = new_hash

            # Update vector index
            if self.index is not None:
                text_node = TextNode(
                    text=f"{title}\n\n{body}",
                    id_=rel_path,
                    metadata={
                        "file_path": rel_path,
                        "note_type": note_type,
                        "title": title,
                        "tool_id": tool_id or "",
                        "tags": ",".join(tags),
                        "workspace": note.workspace,
                    },
                )
                doc = Document(text=f"{title}\n\n{body}", id_=rel_path)
                if is_new:
                    self.index.insert_nodes([text_node])
                    added += 1
                else:
                    # update_ref_doc deletes old nodes then inserts new
                    self.index.update_ref_doc(doc)
                    updated += 1
            else:
                if is_new:
                    added += 1
                else:
                    updated += 1

        # ── Rebuild graph store (cheap — no embeddings) ──────────────────
        # Graph edges depend on cross-note wikilinks, so after any note
        # changes we rebuild the full graph. This is fast (~10ms for 70
        # notes) since it's just in-memory data structure manipulation.
        if added + updated + removed > 0:
            all_notes = list(self._parsed_notes.values())
            self.graph_store = _build_graph_store(all_notes, self._parsed_notes)
            self.graph_store.persist(
                persist_path=os.path.join(self.db_dir, "property_graph_store.json")
            )
            self.keyword_retriever = KeywordRetriever(self._parsed_notes)

            # Persist vector index if it exists
            if self.index is not None:
                self.index.storage_context.persist(persist_dir=self.db_dir)

        duration_ms = int((time.time() - t0) * 1000)
        total = added + updated + removed
        log.info(
            "Incremental update: +%d ~%d -%d (%d total) in %dms",
            added, updated, removed, total, duration_ms,
        )

        return {
            "added": added,
            "updated": updated,
            "removed": removed,
            "duration_ms": duration_ms,
            "note_count": len(self._parsed_notes),
            "note_cache": self.note_cache,
        }

    def _remove_note(self, note_id: str) -> None:
        """Remove a single note from all in-memory structures."""
        self._parsed_notes.pop(note_id, None)
        self.note_cache.pop(note_id, None)
        self._note_hashes.pop(note_id, None)

        # Remove from vector index
        if self.index is not None:
            try:
                self.index.delete_ref_doc(note_id, delete_from_docstore=True)
            except Exception as exc:
                log.warning("Failed to delete %s from vector index: %s", note_id, exc)

    # ------------------------------------------------------------------
    # Graph stats
    # ------------------------------------------------------------------

    def get_graph_stats(self) -> dict[str, Any]:
        """Return basic graph statistics."""
        if self.graph_store is None:
            return {"note_count": 0, "edge_count": 0, "index_loaded": False}

        # Count edges from the internal graph data
        edge_count = 0
        if hasattr(self.graph_store, 'graph') and hasattr(self.graph_store.graph, 'relations'):
            for rels in self.graph_store.graph.relations.values():
                edge_count += len(rels) if isinstance(rels, list) else 1

        return {
            "note_count": len(self._parsed_notes),
            "edge_count": edge_count,
            "index_loaded": self.index is not None,
        }

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _has_persisted_index(self) -> bool:
        """Check if persisted index files exist on disk."""
        return (
            os.path.exists(os.path.join(self.db_dir, "property_graph_store.json"))
            and os.path.exists(os.path.join(self.db_dir, "docstore.json"))
        )

    def _build_or_load_vector_index(
        self,
        notes: list[ParsedNote],
        notes_by_id: dict[str, ParsedNote],
        embed_model: Any,
    ) -> None:
        """Hash-based fast/slow path for vector index."""
        current_hash = compute_md_db_hash(self.md_db_path)
        hash_path = os.path.join(self.db_dir, ".md_db_hash")
        stored_hash = ""
        if os.path.exists(hash_path):
            stored_hash = Path(hash_path).read_text().strip()

        if current_hash == stored_hash and self._has_persisted_index():
            # Fast path: load from disk
            self.index = self._load_vector_index_only(embed_model)
            log.info("Loaded vector index from cache (fast path)")
        else:
            # Slow path: full rebuild
            from .indexer import _build_vector_index
            self.index = _build_vector_index(notes, embed_model, self.db_dir)
            Path(hash_path).write_text(current_hash)
            log.info("Built vector index (slow path)")

    def _load_vector_index_only(self, embed_model: Any) -> VectorStoreIndex:
        """Load persisted VectorStoreIndex from disk."""
        from llama_index.core import StorageContext, load_index_from_storage

        storage_context = StorageContext.from_defaults(persist_dir=self.db_dir)
        return load_index_from_storage(
            storage_context=storage_context,
            embed_model=embed_model,
        )

    @staticmethod
    def _note_to_dict(note: RetrievedNote) -> dict[str, Any]:
        return {
            "noteId": note.note_id,
            "path": note.path,
            "content": note.content,
            "score": note.score,
            "type": note.type,
            "toolId": note.tool_id,
            "tags": note.tags,
            "retrievalSource": note.retrieval_source,
            "linkedFrom": note.linked_from,
            "depth": note.depth,
            "workspace": note.workspace,
        }
