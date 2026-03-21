---
title: Detached subagent result checks
type: concept
created: 2026-03-21T07:27:48.611Z
updated: 2026-03-21T07:27:48.611Z
source_trigger: session_end
tags: [subagent, detached, ops]
---
When using spawn_subagent_detached, the .result.json may not appear immediately; allow a short delay, then check .obsidi-claw/subagents/<jobId>.result.json. If missing or debugging is needed, you can manually run the spec via `node scripts/run_detached_subagent.js <specPath>` to surface errors. Job metadata is stored alongside the spec and results (and runs.db logs by sessionId).

## Source
Derived automatically (trigger: session_end). Reason: Captured the observed workflow for confirming detached subagent outputs and the manual recovery path if the result file lags or is missing.
