---
id: 45259ca7-8df0-4891-bdf3-89e0013a24a7
uuid: 45259ca7-8df0-4891-bdf3-89e0013a24a7
type: concept
created: 20260401
updated: 2026-04-01T02:34:22.765903Z
workspace: obsidi-claw
tags:
    - prompts
    - llm
    - maintainability
    - architecture
md_db: true
---
# LLM Prompts Are Centralized in prompts.ts

LLM-facing prompt strings should be centralized in `agents/prompts.ts` instead of being hardcoded inline across runtime code.

## Principle

When adding or changing an LLM prompt template, put it in `agents/prompts.ts` and import it where needed.

## Why

- Keeps prompt behavior discoverable in one place
- Reduces drift and duplicated wording
- Makes prompt changes safer and easier to review
- Improves consistency across tools/jobs/engines

## Rule of Thumb

- **Do:** define reusable/static prompt text in `agents/prompts.ts`
- **Do:** import prompt constants from `agents/prompts.ts`
- **Avoid:** inline multi-line prompt literals in runtime code paths

## Exception

Personality content belongs in `agents/personalities/*.md` (loaded via the personality loader), not in `prompts.ts`.

## Related

- [[provider_abstraction]]
- [[mcp_retrieval_architecture]]
