"""KnowledgeGraphEngine — VectorStoreIndex + graph store lifecycle management.

Owns the vector index, embedding model, graph store, and persistence directory.
Called by the JSON-RPC server handlers.

Supports graceful degradation:
  - "full" mode: vector embeddings + graph + keyword (all available)
  - "degraded" mode: graph + keyword only (embedding provider unavailable or set to "local")
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

from llama_index.core import VectorStoreIndex, Settings
from llama_index.core.graph_stores import SimplePropertyGraphStore

from .indexer import build_index, load_index, _scan_md_db, _build_graph_store
from .keyword_retriever import KeywordRetriever
from .markdown_utils import compute_md_db_hash
from .models import ParsedNote, RetrievedNote
from .providers import get_embed_config, check_reachable, create_embedding

log = logging.getLogger(__name__)

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

        # ── Step 4: Build note cache (always) ───────────────────────────
        self.note_cache = {n.note_id: n.body for n in notes}

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

    def retrieve(self, query: str, top_k: Optional[int] = None) -> dict[str, Any]:
        """Run hybrid retrieval: vector seeds + graph expansion, with keyword fallback."""
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
                seed_notes, expanded_notes = retriever.retrieve(query)
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
        }
