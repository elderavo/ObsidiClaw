---
title: Context Engine MCP Interface
type: concept
---

# Context Engine MCP Interface

The `createContextEngineMcpServer` function wraps `ContextEngine` behind the **Model Context Protocol (MCP)** and exposes tools to Pi and extensions.

## MCP server

- `createContextEngineMcpServer(engine, onContextBuilt?, onSubagentPrepared?)`:
  - Creates `McpServer` named `"obsidi-claw-context"`.
  - Registers three tools:
    - `retrieve_context`
    - `get_preferences`
    - `prepare_subagent`
  - Optional callbacks:
    - `onContextBuilt(ContextPackage)` – for logging retrieval metrics.
    - `onSubagentPrepared(SubagentPackage)` – for logging subagent packaging.

## Tools

### `retrieve_context`

- **Description**:
  - Hybrid RAG query against the knowledge base.
  - Returns markdown-formatted context for injection into the Pi session.
- **Input**:
  - `query: string` – the retrieval query.
- **Implementation**:
  - `engine.build(query)` (see [[context_engine-retrieval-workflow]]).
  - Calls `onContextBuilt(pkg)` if provided.
  - Returns `pkg.formattedContext` as text content.

### `get_preferences`

- **Description**:
  - Returns the content of `preferences.md`.
- **Implementation**:
  - `engine.getNoteContent("preferences.md")` or empty string.
  - Provides the startup preferences block used by Pi (see [[preferences]]).

### `prepare_subagent`

- **Description**:
  - Packages context for a child Pi session (subagent).
- **Input**:
  - `prompt: string` – top-level task description.
  - `plan: string` – detailed implementation plan.
  - `success_criteria: string` – measurable completion criteria.
- **Implementation**:
  - `engine.buildSubagentPackage({ prompt, plan, successCriteria })`:
    - Runs hybrid retrieval using plan+prompt.
    - Builds `SubagentPackage` (see [[context_engine-data-models]]).
    - `formattedSystemPrompt` combines:
      - Task, plan, success criteria, retrieved context.
  - Calls `onSubagentPrepared(pkg)` if provided.
  - Returns `pkg.formattedSystemPrompt` as text.
- **Usage**:
  - See [[subagent_context_packaging]] for the orchestrator side:
    - The orchestrator calls this before spawning a subagent session.

## Relationship to the orchestrator

- The orchestrator integrates this server via an MCP transport and exposes:
  - `retrieve_context` as a tool inside Pi sessions.
  - `prepare_subagent` inside the subagent extension.
- Overall architecture described in [[obsidiclaw]].

This interface is the only way Pi and extensions should talk to the [[context_engine-overview]] in production.
