import unittest

from knowledge.graph.models import ParsedNote
from knowledge.graph.retriever import ObsidiClawRetriever


class _FakeNode:
    def __init__(self, node_id: str, metadata: dict, text: str = "") -> None:
        self.id_ = node_id
        self.metadata = metadata
        self.text = text


class _FakeResult:
    def __init__(self, node: _FakeNode, score: float) -> None:
        self.node = node
        self.score = score


class _FakeVectorRetriever:
    def __init__(self, results):
        self._results = results

    def retrieve(self, _query: str):
        return self._results


class _FakeIndex:
    def __init__(self, results):
        self._results = results
        self.last_kwargs = None

    def as_retriever(self, **kwargs):
        self.last_kwargs = kwargs
        return _FakeVectorRetriever(self._results)


def _parsed_note(path: str, workspace: str, tags: list[str]) -> ParsedNote:
    return ParsedNote(
        note_id=path,
        path=path,
        title="Note",
        note_type="concept",
        body="body",
        frontmatter={"workspace": workspace},
        links_out=[],
        workspace=workspace,
        tags=tags,
    )


class VectorChunkDedupTests(unittest.TestCase):
    def test_dedups_chunks_keeps_max_score_with_tag_boost_and_passes_filters(self):
        parent_path = "code/ws-a/note.md"
        parsed = {parent_path: _parsed_note(parent_path, "ws-a", tags=["attention"])}

        results = [
            _FakeResult(
                _FakeNode(
                    node_id=f"{parent_path}#chunk0",
                    metadata={
                        "file_path": parent_path,
                        "parent_note_id": parent_path,
                        "note_type": "concept",
                        "workspace": "ws-a",
                    },
                ),
                0.5,
            ),
            _FakeResult(
                _FakeNode(
                    node_id=f"{parent_path}#chunk1",
                    metadata={
                        "file_path": parent_path,
                        "parent_note_id": parent_path,
                        "note_type": "concept",
                        "workspace": "ws-a",
                    },
                ),
                0.9,
            ),
            _FakeResult(
                _FakeNode(
                    node_id="idx.md",
                    metadata={
                        "file_path": "idx.md",
                        "note_type": "index",
                        "workspace": "ws-a",
                    },
                ),
                1.0,
            ),
        ]

        index = _FakeIndex(results)
        retriever = ObsidiClawRetriever(
            index=index,  # type: ignore[arg-type]
            graph_store=None,
            embed_model=None,  # type: ignore[arg-type]
            parsed_notes=parsed,
            similarity_top_k=8,
        )

        seeds, expanded = retriever.retrieve("attention", workspace="ws-a")

        self.assertEqual(expanded, [])
        self.assertEqual(len(seeds), 1)
        self.assertEqual(seeds[0].note_id, parent_path)
        # 0.9 max chunk score * (1 + 0.10 tag boost)
        self.assertAlmostEqual(seeds[0].score, 0.99, places=5)

        # Ensure workspace filters were passed down to the vector retriever
        self.assertIsNotNone(index.last_kwargs)
        self.assertIn("filters", index.last_kwargs)


if __name__ == "__main__":
    unittest.main()

