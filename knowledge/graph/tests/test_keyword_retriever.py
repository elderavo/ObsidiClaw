"""Tests for KeywordRetriever — scoring, filtering, ranking, normalization."""

import unittest

from knowledge.graph.keyword_retriever import KeywordRetriever
from knowledge.graph.models import ParsedNote


def _note(note_id, title="", tags=None, body="", workspace="", note_type="concept"):
    return ParsedNote(
        note_id=note_id,
        path=note_id,
        title=title,
        note_type=note_type,
        body=body,
        frontmatter={},
        links_out=[],
        tags=tags or [],
        workspace=workspace,
    )


class KeywordRetrieverScoringTests(unittest.TestCase):
    def test_title_match_returns_result(self):
        notes = {"a": _note("a", title="Attention Transformers")}
        kr = KeywordRetriever(notes)
        results = kr.retrieve("attention")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].note_id, "a")

    def test_tag_match_returns_result(self):
        notes = {"a": _note("a", title="Unrelated", tags=["transformers"])}
        kr = KeywordRetriever(notes)
        results = kr.retrieve("transformers")
        self.assertEqual(len(results), 1)

    def test_body_match_returns_result(self):
        notes = {"a": _note("a", title="Unrelated", body="The attention mechanism is key.")}
        kr = KeywordRetriever(notes)
        results = kr.retrieve("attention")
        self.assertEqual(len(results), 1)

    def test_no_match_returns_empty(self):
        notes = {"a": _note("a", title="Apple", body="fruit")}
        kr = KeywordRetriever(notes)
        self.assertEqual(kr.retrieve("quantum"), [])

    def test_empty_query_returns_empty(self):
        notes = {"a": _note("a", title="Something")}
        kr = KeywordRetriever(notes)
        self.assertEqual(kr.retrieve(""), [])

    def test_best_score_is_normalized_to_1(self):
        notes = {
            "a": _note("a", title="Attention"),
            "b": _note("b", title="Residual Connections", body="attention"),
        }
        kr = KeywordRetriever(notes)
        results = kr.retrieve("attention")
        scores = [r.score for r in results]
        self.assertAlmostEqual(max(scores), 1.0, places=5)

    def test_title_match_scores_higher_than_body_only(self):
        notes = {
            "title_match": _note("title_match", title="Backpropagation"),
            "body_match": _note("body_match", title="Gradients", body="backpropagation is used here"),
        }
        kr = KeywordRetriever(notes)
        results = kr.retrieve("backpropagation")
        by_id = {r.note_id: r.score for r in results}
        self.assertGreater(by_id["title_match"], by_id["body_match"])

    def test_top_k_limits_results(self):
        notes = {f"note_{i}": _note(f"note_{i}", title=f"machine learning {i}") for i in range(10)}
        kr = KeywordRetriever(notes)
        results = kr.retrieve("machine", top_k=3)
        self.assertLessEqual(len(results), 3)

    def test_results_sorted_descending_by_score(self):
        notes = {
            "a": _note("a", title="FFN Transformer", tags=["transformer"]),
            "b": _note("b", title="Attention", tags=["transformer"]),
            "c": _note("c", title="Skip Connection", body="transformer related"),
        }
        kr = KeywordRetriever(notes)
        results = kr.retrieve("transformer")
        scores = [r.score for r in results]
        self.assertEqual(scores, sorted(scores, reverse=True))

    def test_index_notes_excluded(self):
        notes = {
            "idx": _note("idx", title="index", note_type="index"),
            "real": _note("real", title="index content note"),
        }
        kr = KeywordRetriever(notes)
        results = kr.retrieve("index")
        ids = {r.note_id for r in results}
        self.assertNotIn("idx", ids)
        self.assertIn("real", ids)


class KeywordRetrieverWorkspaceFilterTests(unittest.TestCase):
    def test_workspace_filter_excludes_other_workspace(self):
        notes = {
            "a": _note("a", title="Attention", workspace="proj-a"),
            "b": _note("b", title="Attention Transform", workspace="proj-b"),
        }
        kr = KeywordRetriever(notes)
        results = kr.retrieve("attention", workspace="proj-a")
        ids = {r.note_id for r in results}
        self.assertIn("a", ids)
        self.assertNotIn("b", ids)

    def test_no_workspace_returns_all(self):
        notes = {
            "a": _note("a", title="Attention", workspace="proj-a"),
            "b": _note("b", title="Attention", workspace="proj-b"),
        }
        kr = KeywordRetriever(notes)
        results = kr.retrieve("attention")
        ids = {r.note_id for r in results}
        self.assertEqual(ids, {"a", "b"})

    def test_workspace_filter_no_match_returns_empty(self):
        notes = {"a": _note("a", title="Attention", workspace="proj-a")}
        kr = KeywordRetriever(notes)
        self.assertEqual(kr.retrieve("attention", workspace="proj-z"), [])

    def test_retrieved_note_has_correct_workspace(self):
        notes = {"a": _note("a", title="Attention", workspace="my-ws")}
        kr = KeywordRetriever(notes)
        results = kr.retrieve("attention", workspace="my-ws")
        self.assertEqual(results[0].workspace, "my-ws")

    def test_retrieved_note_retrieval_source_is_keyword(self):
        notes = {"a": _note("a", title="Attention")}
        kr = KeywordRetriever(notes)
        results = kr.retrieve("attention")
        self.assertEqual(results[0].retrieval_source, "keyword")


if __name__ == "__main__":
    unittest.main()
