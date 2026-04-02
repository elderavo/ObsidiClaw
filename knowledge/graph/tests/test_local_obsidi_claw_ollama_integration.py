from __future__ import annotations

import os
import shutil
import unittest
import uuid
from pathlib import Path

from knowledge.graph.indexer import load_index
from knowledge.graph.keyword_retriever import KeywordRetriever
from knowledge.graph.providers import check_reachable, create_embedding, get_embed_config
from knowledge.graph.retriever import ObsidiClawRetriever


def _make_tmp_dir() -> Path:
    override = os.environ.get("OBSIDICLAW_TEST_TMPDIR", "").strip()
    if override:
        base = Path(override)
    else:
        base = Path.home() / ".codex" / "memories" / "obsidiclaw_local_integration_tmp"
    base.mkdir(parents=True, exist_ok=True)
    d = base / f"t{uuid.uuid4().hex}"
    d.mkdir(parents=True, exist_ok=False)
    return d


def _repo_root() -> Path:
    """Find repo root (directory that contains `.obsidi-claw`)."""
    here = Path(__file__).resolve()
    for p in [here.parent, *here.parents]:
        if (p / ".obsidi-claw").is_dir():
            return p
    # Fallback: current working directory
    return Path.cwd().resolve()


class LocalObsidiClawOllamaIntegrationTests(unittest.TestCase):
    """Local-only integration test: load persisted index + query via real Ollama.

    Key constraint: MUST NOT mutate `.obsidi-claw/knowledge_graph`.
    So we copy the persisted directory into a temp folder and load from there.
    """

    def test_load_persisted_index_and_query_via_ollama(self):
        root = _repo_root()
        src_db_dir = root / ".obsidi-claw" / "knowledge_graph"
        required = [
            src_db_dir / "property_graph_store.json",
            src_db_dir / "docstore.json",
        ]
        if not all(p.exists() for p in required):
            self.skipTest("missing local persisted knowledge graph under .obsidi-claw/knowledge_graph")

        prev_env = dict(os.environ)
        tmp_root: Path | None = None
        try:
            os.environ["OBSIDI_EMBED_PROVIDER"] = "ollama"
            os.environ.setdefault("OBSIDI_EMBED_HOST", "http://localhost:11434")
            os.environ.setdefault("OBSIDI_EMBED_MODEL", "nomic-embed-text:latest")

            cfg = get_embed_config()
            if not check_reachable(cfg):
                self.skipTest("ollama embedding provider not reachable (expected at OBSIDI_EMBED_HOST)")

            embed_model = create_embedding(cfg)
            if embed_model is None:
                self.skipTest("failed to create embedding model for ollama config")

            tmp_root = _make_tmp_dir()
            tmp_db_dir = tmp_root / "knowledge_graph"
            shutil.copytree(src_db_dir, tmp_db_dir)

            md_db_path = str(root / "md_db")
            vector_index, graph_store, notes = load_index(
                db_dir=str(tmp_db_dir),
                embed_model=embed_model,
                md_db_path=md_db_path,
            )
            notes_by_id = {n.note_id: n for n in notes}

            # Sanity: we can still build keyword retriever from the scanned notes.
            kr = KeywordRetriever(notes_by_id)
            self.assertIsNotNone(kr)

            # Real vector retrieval (no engine fallback).
            retriever = ObsidiClawRetriever(
                index=vector_index,
                graph_store=graph_store,
                embed_model=embed_model,
                parsed_notes=notes_by_id,
                similarity_top_k=5,
            )

            # Use a query that should strongly match at least one note.
            query = notes[0].title if notes else "obsidiclaw"
            seeds, expanded = retriever.retrieve(query)

            self.assertGreater(len(seeds), 0)
            self.assertTrue(all(s.retrieval_source == "vector" for s in seeds))
            # Expanded may be empty depending on graph connectivity; just ensure it returns a list.
            self.assertIsInstance(expanded, list)

        finally:
            os.environ.clear()
            os.environ.update(prev_env)
            if tmp_root is not None:
                shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
