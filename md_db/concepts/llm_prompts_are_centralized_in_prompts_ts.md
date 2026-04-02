---
type: concept
workspace: obsidi-claw
---
# LLM Prompt Centralization

## Purpose
All static, reusable text that is automatically sent to large language models (LLMs) must be defined in a single central module—`agents/prompts.ts`. This ensures predictable model behavior and simplifies auditing.

## Design Rules
1. **Single Source of Truth** – All non-personality prompts live in `agents/prompts.ts`.
2. **Functional Prompt Interface** – Each prompt exports both a `system` string and a `user()` builder function.
3. **No Inline Prompts** – No direct multi-line or raw string literals passed to `llmChat()` in runtime code.
4. **Personality Separation** – Agent tone and style guidelines remain in `agents/personalities/*.md`.
5. **Encapsulation of Logic** – Business logic and prompt text remain clearly separated.

## Example Implementation
```ts
// agents/prompts.ts
export const PROMPT_SUMMARIZE_NOTE = {
  system: `You are a concise and neutral assistant that summarizes notes in markdown format without additional commentary.`,
  user: (note: string) => [
    "## Task",
    "Summarize the following note accurately and succinctly.",
    "",
    "## Note",
    note,
  ].join('\n'),
};
```

Usage example:
```ts
import { PROMPT_SUMMARIZE_NOTE } from "agents/prompts";
const messages = [
  { role: "system", content: PROMPT_SUMMARIZE_NOTE.system },
  { role: "user", content: PROMPT_SUMMARIZE_NOTE.user(note.content) },
];
await llmChat(messages);
```

## Enforcement
- Concept audit check: search for inline `content:` literals passed to `llmChat()`.
- A linter or script should warn when `PROMPT_` constants are not used.

## Related
- [[provider_abstraction]]
- [[mcp_retrieval_architecture]]
- [[agents/prompts]]
