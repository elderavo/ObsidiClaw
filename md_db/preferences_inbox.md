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
