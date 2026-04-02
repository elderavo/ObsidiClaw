---
type: concept
tags:
    - knowledge
    - structure
    - navigation
    - organization
workspace: vaultus-sapiens
---
# Structure Notes as Navigation

Structure notes are not repositories or containers; they are *indices* that navigate a cluster of atomic notes. A structure note is the answer to "what related concepts belong together?" and "in what order should I read them?"

## Principle

When multiple atomic notes share a semantic domain (e.g., authentication, web scraping, epistemology), create a structure note that:

1. Defines the domain
2. Lists atomic notes within it with brief descriptions
3. Indicates a suggested reading/learning order
4. Explains how the notes relate to each other

The structure note is *about* the domain, not *containing* the domain. It points; it doesn't embed.

## Why

**Navigation** — Agents and humans can enter a domain at one structure note and traverse outward to relevant atomics.

**Onboarding** — New structure provides a map; atomic notes provide the territory.

**Coherence without aggregation** — You can group related ideas without mixing them into one unwieldy note.

**Evolutionary** — Atomic notes remain independent and reusable. The structure note evolves as new notes are added.

## When to Create

- When 5+ atomic notes share a concept or domain.
- When you find yourself writing "see also" lists in multiple atomic notes.
- When an agent or human needs an overview before diving into details.

## Anti-Pattern

Embedding full content in the structure note. Creating folder hierarchies instead of structure notes. Structure notes that duplicate information from the atomic notes they link to.

## Implementation

**Format:**

```markdown
# [Domain Name]

Brief definition of the domain.

## Core Concepts

- [[atomic_note_1]]: What this note covers
- [[atomic_note_2]]: What this note covers

## Suggested Reading Order

1. Start with [[atomic_note_1]] for fundamentals
2. Then [[atomic_note_2]] for the mechanism
3. See [[atomic_note_3]] for advanced applications

## Relationships

- [Note A] *refines* [Note B]
- [Note C] *contradicts* [Note D]

## Gaps

What's missing from this domain? Add notes here as they're created.
```

**Discipline:**

- Keep structure notes lightweight (< 500 words).
- If you're writing detailed explanations, move them to atomic notes and link from the structure note.
- Review structure notes monthly; consolidate or split if the domain has evolved.

## Applicability

Recommended for vaults with >100 notes, or for any knowledge domain with >5 related atomic notes. Optional for small, single-topic vaults.

## Related

- [[atomicity_over_aggregation]] — atomic notes remain the unit; structure notes organize them
- [[graph_over_search]] — structure notes are navigators of the semantic graph
- [[zero_friction_ingress_and_meaningful_classification]] — structure emerges during refinement
