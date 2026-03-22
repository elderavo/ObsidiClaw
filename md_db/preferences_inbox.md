---
type: concept
---

# Preferences Inbox

Pending proposals auto-derived from sessions. Review and merge manually.


## Proposal (2026-03-21T07:56:15.880Z) — trigger: session_end
- action: add
  section: General Principles
  rule_id: 13. Background jobs logging
  text: When spawning detached or background processes, avoid silent failures: capture stdout/stderr to a log file (or inherit), and ensure required build artifacts exist before dispatch.
  reason: Detached worker failed silently due to stdio being ignored and missing logs; capturing output and verifying artifacts prevents invisible crashes.

## Proposal (2026-03-21T23:28:12.129Z) — trigger: session_end
- action: add
  section: Tools & Tool‑Building
  rule_id: subagents-avoid-blocking
  text: Default to handling small or quick tasks in-process; avoid detached subagents unless the task is long-running or truly parallelizable. If a detached subagent is considered, ask Alex first and warn that chat will be blocked until it completes.
  reason: User rated a subagent run 1/3 because they could not talk until the subagent finished; prefer responsive, in-chat actions for simple tasks.
