---
type: subagent_spec
created: {{ISO_DATE}}
---

# Subagent Spec: {{TITLE}}

## Task

{{One-sentence description of what the subagent must accomplish.}}

## Plan

{{Step-by-step implementation plan. Be explicit — the subagent has no prior context
beyond what you provide here and what the knowledge base retrieves. Include:
  - Which files to read/write
  - Which tools to call and in what order
  - Key decision points and how to handle them
  - What "done" looks like structurally}}

## Context

{{Any facts the subagent needs that won't be in the knowledge base:
  - Runtime values (IDs, URLs, paths) discovered during the parent session
  - Constraints or decisions already made by the parent agent
  - Leave blank if everything is in the knowledge base}}

## Success Criteria

{{Unambiguous, checkable conditions. Prefer observable outputs:
  - "File X exists and contains Y"
  - "Function foo returns Z for input W"
  - "tsc --noEmit passes with no errors"
  NOT: "task is complete" or "looks good"}}
