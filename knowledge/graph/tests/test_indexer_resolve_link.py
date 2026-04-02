import unittest

from knowledge.graph.indexer import _resolve_link
from knowledge.graph.models import ParsedNote


def _note(note_id: str, note_type: str = "concept") -> ParsedNote:
    return ParsedNote(
        note_id=note_id,
        path=note_id,
        title=note_id,
        note_type=note_type,  # type: ignore[arg-type]
        body="body",
        frontmatter={},
        links_out=[],
        tags=[],
        workspace="",
    )


class ResolveLinkTests(unittest.TestCase):
    def test_exact_match_wins(self):
        notes = {
            "concepts/foo.md": _note("concepts/foo.md", "concept"),
        }
        self.assertEqual(_resolve_link("concepts/foo.md", notes), "concepts/foo.md")

    def test_appends_md_for_direct_match(self):
        notes = {
            "concepts/bar.md": _note("concepts/bar.md", "concept"),
        }
        self.assertEqual(_resolve_link("concepts/bar", notes), "concepts/bar.md")

    def test_ambiguous_stem_prefers_tool_over_concept_over_index(self):
        notes = {
            "tools/foo.md": _note("tools/foo.md", "tool"),
            "concepts/foo.md": _note("concepts/foo.md", "concept"),
            "some/index/foo.md": _note("some/index/foo.md", "index"),
        }
        self.assertEqual(_resolve_link("foo", notes), "tools/foo.md")


if __name__ == "__main__":
    unittest.main()

