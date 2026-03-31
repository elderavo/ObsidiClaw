import unittest

from knowledge.graph.engine import KnowledgeGraphEngine
from knowledge.graph.models import ParsedNote, RetrievedNote
from knowledge.graph.retriever import ObsidiClawRetriever, WorkspaceScopeViolationError


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


def _parsed_note(path: str, workspace: str) -> ParsedNote:
    return ParsedNote(
        note_id=path,
        path=path,
        title="Note",
        note_type="concept",
        body="body",
        frontmatter={"workspace": workspace},
        links_out=[],
        workspace=workspace,
    )


class WorkspaceScopeContractTests(unittest.TestCase):
    def test_scoped_vector_retrieval_raises_on_workspace_mismatch(self):
        path = "code/ws-b/note.md"
        parsed = {path: _parsed_note(path, "ws-b")}
        result = _FakeResult(
            _FakeNode(path, {"file_path": path, "note_type": "concept", "workspace": "ws-b"}),
            0.9,
        )
        retriever = ObsidiClawRetriever(
            index=_FakeIndex([result]),
            graph_store=None,
            embed_model=None,
            parsed_notes=parsed,
            similarity_top_k=8,
        )

        with self.assertRaises(WorkspaceScopeViolationError):
            retriever.retrieve("note", workspace="ws-a")

    def test_scoped_vector_retrieval_passes_when_workspace_matches(self):
        path = "code/ws-a/note.md"
        parsed = {path: _parsed_note(path, "ws-a")}
        result = _FakeResult(
            _FakeNode(path, {"file_path": path, "note_type": "concept", "workspace": "ws-a"}),
            0.9,
        )
        retriever = ObsidiClawRetriever(
            index=_FakeIndex([result]),
            graph_store=None,
            embed_model=None,
            parsed_notes=parsed,
            similarity_top_k=8,
        )

        seeds, expanded = retriever.retrieve("note", workspace="ws-a")
        self.assertEqual(len(seeds), 1)
        self.assertEqual(len(expanded), 0)
        self.assertEqual(seeds[0].workspace, "ws-a")

    def test_engine_falls_back_to_keyword_on_workspace_contract_violation(self):
        path = "code/ws-b/note.md"
        parsed = {path: _parsed_note(path, "ws-b")}
        bad_result = _FakeResult(
            _FakeNode(path, {"file_path": path, "note_type": "concept", "workspace": "ws-b"}),
            0.9,
        )

        engine = KnowledgeGraphEngine()
        engine.index = _FakeIndex([bad_result])
        engine.graph_store = None
        engine.embed_model = None
        engine._parsed_notes = parsed

        class _FakeKeywordRetriever:
            def retrieve(self, _query, top_k=8, workspace=None):
                return [
                    RetrievedNote(
                        note_id="code/ws-a/fallback.md",
                        path="code/ws-a/fallback.md",
                        content="fallback",
                        score=1.0,
                        type="concept",
                        retrieval_source="vector",
                        workspace=workspace or "",
                    )
                ]

        engine.keyword_retriever = _FakeKeywordRetriever()

        out = engine.retrieve("note", top_k=8, workspace="ws-a")
        self.assertEqual(len(out["seed_notes"]), 1)
        self.assertEqual(out["seed_notes"][0]["workspace"], "ws-a")
        self.assertEqual(out["expanded_notes"], [])


if __name__ == "__main__":
    unittest.main()
