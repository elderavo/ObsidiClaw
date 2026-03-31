"""Tests for pathfinder — BFS shortest path over the graph store."""

import unittest

from knowledge.graph.pathfinder import find_shortest_path, _build_adjacency


# ---------------------------------------------------------------------------
# Minimal graph store mock
# ---------------------------------------------------------------------------


class _N:
    def __init__(self, name):
        self.name = name


class _R:
    def __init__(self, label):
        self.label = label


class _FakeInnerGraph:
    def __init__(self, triplets):
        # triplets: list of (src_name, label, tgt_name)
        self._triplets = [(_N(s), _R(l), _N(t)) for s, l, t in triplets]

    def get_triplets(self):
        return self._triplets


class _FakeGraphStore:
    def __init__(self, triplets):
        self.graph = _FakeInnerGraph(triplets)


# ---------------------------------------------------------------------------
# _build_adjacency
# ---------------------------------------------------------------------------


class BuildAdjacencyTests(unittest.TestCase):
    def test_bidirectional_entries(self):
        store = _FakeGraphStore([("a", "CALLS", "b")])
        adj = _build_adjacency(store)
        # Both directions should be in adjacency
        ids_from_a = [n for n, _, _ in adj.get("a", [])]
        ids_from_b = [n for n, _, _ in adj.get("b", [])]
        self.assertIn("b", ids_from_a)
        self.assertIn("a", ids_from_b)

    def test_edge_type_filter(self):
        store = _FakeGraphStore([
            ("a", "CALLS", "b"),
            ("a", "IMPORTS", "c"),
        ])
        adj = _build_adjacency(store, allowed_edge_types={"CALLS"})
        ids_from_a = [n for n, _, _ in adj.get("a", [])]
        self.assertIn("b", ids_from_a)
        self.assertNotIn("c", ids_from_a)

    def test_direction_recorded_correctly(self):
        store = _FakeGraphStore([("a", "CALLS", "b")])
        adj = _build_adjacency(store)
        # From a: outgoing to b
        entry_from_a = next((e for e in adj["a"] if e[0] == "b"), None)
        self.assertIsNotNone(entry_from_a)
        self.assertEqual(entry_from_a[2], "outgoing")
        # From b: incoming from a
        entry_from_b = next((e for e in adj["b"] if e[0] == "a"), None)
        self.assertIsNotNone(entry_from_b)
        self.assertEqual(entry_from_b[2], "incoming")

    def test_empty_graph_empty_adjacency(self):
        store = _FakeGraphStore([])
        self.assertEqual(_build_adjacency(store), {})

    def test_empty_node_names_ignored(self):
        store = _FakeGraphStore([("", "CALLS", "b"), ("a", "CALLS", "")])
        adj = _build_adjacency(store)
        self.assertNotIn("", adj)


# ---------------------------------------------------------------------------
# find_shortest_path
# ---------------------------------------------------------------------------


class FindShortestPathTests(unittest.TestCase):
    def test_same_start_end(self):
        store = _FakeGraphStore([])
        steps = find_shortest_path(store, "a", "a")
        self.assertIsNotNone(steps)
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0].node_id, "a")

    def test_direct_connection(self):
        store = _FakeGraphStore([("a", "CALLS", "b")])
        steps = find_shortest_path(store, "a", "b")
        self.assertIsNotNone(steps)
        node_ids = [s.node_id for s in steps]
        self.assertEqual(node_ids, ["a", "b"])
        self.assertEqual(steps[1].edge_label, "CALLS")

    def test_two_hop_path(self):
        store = _FakeGraphStore([
            ("a", "CALLS", "b"),
            ("b", "IMPORTS", "c"),
        ])
        steps = find_shortest_path(store, "a", "c")
        self.assertIsNotNone(steps)
        node_ids = [s.node_id for s in steps]
        self.assertEqual(node_ids, ["a", "b", "c"])

    def test_no_path_returns_none(self):
        store = _FakeGraphStore([("a", "CALLS", "b")])
        result = find_shortest_path(store, "a", "disconnected")
        self.assertIsNone(result)

    def test_isolated_start_node_returns_none(self):
        store = _FakeGraphStore([("x", "CALLS", "y")])
        result = find_shortest_path(store, "isolated", "y")
        self.assertIsNone(result)

    def test_shortest_path_chosen(self):
        # Two paths: a→b→c (2 hops) and a→c (1 hop)
        store = _FakeGraphStore([
            ("a", "CALLS", "b"),
            ("b", "CALLS", "c"),
            ("a", "IMPORTS", "c"),
        ])
        steps = find_shortest_path(store, "a", "c")
        self.assertIsNotNone(steps)
        self.assertEqual(len(steps), 2)  # 1 hop = 2 nodes

    def test_max_depth_limits_search(self):
        # Chain: a→b→c→d, but max_depth=1 should not find d
        store = _FakeGraphStore([
            ("a", "CALLS", "b"),
            ("b", "CALLS", "c"),
            ("c", "CALLS", "d"),
        ])
        result = find_shortest_path(store, "a", "d", max_depth=2)
        self.assertIsNone(result)

    def test_edge_type_filter(self):
        store = _FakeGraphStore([
            ("a", "CALLS", "b"),
            ("a", "IMPORTS", "c"),
        ])
        # Only IMPORTS allowed — path to b should not be found
        result = find_shortest_path(store, "a", "b", allowed_edge_types={"IMPORTS"})
        self.assertIsNone(result)

        # Path to c should be found
        steps = find_shortest_path(store, "a", "c", allowed_edge_types={"IMPORTS"})
        self.assertIsNotNone(steps)
        self.assertEqual(len(steps), 2)

    def test_reverse_traversal(self):
        # Edge goes a→b, but start is b and end is a (reverse direction)
        store = _FakeGraphStore([("a", "CALLS", "b")])
        steps = find_shortest_path(store, "b", "a")
        self.assertIsNotNone(steps)
        node_ids = [s.node_id for s in steps]
        self.assertEqual(node_ids, ["b", "a"])

    def test_start_step_has_empty_edge(self):
        store = _FakeGraphStore([("a", "CALLS", "b")])
        steps = find_shortest_path(store, "a", "b")
        start = steps[0]
        self.assertEqual(start.edge_label, "")
        self.assertEqual(start.edge_direction, "")
        self.assertEqual(start.from_node_id, "")


if __name__ == "__main__":
    unittest.main()
