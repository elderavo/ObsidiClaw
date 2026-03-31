---
id: 0d5395de-7578-4d9c-bfb0-781442ee3f2f
uuid: 0d5395de-7578-4d9c-bfb0-781442ee3f2f
type: concept
created: 20260331
updated: 2026-03-31T17:34:52.482Z
tags:
    - architecture
    - api_design
    - refactoring
    - determinism
md_db: true
---
# Deterministic Interfaces Over Defensive Conditionals

Prefer deterministic contracts over “defensive” branching inside core flows.

## Principle

In controlled internal code paths, APIs should have one clear contract:

- **always required and always passed**, or
- **never accepted / removed entirely**.

Avoid optional argument sprawl and fallback conditionals that patch over inconsistent call sites.

## Why

“Defensive” glue in deterministic systems often hides design drift instead of fixing it.
Over time this creates spaghetti logic:

- multiple flags with unclear ownership,
- unclear truth tables,
- brittle behavior across layers,
- harder refactors and weaker testability.

A simpler contract makes behavior predictable, easier to reason about, and easier to enforce in tests.

## Boundary Rule

Defensive checks belong primarily at **ingress points of uncontrolled input**:

- external tool calls,
- user input,
- network/file boundaries,
- untrusted integrations.

Inside trusted internal layers, prefer strict invariants over permissive branching.

## Application Pattern

When a flag is effectively policy, encode policy directly in the API:

- if retention is never desired, remove `retain` / `delete` options and always delete;
- if scoping is mandatory, require scope and reject missing/invalid values;
- if a mode is unsupported, remove it instead of silently degrading in-line.

## Litmus Test

If a branch exists only to tolerate inconsistent upstream behavior, refactor upstream and delete the branch.

## Related

- [[provider_abstraction]]
- [[mcp_retrieval_architecture]]
