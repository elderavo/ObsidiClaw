---
type: concept
tags:
    - knowledge
    - note_structure
    - atomicity
    - permanence
workspace: vaultus-sapiens
---
# Atomicity Over Aggregation

Each permanent note contains one conceptual unit and one topic only. This boundary is established at the moment of promotion to permanent status, not at capture.

## Principle

A note's scope is determined by coherence: it should address a single, well-defined idea that can be explained without reference to sibling notes. The note is the smallest unit that stands alone.

When a note covers multiple topics, discovery breaks: a query for one topic retrieves notes about all of them, polluting both search and graph traversal. Atomicity enables precise retrieval and unexpected connections.

## Why

**Precision** — Agents and users find exactly what they need without noise.

**Reusability** — An atomic note can be linked from many contexts; an aggregated note creates false connections.

**Evolution** — Atomic notes can be revised, deprecated, or promoted independently. Mixed notes trap change behind compatibility concerns.

**Graph quality** — Links between atomic notes express real relationships. Links between aggregated notes are ambiguous ("does this note link to the whole thing or just one section?").

## When to Apply

- On promotion from inbox/scaffolding to permanent status: split multi-topic notes.
- When reviewing a note and discovering it answers unrelated questions: split.
- When linking: if you need to write "this is about part of X," X should be split.

## Anti-Pattern

Keeping notes on "Feature Design" that actually cover UI, database schema, and API contract together. Or combining "Authentication" and "Session Management" because they're related. Relatedness is handled by *links*, not aggregation.

## Implementation

1. At capture: no atomicity requirement. Inbox can be messy.
2. At review: when assigning final status, check: "Does this note answer a single, focused question?"
3. If it answers multiple questions, split into child notes and create a structure note that links them.
4. Name the note for its single topic, not its membership in a category (bad: "auth-concepts", good: "session-token-expiration").

## Applicability

Non-negotiable for permanent vault notes. Scaffolding and inbox notes can be aggregate; the structure note (tier-3 module equivalent) is allowed to link a cohesive cluster.

## Related

- [[zero_friction_ingress_and_meaningful_classification]] — atomicity is a refinement *after* capture
- [[structure_notes_as_navigation]] — structure notes aggregate atomic notes via links, not embedding
