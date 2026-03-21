---
title: Detached subagents and review workers
type: concept
created: 2026-03-21T07:22:23.289Z
updated: 2026-03-21T07:22:23.289Z
source_trigger: session_end
tags: [detached, subagent, review, session_logger]
---
- Detached workers added:
  - `scripts/run_detached_subagent.js` runs a packaged subagent in a detached Node process, initializes its own ContextEngine/Ollama, logs under the shared session_id, and writes result JSON to `.obsidi-claw/subagents/<job>.result.json`.
  - `scripts/run_review_worker.js` runs the session review subagent detached, logs under the shared session_id, writes result JSON to `.obsidi-claw/reviews/<job>.result.json`, and still writes preference inbox / auto-notes.
- Subagent extension now exposes `spawn_subagent_detached` (fire-and-forget): writes a spec to `.obsidi-claw/subagents/`, spawns the worker, and returns job/spec/result paths.
- TUI exit enqueues a detached review job automatically; no inline review run.
- Shared `session_id` is stored on `globalThis` so detached runs and the session logger align with the parent session in `runs.db`; no extra orchestrator run required.
- Error handling: detached runner logs `prompt_error` and updates run status even if engine init or run fails; ensures final result writes on errors. Optional context inputs are handled in new tool types. Processes are `unref`'d and Node path correctness on Windows was verified.
- After modifying `.pi` extensions, run `/reload` (or restart Pi) to pick up changes.

## Source
Derived automatically (trigger: session_end). Reason: Capture the newly introduced detached subagent/review workflow, logging behavior, and usage steps for future reference.
