---
type: concept
tags:
    - knowledge
    - retrieval
    - graph
    - discovery
    - architecture
workspace: vaultus-sapiens
---
# Graph Over Search

Intentional links between notes are more valuable for knowledge work than full-text search alone. Search is a fallback; the graph is the primary retrieval surface.

## Principle

A graph of explicit relationships—created as an act of understanding—surface unexpected connections and enable traversal that full-text matching cannot. A query "authentication" will return every note containing the word; a graph query returns notes *semantically related* to authentication concepts, even if they don't use the word.

## Why

**Serendipity** — Walking the graph ("What calls this function?", "What concept depends on this?") reveals patterns and gaps that keyword search obscures.

**Precision** — A link says "this is specifically related"; a search hit says "this word appears here."

**Stability** — The graph is durable. Refactoring note titles or content can break searches; it doesn't break explicit links.

**Synthesis** — Graph structure makes it visible where your knowledge is dense (many linked notes in one region) vs. sparse (isolated islands), guiding what to study.

## When to Apply

When designing retrieval:
- Prioritize graph-based traversal (BFS from a seed concept, following typed edges).
- Use full-text search to seed the graph or as a secondary fallback.
- When adding a note: creating links *is* part of the note's completion, not optional.

## Anti-Pattern

Treating links as optional "nice-to-haves" or creating notes without checking for existing related notes. Relying on search to discover connections.

## Implementation

1. On note creation, check: "What existing notes does this connect to?"
2. Add edges with *typed* relationships (e.g., DEPENDS_ON, CONTRADICTS, REFINES) not generic "related" tags.
3. Periodically audit isolated notes (degree 0–1) and consider if links were missed.
4. When querying, start with a seed note and follow the graph, supplementing with search only if traversal stalls.

## Applicability

Essential for any vault larger than ~50 notes. Critical for agentic systems where discovery drives learning.

## Related

- [[zero_friction_ingress_and_meaningful_classification]] — graph links are built during refinement phase
- [[atomicity_over_aggregation]] — atomic notes produce cleaner graphs
- [[structure_notes_as_navigation]] — structure notes are graph navigators
