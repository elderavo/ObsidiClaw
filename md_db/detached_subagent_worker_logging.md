---
title: Detached subagent worker logging and diagnostics
type: concept
created: 2026-03-21T07:56:15.880Z
updated: 2026-03-21T07:56:15.880Z
source_trigger: session_end
tags: [subagent, worker, logging, tui, detached]
---
**Issue:** TUI-triggered detached subagent workers queued jobs but produced no result because the spawned process ran with `stdio: "ignore"` and had no log path, so crashes were silent. Manual runs (`node scripts/run_detached_subagent.js ...`) worked, indicating the worker script is fine when executed directly.

**Likely causes:** Missing/outdated dist build, path/exec issues, or early exceptions; lack of logging hid the root cause.

**Fixes added:**
- Specs now include `logPath`; workers log to `<job>.log` alongside the result JSON.
- Result JSON records `logPath` for quick inspection.

**Verification steps (TUI):**
1) `/reload` to pick up updated extensions.
2) Run `spawn_subagent_detached(...)` again.
3) Check `.obsidi-claw/subagents/<job>.log` for worker trace and `<job>.result.json` for status/output.
4) If nothing appears, the spawn likely failed—temporarily set `stdio` to inherit or add launcher logging to capture spawn errors.

## Source
Derived automatically (trigger: session_end). Reason: Captures project-specific lessons on silent detached worker failures and the new logging/diagnostic workflow for subagent jobs.
