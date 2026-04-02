"""Tests for retriever — tag boost, edge skip heuristics, graph expansion."""

import unittest

from knowledge.graph.models import ParsedNote, RetrievedNote
from knowledge.graph.retriever import (
    _apply_tag_boost,
    _should_skip_edge,
    expand_graph_neighbors,
    DOWN_SEED_THRESHOLD,
    TAG_BOOST_PER_TAG,
    TAG_BOOST_MAX,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parsed(note_id, tags=None, note_type="concept", tier="", workspace="ws"):
    return ParsedNote(
        note_id=note_id,
        path=note_id,
        title=note_id.split("/")[-1],
        note_type=note_type,
        body="body",
        frontmatter={},
        links_out=[],
        tags=tags or [],
        tier=tier,
        workspace=workspace,
    )


def _seed(note_id, score, tier="", workspace="ws"):
    return RetrievedNote(
        note_id=note_id,
        path=note_id,
        content="body",
        score=score,
        type="concept",
        retrieval_source="vector",
        depth=0,
        tier=tier,
        workspace=workspace,
    )


class _FakeTriplet:
    """Minimal stand-in for (EntityNode, Relation, EntityNode)."""

    def __init__(self, src, label, tgt):
        self.src = _N(src)
        self.rel = _R(label)
        self.tgt = _N(tgt)

    def __iter__(self):
        yield self.src
        yield self.rel
        yield self.tgt


class _N:
    def __init__(self, name):
        self.name = name


class _R:
    def __init__(self, label):
        self.label = label


class _FakeGraphStore:
    """Returns specific triplets per entity_names filter."""

    def __init__(self, triplets: list):
        self._triplets = triplets

    def get_triplets(self, entity_names=None):
        if entity_names is None:
            return self._triplets
        results = []
        for t in self._triplets:
            src_name = t.src.name
            tgt_name = t.tgt.name
            if any(n in (src_name, tgt_name) for n in entity_names):
                results.append(t)
        return results


# ---------------------------------------------------------------------------
# _apply_tag_boost
# ---------------------------------------------------------------------------


class ApplyTagBoostTests(unittest.TestCase):
    def test_no_tags_no_boost(self):
        self.assertEqual(_apply_tag_boost(0.5, [], {"attention"}), 0.5)

    def test_no_query_tokens_no_boost(self):
        self.assertEqual(_apply_tag_boost(0.5, ["attention"], set()), 0.5)

    def test_one_matching_tag(self):
        result = _apply_tag_boost(1.0, ["attention"], {"attention"})
        self.assertAlmostEqual(result, 1.0 + TAG_BOOST_PER_TAG)

    def test_boost_capped_at_max(self):
        tags = ["a", "b", "c", "d", "e"]
        query = {"a", "b", "c", "d", "e"}
        result = _apply_tag_boost(1.0, tags, query)
        self.assertAlmostEqual(result, 1.0 * (1.0 + TAG_BOOST_MAX))

    def test_non_matching_tag_no_boost(self):
        result = _apply_tag_boost(0.8, ["transformer"], {"attention"})
        self.assertAlmostEqual(result, 0.8)


# ---------------------------------------------------------------------------
# _should_skip_edge
# ---------------------------------------------------------------------------


class ShouldSkipEdgeTests(unittest.TestCase):
    def _neighbor(self, title="neighbor"):
        return _parsed("nb/" + title, tags=[], tier="")

    def test_upward_defined_in_never_skipped(self):
        # Incoming DEFINED_IN: going up (symbol → file), should not skip
        self.assertFalse(
            _should_skip_edge("DEFINED_IN", is_outgoing=True, seed_score=0.9,
                              neighbor_parsed=self._neighbor(), query_tokens=set())
        )

    def test_downward_contains_symbol_low_score_skipped(self):
        # Outgoing CONTAINS_SYMBOL with score below threshold → skip
        self.assertTrue(
            _should_skip_edge("CONTAINS_SYMBOL", is_outgoing=True,
                              seed_score=DOWN_SEED_THRESHOLD - 0.01,
                              neighbor_parsed=self._neighbor(), query_tokens=set())
        )

    def test_downward_contains_symbol_high_score_not_skipped(self):
        # Outgoing CONTAINS_SYMBOL with score above threshold → allow
        self.assertFalse(
            _should_skip_edge("CONTAINS_SYMBOL", is_outgoing=True,
                              seed_score=DOWN_SEED_THRESHOLD + 0.01,
                              neighbor_parsed=self._neighbor(), query_tokens=set())
        )

    def test_incoming_contains_symbol_is_upward_not_skipped(self):
        # Incoming CONTAINS_SYMBOL means neighbor is the container (going up)
        self.assertFalse(
            _should_skip_edge("CONTAINS_SYMBOL", is_outgoing=False,
                              seed_score=0.0,
                              neighbor_parsed=self._neighbor(), query_tokens=set())
        )

    def test_sideways_calls_without_overlap_not_skipped(self):
        """CALLS edges are now followed unconditionally (symbol-centric graph)."""
        neighbor = _parsed("nb/unrelated", tags=[])
        self.assertFalse(
            _should_skip_edge("CALLS", is_outgoing=True, seed_score=0.9,
                              neighbor_parsed=neighbor,
                              query_tokens={"attention"})
        )

    def test_sideways_calls_with_overlap_not_skipped(self):
        neighbor = _parsed("nb/attention-layer", tags=[])
        neighbor.title = "Attention Layer"
        query_tokens = {"attention"}
        self.assertFalse(
            _should_skip_edge("CALLS", is_outgoing=True, seed_score=0.9,
                              neighbor_parsed=neighbor,
                              query_tokens=query_tokens)
        )

    def test_sideways_imports_without_overlap_skipped(self):
        """IMPORTS edges are still gated by query overlap."""
        neighbor = _parsed("nb/unrelated", tags=[])
        self.assertTrue(
            _should_skip_edge("IMPORTS", is_outgoing=True, seed_score=0.9,
                              neighbor_parsed=neighbor,
                              query_tokens={"attention"})
        )

    def test_links_to_never_skipped(self):
        self.assertFalse(
            _should_skip_edge("LINKS_TO", is_outgoing=True, seed_score=0.1,
                              neighbor_parsed=self._neighbor(), query_tokens=set())
        )


# ---------------------------------------------------------------------------
# expand_graph_neighbors
# ---------------------------------------------------------------------------


class ExpandGraphNeighborsTests(unittest.TestCase):
    def test_no_graph_store_returns_empty(self):
        seeds = [_seed("a", 0.8)]
        result = expand_graph_neighbors(None, {}, seeds, set())
        self.assertEqual(result, [])

    def test_no_seeds_returns_empty(self):
        result = expand_graph_neighbors(_FakeGraphStore([]), {}, [], set())
        self.assertEqual(result, [])

    def test_links_to_expands_neighbor(self):
        triplets = [_FakeTriplet("a", "LINKS_TO", "b")]
        parsed = {
            "a": _parsed("a"),
            "b": _parsed("b"),
        }
        seeds = [_seed("a", 0.8)]
        result = expand_graph_neighbors(_FakeGraphStore(triplets), parsed, seeds, set())
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].note_id, "b")
        self.assertEqual(result[0].retrieval_source, "graph")
        self.assertEqual(result[0].depth, 1)

    def test_score_multiplied_by_edge_multiplier(self):
        triplets = [_FakeTriplet("a", "LINKS_TO", "b")]
        parsed = {"a": _parsed("a"), "b": _parsed("b")}
        seeds = [_seed("a", 1.0)]
        result = expand_graph_neighbors(_FakeGraphStore(triplets), parsed, seeds, set())
        self.assertAlmostEqual(result[0].score, 0.50)  # LINKS_TO = 0.50 (symbol-centric weighting)

    def test_defined_in_multiplier(self):
        triplets = [_FakeTriplet("sym", "DEFINED_IN", "file")]
        parsed = {"sym": _parsed("sym", tier="1"), "file": _parsed("file", tier="2")}
        seeds = [_seed("sym", 1.0, tier="1")]
        result = expand_graph_neighbors(_FakeGraphStore(triplets), parsed, seeds, set())
        self.assertAlmostEqual(result[0].score, 0.70)  # DEFINED_IN = 0.70 (symbol-centric weighting)

    def test_seed_not_returned_as_expanded(self):
        triplets = [_FakeTriplet("a", "LINKS_TO", "a")]
        parsed = {"a": _parsed("a")}
        seeds = [_seed("a", 0.9)]
        result = expand_graph_neighbors(_FakeGraphStore(triplets), parsed, seeds, set())
        self.assertEqual(result, [])

    def test_index_notes_excluded_from_expansion(self):
        triplets = [_FakeTriplet("a", "LINKS_TO", "idx")]
        parsed = {"a": _parsed("a"), "idx": _parsed("idx", note_type="index")}
        seeds = [_seed("a", 0.9)]
        result = expand_graph_neighbors(_FakeGraphStore(triplets), parsed, seeds, set())
        self.assertEqual(result, [])

    def test_workspace_filter_on_expansion(self):
        triplets = [
            _FakeTriplet("a", "LINKS_TO", "b"),
            _FakeTriplet("a", "LINKS_TO", "c"),
        ]
        parsed = {
            "a": _parsed("a", workspace="ws-a"),
            "b": _parsed("b", workspace="ws-a"),
            "c": _parsed("c", workspace="ws-b"),
        }
        seeds = [_seed("a", 0.9, workspace="ws-a")]
        result = expand_graph_neighbors(
            _FakeGraphStore(triplets), parsed, seeds, set(), workspace="ws-a"
        )
        ids = {r.note_id for r in result}
        self.assertIn("b", ids)
        self.assertNotIn("c", ids)

    def test_deduplication_across_seeds(self):
        triplets = [
            _FakeTriplet("a", "LINKS_TO", "c"),
            _FakeTriplet("b", "LINKS_TO", "c"),
        ]
        parsed = {
            "a": _parsed("a"), "b": _parsed("b"), "c": _parsed("c"),
        }
        seeds = [_seed("a", 0.9), _seed("b", 0.8)]
        result = expand_graph_neighbors(_FakeGraphStore(triplets), parsed, seeds, set())
        ids = [r.note_id for r in result]
        self.assertEqual(ids.count("c"), 1)

    def test_downward_contains_blocked_below_threshold(self):
        triplets = [_FakeTriplet("mod", "CONTAINS", "file")]
        parsed = {
            "mod": _parsed("mod", tier="3"),
            "file": _parsed("file", tier="2"),
        }
        # Low-score seed should not follow CONTAINS downward
        seeds = [_seed("mod", DOWN_SEED_THRESHOLD - 0.05, tier="3")]
        result = expand_graph_neighbors(_FakeGraphStore(triplets), parsed, seeds, set())
        self.assertEqual(result, [])

    def test_downward_contains_allowed_above_threshold(self):
        triplets = [_FakeTriplet("mod", "CONTAINS", "file")]
        parsed = {
            "mod": _parsed("mod", tier="3"),
            "file": _parsed("file", tier="2"),
        }
        seeds = [_seed("mod", DOWN_SEED_THRESHOLD + 0.05, tier="3")]
        result = expand_graph_neighbors(_FakeGraphStore(triplets), parsed, seeds, set())
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].note_id, "file")

    def test_results_sorted_by_score_descending(self):
        triplets = [
            _FakeTriplet("a", "LINKS_TO", "b"),
            _FakeTriplet("a", "DEFINED_IN", "c"),  # 0.70 multiplier
        ]
        parsed = {"a": _parsed("a"), "b": _parsed("b"), "c": _parsed("c")}
        seeds = [_seed("a", 1.0)]
        result = expand_graph_neighbors(_FakeGraphStore(triplets), parsed, seeds, set())
        scores = [r.score for r in result]
        self.assertEqual(scores, sorted(scores, reverse=True))

    # ── Depth-2 CALLS expansion tests ─────────────────────────────────────

    def test_calls_chain_depth_2(self):
        """A --CALLS--> B --CALLS--> C: C should be found at depth 2."""
        triplets = [
            _FakeTriplet("a", "CALLS", "b"),
            _FakeTriplet("b", "CALLS", "c"),
        ]
        parsed = {
            "a": _parsed("a", tier="1"),
            "b": _parsed("b", tier="1"),
            "c": _parsed("c", tier="1"),
        }
        seeds = [_seed("a", 1.0, tier="1")]
        result = expand_graph_neighbors(
            _FakeGraphStore(triplets), parsed, seeds, set(), max_calls_depth=2,
        )
        ids = {r.note_id for r in result}
        self.assertIn("b", ids)
        self.assertIn("c", ids)

        b_note = next(r for r in result if r.note_id == "b")
        c_note = next(r for r in result if r.note_id == "c")
        self.assertEqual(b_note.depth, 1)
        self.assertEqual(c_note.depth, 2)
        # Score decay: b = 1.0 * 0.80, c = 0.80 * 0.80
        self.assertAlmostEqual(b_note.score, 0.80)
        self.assertAlmostEqual(c_note.score, 0.64)

    def test_calls_depth_2_only_follows_calls_not_other_edges(self):
        """At depth 2, only CALLS edges should be traversed."""
        triplets = [
            _FakeTriplet("a", "CALLS", "b"),
            _FakeTriplet("b", "DEFINED_IN", "file"),  # should NOT be followed at depth 2
            _FakeTriplet("b", "CALLS", "c"),           # SHOULD be followed at depth 2
        ]
        parsed = {
            "a": _parsed("a", tier="1"),
            "b": _parsed("b", tier="1"),
            "c": _parsed("c", tier="1"),
            "file": _parsed("file", tier="2"),
        }
        seeds = [_seed("a", 1.0, tier="1")]
        result = expand_graph_neighbors(
            _FakeGraphStore(triplets), parsed, seeds, set(), max_calls_depth=2,
        )
        ids = {r.note_id for r in result}
        # b found at depth 1 (CALLS), file found at depth 1 (DEFINED_IN from b)
        # c found at depth 2 (CALLS from b)
        # BUT: file is found at depth-1 from b's triplets during depth-1 expansion of seed a
        # Actually: depth-1 expands seed a → finds b (CALLS). Also finds file? No — file is
        # connected to b, not a. So depth-1 from a finds only b.
        # depth-2 from b: only CALLS edges → finds c, skips DEFINED_IN to file.
        self.assertIn("b", ids)
        self.assertIn("c", ids)
        self.assertNotIn("file", ids)  # DEFINED_IN not followed at depth 2

    def test_calls_depth_1_only_when_max_depth_1(self):
        """With max_calls_depth=1, depth-2 CALLS should not fire."""
        triplets = [
            _FakeTriplet("a", "CALLS", "b"),
            _FakeTriplet("b", "CALLS", "c"),
        ]
        parsed = {
            "a": _parsed("a", tier="1"),
            "b": _parsed("b", tier="1"),
            "c": _parsed("c", tier="1"),
        }
        seeds = [_seed("a", 1.0, tier="1")]
        result = expand_graph_neighbors(
            _FakeGraphStore(triplets), parsed, seeds, set(), max_calls_depth=1,
        )
        ids = {r.note_id for r in result}
        self.assertIn("b", ids)
        self.assertNotIn("c", ids)

    def test_calls_unconditional_no_query_overlap_needed(self):
        """CALLS edges should be followed even when neighbor name doesn't overlap query."""
        triplets = [_FakeTriplet("a", "CALLS", "totally_unrelated")]
        parsed = {
            "a": _parsed("a", tier="1"),
            "totally_unrelated": _parsed("totally_unrelated", tier="1"),
        }
        seeds = [_seed("a", 0.9, tier="1")]
        result = expand_graph_neighbors(
            _FakeGraphStore(triplets), parsed, seeds, {"specific", "query", "tokens"},
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].note_id, "totally_unrelated")


if __name__ == "__main__":
    unittest.main()
