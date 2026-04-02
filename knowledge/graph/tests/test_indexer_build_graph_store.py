import unittest

from knowledge.graph.indexer import _build_graph_store
from knowledge.graph.models import ParsedNote


def _note(
    note_id: str,
    *,
    note_type: str = "concept",
    tier: str = "",
    parent_file: str = "",
    parent_module: str = "",
    links_out: list[str] | None = None,
) -> ParsedNote:
    return ParsedNote(
        note_id=note_id,
        path=note_id,
        title=note_id,
        note_type=note_type,  # type: ignore[arg-type]
        body="body",
        frontmatter={},
        links_out=links_out or [],
        tags=[],
        tier=tier,
        parent_file=parent_file,
        parent_module=parent_module,
        workspace="ws",
    )


class BuildGraphStoreEdgeLabelTests(unittest.TestCase):
    def test_code_tiers_and_wikilinks_create_typed_relations(self):
        # Tier-1 symbol -> tier-2 file (DEFINED_IN + inverse CONTAINS_SYMBOL)
        # Tier-2 file -> tier-3 module (BELONGS_TO + inverse CONTAINS)
        # Tier-1 wikilink to tier-1 -> CALLS
        # Tier-2 wikilink to tier-2 -> IMPORTS
        # Cross-tier wikilink -> LINKS_TO
        sym1 = _note(
            "code/ws/sym1.md",
            note_type="codeSymbol",
            tier="1",
            parent_file="code/ws/file1",
            parent_module="code/ws/mod1",
            links_out=["code/ws/sym2"],
        )
        sym2 = _note("code/ws/sym2.md", note_type="codeSymbol", tier="1")

        file1 = _note(
            "code/ws/file1.md",
            note_type="codeUnit",
            tier="2",
            parent_module="code/ws/mod1",
            links_out=["code/ws/file2", "concepts/c1"],
        )
        file2 = _note("code/ws/file2.md", note_type="codeUnit", tier="2")
        mod1 = _note("code/ws/mod1.md", note_type="codeModule", tier="3")

        c1 = _note("concepts/c1.md", note_type="concept", links_out=[])
        c2 = _note("concepts/c2.md", note_type="concept", links_out=["concepts/c1"])

        notes = [sym1, sym2, file1, file2, mod1, c1, c2]
        notes_by_id = {n.note_id: n for n in notes}
        store = _build_graph_store(notes, notes_by_id)

        triplets = store.graph.get_triplets()
        edges = {(s.name, r.label, t.name) for (s, r, t) in triplets}

        expected = {
            ("code/ws/sym1.md", "DEFINED_IN", "code/ws/file1.md"),
            ("code/ws/file1.md", "CONTAINS_SYMBOL", "code/ws/sym1.md"),
            ("code/ws/file1.md", "BELONGS_TO", "code/ws/mod1.md"),
            ("code/ws/mod1.md", "CONTAINS", "code/ws/file1.md"),
            ("code/ws/sym1.md", "CALLS", "code/ws/sym2.md"),
            ("code/ws/file1.md", "IMPORTS", "code/ws/file2.md"),
            ("code/ws/file1.md", "LINKS_TO", "concepts/c1.md"),
            ("concepts/c2.md", "LINKS_TO", "concepts/c1.md"),
        }

        missing = expected - edges
        self.assertEqual(missing, set())


    def test_symbol_level_calls_produce_calls_edges(self):
        """When tier-1 notes link to other tier-1 notes (symbol-level wikilinks),
        the indexer should create CALLS edges, not LINKS_TO.

        This validates the symbol-centric graph model where mirror-codebase.ts
        emits wikilinks like [[code/ws/file/calleeName]] instead of [[code/ws/file]].
        """
        # functionA calls functionB (both tier-1 symbols)
        fn_a = _note(
            "code/ws/file1/functionA.md",
            note_type="codeSymbol",
            tier="1",
            parent_file="code/ws/file1",
            links_out=["code/ws/file2/functionB"],  # symbol-level link!
        )
        fn_b = _note(
            "code/ws/file2/functionB.md",
            note_type="codeSymbol",
            tier="1",
            parent_file="code/ws/file2",
        )
        file1 = _note("code/ws/file1.md", note_type="codeUnit", tier="2")
        file2 = _note("code/ws/file2.md", note_type="codeUnit", tier="2")

        notes = [fn_a, fn_b, file1, file2]
        notes_by_id = {n.note_id: n for n in notes}
        store = _build_graph_store(notes, notes_by_id)

        triplets = store.graph.get_triplets()
        edges = {(s.name, r.label, t.name) for (s, r, t) in triplets}

        # The critical assertion: symbol→symbol link = CALLS, not LINKS_TO
        self.assertIn(
            ("code/ws/file1/functionA.md", "CALLS", "code/ws/file2/functionB.md"),
            edges,
        )
        # Should NOT have a LINKS_TO for this edge
        self.assertNotIn(
            ("code/ws/file1/functionA.md", "LINKS_TO", "code/ws/file2/functionB.md"),
            edges,
        )

    def test_symbol_to_file_cross_tier_still_links_to(self):
        """When a tier-1 note links to a tier-2 note (old-style file link),
        it should still produce a LINKS_TO edge (not CALLS)."""
        fn_a = _note(
            "code/ws/file1/functionA.md",
            note_type="codeSymbol",
            tier="1",
            parent_file="code/ws/file1",
            links_out=["code/ws/file2"],  # file-level link (cross-tier)
        )
        file1 = _note("code/ws/file1.md", note_type="codeUnit", tier="2")
        file2 = _note("code/ws/file2.md", note_type="codeUnit", tier="2")

        notes = [fn_a, file1, file2]
        notes_by_id = {n.note_id: n for n in notes}
        store = _build_graph_store(notes, notes_by_id)

        triplets = store.graph.get_triplets()
        edges = {(s.name, r.label, t.name) for (s, r, t) in triplets}

        # Cross-tier = LINKS_TO
        self.assertIn(
            ("code/ws/file1/functionA.md", "LINKS_TO", "code/ws/file2.md"),
            edges,
        )


if __name__ == "__main__":
    unittest.main()

