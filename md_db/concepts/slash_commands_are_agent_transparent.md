---
type: concept
tags:
    - architecture
    - extension_layer
    - agent_boundary
workspace: obsidi-claw
---
# Slash Commands Are Transparent to the Agent

Slash commands are handled entirely at the extension layer and never reach the agent. The agent does not see the command text, does not respond to it, and should have no awareness that it was invoked. This is the contract that makes slash commands feel like TUI affordances rather than conversation turns.

## Why

The agent is for reasoning and task execution. Slash commands are for meta-operations: switching context, configuring state, invoking infrastructure. Mixing them collapses the boundary between "talking to the AI" and "operating the tool," which makes both worse. If the agent sees a `/workspace obsidi-claw` command, it's now in the conversation history and the agent may reference or respond to it — which is noise.

## What violation looks like

Using `ctx.ui.pasteToEditor()` or `ctx.ui.setEditorText()` inside a slash command handler to make the agent process something. This is the anti-pattern: the command appears to be extension-layer but secretly hands off to the agent by injecting into the input. The escape hatch is valid when you genuinely need AI reasoning (e.g. a `/debug` command that pastes a diagnostic prompt), but that should be the explicit intent — not a workaround for not wiring up a direct call.

## How to apply

Slash commands interact only with `ctx.ui.*` (for input/display) and call stack/registry methods directly (for infrastructure). The MCP tools are the agent-facing API for conversational workspace management. The slash command is the human-facing shortcut that calls the same underlying layer, bypassing the agent entirely. Two entry points, one infrastructure layer.
