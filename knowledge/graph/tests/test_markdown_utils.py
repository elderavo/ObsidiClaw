"""Tests for markdown_utils — frontmatter parsing, wikilinks, tokens, type inference."""

import unittest

from knowledge.graph.markdown_utils import (
    extract_tags,
    extract_title,
    extract_wikilinks,
    infer_note_type,
    normalize_token,
    parse_frontmatter,
)


class ParseFrontmatterTests(unittest.TestCase):
    def test_no_frontmatter(self):
        fm, body = parse_frontmatter("# Hello\n\nworld")
        self.assertEqual(fm, {})
        self.assertIn("Hello", body)

    def test_inline_values(self):
        content = "---\ntitle: My Note\ntype: concept\n---\n\nbody text"
        fm, body = parse_frontmatter(content)
        self.assertEqual(fm["title"], "My Note")
        self.assertEqual(fm["type"], "concept")
        self.assertEqual(body.strip(), "body text")

    def test_list_values(self):
        content = "---\ntags:\n  - python\n  - ml\n---\nbody"
        fm, body = parse_frontmatter(content)
        self.assertEqual(fm["tags"], ["python", "ml"])

    def test_empty_value(self):
        content = "---\ntitle: Test\nsource:\n---\nbody"
        fm, _ = parse_frontmatter(content)
        self.assertIsNone(fm["source"])

    def test_unclosed_frontmatter(self):
        content = "---\ntitle: Test\nbody here"
        fm, body = parse_frontmatter(content)
        self.assertEqual(fm, {})
        self.assertIn("title", body)

    def test_body_stripped_of_frontmatter(self):
        content = "---\ntitle: T\n---\n\n## Section\n\ntext"
        fm, body = parse_frontmatter(content)
        self.assertNotIn("---", body)
        self.assertIn("Section", body)


class NormalizeTokenTests(unittest.TestCase):
    def test_lowercase(self):
        self.assertEqual(normalize_token("Hello"), "hello")

    def test_replaces_hyphens_with_underscore(self):
        self.assertEqual(normalize_token("context-engine"), "context_engine")

    def test_replaces_spaces(self):
        self.assertEqual(normalize_token("my note"), "my_note")

    def test_strips_leading_trailing_underscores(self):
        self.assertEqual(normalize_token("_foo_"), "foo")

    def test_empty_string(self):
        self.assertEqual(normalize_token(""), "")

    def test_numbers_preserved(self):
        self.assertEqual(normalize_token("tier1"), "tier1")


class ExtractTagsTests(unittest.TestCase):
    def test_list_form(self):
        fm = {"tags": ["python", "ml"]}
        self.assertEqual(extract_tags(fm), ["python", "ml"])

    def test_comma_separated_string(self):
        fm = {"tags": "python, ml, ai"}
        self.assertEqual(extract_tags(fm), ["python", "ml", "ai"])

    def test_normalizes_tags(self):
        fm = {"tags": ["Machine-Learning", "AI"]}
        tags = extract_tags(fm)
        self.assertIn("machine_learning", tags)
        self.assertIn("ai", tags)

    def test_deduplicates(self):
        fm = {"tags": ["ml", "ml", "ML"]}
        self.assertEqual(extract_tags(fm), ["ml"])

    def test_empty_list(self):
        self.assertEqual(extract_tags({"tags": []}), [])

    def test_absent_tags(self):
        self.assertEqual(extract_tags({}), [])

    def test_none_frontmatter(self):
        self.assertEqual(extract_tags(None), [])


class ExtractWikilinksTests(unittest.TestCase):
    def test_simple_link(self):
        links = extract_wikilinks("See [[concepts/foo]] for details.")
        self.assertEqual(links, ["concepts/foo"])

    def test_aliased_link(self):
        links = extract_wikilinks("See [[concepts/foo|Foo]] here.")
        self.assertEqual(links, ["concepts/foo"])

    def test_multiple_links(self):
        links = extract_wikilinks("[[a]] and [[b]] and [[c]]")
        self.assertEqual(links, ["a", "b", "c"])

    def test_deduplicates(self):
        links = extract_wikilinks("[[foo]] twice [[foo]]")
        self.assertEqual(links, ["foo"])

    def test_no_links(self):
        self.assertEqual(extract_wikilinks("plain text"), [])

    def test_preserves_path(self):
        links = extract_wikilinks("[[code/obsidi-claw/engine]]")
        self.assertEqual(links, ["code/obsidi-claw/engine"])


class InferNoteTypeTests(unittest.TestCase):
    def test_frontmatter_type_wins(self):
        self.assertEqual(infer_note_type({"type": "tool"}, "concepts/foo.md"), "tool")

    def test_codeunit_normalisation(self):
        self.assertEqual(infer_note_type({"type": "codeUnit"}, "x.md"), "codeUnit")

    def test_codesymbol_normalisation(self):
        self.assertEqual(infer_note_type({"type": "codeSymbol"}, "x.md"), "codeSymbol")

    def test_codemodule_normalisation(self):
        self.assertEqual(infer_note_type({"type": "codeModule"}, "x.md"), "codeModule")

    def test_path_prefix_tools(self):
        self.assertEqual(infer_note_type({}, "tools/my_tool.md"), "tool")

    def test_path_prefix_concepts(self):
        self.assertEqual(infer_note_type({}, "concepts/my_concept.md"), "concept")

    def test_index_stem(self):
        self.assertEqual(infer_note_type({}, "some/index.md"), "index")

    def test_default_is_concept(self):
        self.assertEqual(infer_note_type({}, "random/file.md"), "concept")

    def test_unknown_type_falls_through(self):
        self.assertEqual(infer_note_type({"type": "unknown_xyz"}, "random/file.md"), "concept")


class ExtractTitleTests(unittest.TestCase):
    def test_frontmatter_title(self):
        title = extract_title({"title": "My Title"}, "# Other\n\nbody", "file.md")
        self.assertEqual(title, "My Title")

    def test_first_heading(self):
        title = extract_title({}, "# Section Heading\n\nbody", "file.md")
        self.assertEqual(title, "Section Heading")

    def test_filename_fallback(self):
        title = extract_title({}, "no heading here", "my-cool-note.md")
        self.assertEqual(title, "My Cool Note")

    def test_empty_frontmatter_title_falls_through(self):
        title = extract_title({"title": ""}, "# Heading\n\nbody", "file.md")
        self.assertEqual(title, "Heading")


if __name__ == "__main__":
    unittest.main()
