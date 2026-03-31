"""Tests for KnowledgeGraphEngine — incremental update, endpoint resolution, degraded retrieval."""

import os
import tempfile
import unittest

from knowledge.graph.engine import KnowledgeGraphEngine
from knowledge.graph.models import ParsedNote, RetrievedNote


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_note(md_db_path: str, rel_path: str, content: str) -> None:
    abs_path = os.path.join(md_db_path, rel_path.replace("/", os.sep))
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)
    with open(abs_path, "w", encoding="utf-8") as f:
        f.write(content)


def _remove_note(md_db_path: str, rel_path: str) -> None:
    abs_path = os.path.join(md_db_path, rel_path.replace("/", os.sep))
    if os.path.exists(abs_path):
        os.remove(abs_path)


def _blank_engine(md_db_path: str, db_dir: str) -> KnowledgeGraphEngine:
    """Engine pre-seeded with md_db_path and db_dir but no vector index."""
    engine = KnowledgeGraphEngine()
    engine.md_db_path = md_db_path
    engine.db_dir = db_dir
    engine.graph_store = None
    engine._parsed_notes = {}
    engine.note_cache = {}
    engine._note_hashes = {}
    engine._embed_context_length = 8192

    # Keyword retriever initialised with empty notes
    from knowledge.graph.keyword_retriever import KeywordRetriever
    engine.keyword_retriever = KeywordRetriever({})

    return engine


def _parsed(note_id, title="", body="", workspace="", tags=None):
    return ParsedNote(
        note_id=note_id,
        path=note_id,
        title=title or note_id,
        note_type="concept",
        body=body,
        frontmatter={},
        links_out=[],
        tags=tags or [],
        workspace=workspace,
    )


# ---------------------------------------------------------------------------
# Incremental update — add / update / delete / hash dedup
# ---------------------------------------------------------------------------


class IncrementalUpdateTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.md_db = self._tmp.name
        self.db_dir = os.path.join(self._tmp.name, ".db")
        os.makedirs(self.db_dir, exist_ok=True)
        self.engine = _blank_engine(self.md_db, self.db_dir)

    def tearDown(self):
        self._tmp.cleanup()

    # ── Add ──────────────────────────────────────────────────────────────────

    def test_add_new_note_updates_parsed_notes(self):
        _write_note(self.md_db, "concepts/foo.md", "# Foo\n\nbody of foo")
        result = self.engine.incremental_update(["concepts/foo.md"], [])
        self.assertEqual(result["added"], 1)
        self.assertIn("concepts/foo.md", self.engine._parsed_notes)

    def test_add_updates_note_cache(self):
        _write_note(self.md_db, "concepts/bar.md", "# Bar\n\nbody of bar")
        self.engine.incremental_update(["concepts/bar.md"], [])
        self.assertIn("concepts/bar.md", self.engine.note_cache)

    def test_add_keyword_retriever_reflects_new_note(self):
        _write_note(self.md_db, "concepts/baz.md", "# Baz\n\nquantum computing")
        self.engine.incremental_update(["concepts/baz.md"], [])
        results = self.engine.keyword_retriever.retrieve("quantum")
        ids = [r.note_id for r in results]
        self.assertIn("concepts/baz.md", ids)

    # ── Update ───────────────────────────────────────────────────────────────

    def test_update_changed_body_counted_as_updated(self):
        _write_note(self.md_db, "concepts/upd.md", "# Upd\n\noriginal body")
        self.engine.incremental_update(["concepts/upd.md"], [])
        _write_note(self.md_db, "concepts/upd.md", "# Upd\n\nnew body with more content")
        result = self.engine.incremental_update(["concepts/upd.md"], [])
        self.assertEqual(result["updated"], 1)
        self.assertEqual(result["added"], 0)

    def test_update_reflects_new_body_in_cache(self):
        _write_note(self.md_db, "concepts/upd2.md", "# X\n\nold")
        self.engine.incremental_update(["concepts/upd2.md"], [])
        _write_note(self.md_db, "concepts/upd2.md", "# X\n\nnew content")
        self.engine.incremental_update(["concepts/upd2.md"], [])
        self.assertIn("new content", self.engine.note_cache.get("concepts/upd2.md", ""))

    # ── Hash dedup ────────────────────────────────────────────────────────────

    def test_unchanged_body_skipped(self):
        content = "# Same\n\nsame body"
        _write_note(self.md_db, "concepts/same.md", content)
        self.engine.incremental_update(["concepts/same.md"], [])
        # Second call with same content should be a no-op
        result = self.engine.incremental_update(["concepts/same.md"], [])
        self.assertEqual(result["added"], 0)
        self.assertEqual(result["updated"], 0)

    def test_frontmatter_only_change_skipped(self):
        """Changing only frontmatter (body unchanged) must not trigger re-index."""
        body = "same body content"
        _write_note(self.md_db, "concepts/fm.md", f"---\ntitle: T\n---\n{body}")
        self.engine.incremental_update(["concepts/fm.md"], [])
        # Change only frontmatter, keep body identical
        _write_note(self.md_db, "concepts/fm.md", f"---\ntitle: T2\n---\n{body}")
        result = self.engine.incremental_update(["concepts/fm.md"], [])
        self.assertEqual(result["added"] + result["updated"], 0)

    # ── Delete ───────────────────────────────────────────────────────────────

    def test_delete_removes_from_parsed_notes(self):
        _write_note(self.md_db, "concepts/del.md", "# Del\n\nbody")
        self.engine.incremental_update(["concepts/del.md"], [])
        self.assertIn("concepts/del.md", self.engine._parsed_notes)
        self.engine.incremental_update([], ["concepts/del.md"])
        self.assertNotIn("concepts/del.md", self.engine._parsed_notes)

    def test_delete_removes_from_cache(self):
        _write_note(self.md_db, "concepts/del2.md", "# Del2\n\nbody")
        self.engine.incremental_update(["concepts/del2.md"], [])
        self.engine.incremental_update([], ["concepts/del2.md"])
        self.assertNotIn("concepts/del2.md", self.engine.note_cache)

    def test_delete_nonexistent_note_is_noop(self):
        result = self.engine.incremental_update([], ["concepts/ghost.md"])
        self.assertEqual(result["removed"], 0)

    def test_changed_path_not_on_disk_treated_as_delete(self):
        _write_note(self.md_db, "concepts/vanish.md", "# V\n\nbody")
        self.engine.incremental_update(["concepts/vanish.md"], [])
        # File disappears before second call
        _remove_note(self.md_db, "concepts/vanish.md")
        self.engine.incremental_update(["concepts/vanish.md"], [])
        self.assertNotIn("concepts/vanish.md", self.engine._parsed_notes)


# ---------------------------------------------------------------------------
# _resolve_endpoint
# ---------------------------------------------------------------------------


class ResolveEndpointTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.engine = _blank_engine(self._tmp.name, os.path.join(self._tmp.name, ".db"))
        self.engine._parsed_notes = {
            "code/ws/engine/context-engine.ts.md": _parsed(
                "code/ws/engine/context-engine.ts.md",
                title="ContextEngine",
            ),
            "concepts/ws/rag.md": _parsed("concepts/ws/rag.md", title="RAG"),
        }
        from knowledge.graph.keyword_retriever import KeywordRetriever
        self.engine.keyword_retriever = KeywordRetriever(self.engine._parsed_notes)

    def tearDown(self):
        self._tmp.cleanup()

    def test_exact_match(self):
        note_id, method = self.engine._resolve_endpoint("concepts/ws/rag.md")
        self.assertEqual(note_id, "concepts/ws/rag.md")
        self.assertEqual(method, "exact")

    def test_partial_path_match(self):
        note_id, method = self.engine._resolve_endpoint("context-engine.ts")
        self.assertIsNotNone(note_id)
        self.assertEqual(method, "exact")
        self.assertIn("context-engine.ts", note_id)

    def test_keyword_fallback(self):
        # No exact match, no vector index — should fall to keyword
        note_id, method = self.engine._resolve_endpoint("RAG retrieval")
        self.assertIsNotNone(note_id)
        self.assertEqual(method, "keyword")

    def test_unresolvable_query_returns_none(self):
        note_id, method = self.engine._resolve_endpoint("zzz-no-match-xyz")
        self.assertIsNone(note_id)
        self.assertEqual(method, "none")


# ---------------------------------------------------------------------------
# retrieve — degraded mode (keyword path)
# ---------------------------------------------------------------------------


class DegradedModeRetrieveTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.engine = _blank_engine(self._tmp.name, os.path.join(self._tmp.name, ".db"))
        notes = {
            "concepts/ws/attention.md": _parsed(
                "concepts/ws/attention.md",
                title="Attention Transformers",
                body="Q K V weight matrices",
                workspace="ws",
            ),
            "concepts/ws/ffn.md": _parsed(
                "concepts/ws/ffn.md",
                title="FFN Layer",
                body="feed-forward network transformer",
                workspace="ws",
            ),
        }
        self.engine._parsed_notes = notes
        from knowledge.graph.keyword_retriever import KeywordRetriever
        self.engine.keyword_retriever = KeywordRetriever(notes)

    def tearDown(self):
        self._tmp.cleanup()

    def test_retrieves_by_keyword_when_no_index(self):
        out = self.engine.retrieve("attention")
        self.assertGreater(len(out["seed_notes"]), 0)
        ids = [n["noteId"] for n in out["seed_notes"]]
        self.assertIn("concepts/ws/attention.md", ids)

    def test_workspace_filter_applied(self):
        out = self.engine.retrieve("attention", workspace="ws")
        for note in out["seed_notes"]:
            self.assertEqual(note["workspace"], "ws")

    def test_workspace_filter_excludes_other_workspace(self):
        from knowledge.graph.keyword_retriever import KeywordRetriever
        extra = {
            "concepts/other/attention.md": _parsed(
                "concepts/other/attention.md",
                title="Attention",
                workspace="other",
            ),
            **self.engine._parsed_notes,
        }
        self.engine._parsed_notes = extra
        self.engine.keyword_retriever = KeywordRetriever(extra)

        out = self.engine.retrieve("attention", workspace="ws")
        for note in out["seed_notes"]:
            self.assertNotEqual(note["workspace"], "other")

    def test_result_dict_has_required_keys(self):
        out = self.engine.retrieve("attention")
        self.assertIn("seed_notes", out)
        self.assertIn("expanded_notes", out)
        if out["seed_notes"]:
            note = out["seed_notes"][0]
            for key in ("noteId", "path", "content", "score", "type", "workspace"):
                self.assertIn(key, note)

    def test_empty_query_returns_empty(self):
        out = self.engine.retrieve("")
        self.assertEqual(len(out["seed_notes"]), 0)


if __name__ == "__main__":
    unittest.main()
