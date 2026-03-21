---
id: 0c8e4b51-1b0f-4e28-9fbe-4b6c9a7f1b9c
type: context
created: 20260321-120000
updated: 20260321-120000
tags:
    - subagent
    - context_engine
    - orchestrator
---

# Subagent Context Packaging Flow

Subagent context is packaged by the **context engine synthesizer** and injected by the **orchestrator** during subagent spawning. The packaging happens through the MCP `prepare_subagent` tool, which runs hybrid retrieval and formats a system prompt that the child Pi session uses as its system prompt.

# Key Implementation Points

- **Spawn trigger**: `.pi/extensions/subagent.ts` calls MCP `prepare_subagent` with `prompt`, `plan`, and `success_criteria` before creating a child `OrchestratorSession`.
- **Synthesizer**: `context_engine/mcp/mcp-server.ts` exposes `prepare_subagent`, which calls `ContextEngine.buildSubagentPackage(...)`.
- **Packaging**: `context_engine/context-engine.ts` uses `buildSubagentPackage` to:
  - run hybrid retrieval on `plan + prompt` (via `build()`),
  - assemble a `SubagentPackage`, and
  - format the final system prompt with `formatSubagentSystemPrompt(...)`.
- **Injection**: `orchestrator/session.ts` constructs the child session with `systemPromptOverride` set to the formatted system prompt returned by `prepare_subagent`.

# Usage Example

When the main agent calls `spawn_subagent(plan, context, success_criteria)`, the subagent extension retrieves a formatted system prompt from `prepare_subagent`, then creates a child `OrchestratorSession` that runs the plan with that packaged context as its system prompt.

Links:

[[obsidiclaw]]

