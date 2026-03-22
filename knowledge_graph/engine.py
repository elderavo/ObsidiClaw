"""KnowledgeGraphEngine — VectorStoreIndex + graph store lifecycle management.

Owns the vector index, embedding model, graph store, and persistence directory.
Called by the JSON-RPC server handlers.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

from llama_index.core import VectorStoreIndex, Settings
from llama_index.core.graph_stores import SimplePropertyGraphStore
from llama_index.embeddings.ollama import OllamaEmbedding
from llama_index.llms.ollama import Ollama

from .indexer import build_index, load_index
from .markdown_utils import compute_md_db_hash
from .models import ParsedNote, RetrievedNote

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class KnowledgeGraphEngine:
    """Manages VectorStoreIndex + SimplePropertyGraphStore for hybrid retrieval."""

    def __init__(self) -> None:
        self.index: Optional[VectorStoreIndex] = None
        self.embed_model: Optional[OllamaEmbedding] = None
        self.graph_store: Optional[SimplePropertyGraphStore] = None

        # Config (set during initialize)
        self.md_db_path: str = ""
        self.db_dir: str = ""
        self.ollama_host: str = ""
        self.embed_model_name: str = ""
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
        ollama_host: str,
        embed_model: str = "nomic-embed-text:v1.5",
        top_k: int = 8,
    ) -> dict[str, Any]:
        """Boot the engine: build or load VectorStoreIndex + graph store.

        Returns init metadata for the TS bridge.
        """
        t0 = time.time()
        self.md_db_path = md_db_path
        self.db_dir = db_dir
        self.ollama_host = ollama_host
        self.embed_model_name = embed_model
        self.top_k = top_k

        # Ensure persistence dir exists
        os.makedirs(db_dir, exist_ok=True)

        # Create embedding model and set global LLM (prevents OpenAI fallback)
        self.embed_model = OllamaEmbedding(
            model_name=embed_model,
            base_url=ollama_host,
        )
        Settings.llm = Ollama(model="cogito:8b", base_url=ollama_host)
        Settings.embed_model = self.embed_model

        # Hash-based fast/slow path
        current_hash = compute_md_db_hash(md_db_path)
        hash_path = os.path.join(db_dir, ".md_db_hash")
        stored_hash = ""
        if os.path.exists(hash_path):
            stored_hash = Path(hash_path).read_text().strip()

        if current_hash == stored_hash and self._has_persisted_index():
            # Fast path: load from disk
            path_type = "fast"
            self.index, self.graph_store, parsed_notes = load_index(
                db_dir=db_dir,
                embed_model=self.embed_model,
                md_db_path=md_db_path,
            )
            self._parsed_notes = {n.note_id: n for n in parsed_notes}
        else:
            # Slow path: full rebuild
            path_type = "slow"
            self.index, self.graph_store, parsed_notes = build_index(
                md_db_path=md_db_path,
                db_dir=db_dir,
                embed_model=self.embed_model,
            )
            self._parsed_notes = {n.note_id: n for n in parsed_notes}
            # Write hash
            Path(hash_path).write_text(current_hash)

        # Build note cache
        self.note_cache = {
            n.note_id: n.body for n in parsed_notes
        }

        duration_ms = int((time.time() - t0) * 1000)
        log.info(
            "Initialized (%s path) in %dms — %d notes",
            path_type,
            duration_ms,
            len(parsed_notes),
        )

        return {
            "path": path_type,
            "duration_ms": duration_ms,
            "note_count": len(parsed_notes),
            "note_cache": self.note_cache,
        }

    # ------------------------------------------------------------------
    # Retrieve
    # ------------------------------------------------------------------

    def retrieve(self, query: str, top_k: Optional[int] = None) -> dict[str, Any]:
        """Run hybrid retrieval: vector seeds + graph expansion."""
        if self.index is None:
            raise RuntimeError("Engine not initialized")

        from .retriever import ObsidiClawRetriever

        k = top_k or self.top_k
        retriever = ObsidiClawRetriever(
            index=self.index,
            graph_store=self.graph_store,
            embed_model=self.embed_model,
            parsed_notes=self._parsed_notes,
            similarity_top_k=k,
        )

        seed_notes, expanded_notes = retriever.retrieve(query)

        return {
            "seed_notes": [self._note_to_dict(n) for n in seed_notes],
            "expanded_notes": [self._note_to_dict(n) for n in expanded_notes],
        }

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

        # Full rebuild
        self.index, self.graph_store, parsed_notes = build_index(
            md_db_path=self.md_db_path,
            db_dir=self.db_dir,
            embed_model=self.embed_model,
        )
        self._parsed_notes = {n.note_id: n for n in parsed_notes}
        self.note_cache = {n.note_id: n.body for n in parsed_notes}

        # Update hash
        Path(hash_path).write_text(current_hash)

        duration_ms = int((time.time() - t0) * 1000)
        return {
            "skipped": False,
            "duration_ms": duration_ms,
            "note_count": len(parsed_notes),
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
