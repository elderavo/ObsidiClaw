---
id: fce69e88-9b3b-4eee-a423-0d50e348d680
uuid: fce69e88-9b3b-4eee-a423-0d50e348d680
type: concept
created: 20260331
updated: 2026-03-31T21:22:02.439929Z
tags:
    - collaboration
    - planning
    - implementation
    - requirements
    - alignment
md_db: true
---
# Interview Before Planning or Implementation

When asked to plan or implement a coding change, the agent should run a short interview first and continue asking focused questions until confidence is high that it understands the request and success criteria.

## Principle

Do not jump from a vague request directly to code or detailed plans.

First establish shared understanding of:

- problem being solved,
- intended behavior,
- constraints,
- acceptance criteria,
- out-of-scope boundaries.

## Trigger

Use this interview-first behavior for any request that includes:

- implementing/changing code,
- refactoring behavior,
- designing architecture,
- debugging with multiple plausible causes,
- writing migration or rollout plans.

## Interview Loop

Ask concise, high-signal questions in rounds. Prefer multiple-choice or concrete options when possible.

Typical question areas:

1. **Goal** — What outcome should change for the user/system?
2. **Scope** — Which files/modules are in scope? What is explicitly out of scope?
3. **Behavior** — What should happen before vs after this change?
4. **Constraints** — Performance, compatibility, security, style, deadlines?
5. **Validation** — How will we know this is done (tests, examples, metrics)?
6. **Risk & rollout** — Any migration, fallback, or rollback requirements?

## Confidence Gate

Proceed to plan/implementation only when the agent can restate:

- objective in 1–2 sentences,
- concrete deliverables,
- acceptance criteria,
- known constraints and assumptions,
- open questions (if any) with explicit owner/next step.

If confidence is not high, keep interviewing.

## Default Output Pattern

Before coding, provide:

1. **Understanding check** (brief restatement)
2. **Open questions** (if needed)
3. **Proposed plan** (only after alignment)

## Anti-Pattern

Avoid speculative implementation based on assumptions that were not confirmed.

Fast wrong code is slower than brief alignment.

## Applicability

This concept is workspace-agnostic and applies across all workspaces unless a user explicitly asks to skip questions and proceed with assumptions.

## Related

- [[deterministic_interfaces_over_defensive_conditionals]]
- [[graceful_degradation]]
