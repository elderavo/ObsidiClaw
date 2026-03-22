---
id: b2df30cb-96f0-46f5-95a7-af93f9bc9f7a
uuid: b2df30cb-96f0-46f5-95a7-af93f9bc9f7a
type: concept
created: 2026-03-21T07:56:40.107Z
updated: 2026-03-22T06:21:23.239Z
tags:
md_db: true
---
# Preferences Inbox

Pending proposals auto-derived from sessions. Review and merge manually.

## TODO — Make markdown note titles act as one-line summaries
- Treat the H1/title field as high-signal metadata; use it as a one-line summary.
- Action: audit md_db/* notes and rewrite titles to be descriptive (no placeholders or templates).
- Outcome: better retrieval and skimming because titles carry meaning.

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

## Session 3eba47e8 (2026-03-22)

### Signals
- **[weak concession]** "Bye!"
  → The agent acknowledged the end of the conversation with a polite farewell.

## Session 93441ba7 (2026-03-22)

### Signals
- **[weak praise]** "yes please"
  → User confirmed acceptance of changes with positive response.
- **[strong imperative]** "close() is now async: sends shutdown, kills the subprocess, awaits its exit (with a 2s timeout), then cleans up and rejects any leftover RPCs."
  → Agent should implement asynchronous shutdown with explicit timeout handling for subprocesses.
- **[moderate imperative]** "Added waitForSubprocessExit helper."
  → Agent should include a helper function to wait for subprocess exit before proceeding.
- **[weak correction]** "preventing 'The database connection is not open.'"
  → Previous implementation had race condition with logger.close; new approach ensures proper cleanup sequence.

### Synthesized Preferences
- **[strong]** Implement asynchronous shutdown with explicit timeout handling for subprocesses, including a helper function to wait for exit before proceeding.
  - Evidence: User confirmed acceptance of changes and agent provided detailed implementation notes showing new approach ensures proper cleanup sequence.

## Session aac98e07 (2026-03-22)

### Signals
- **[moderate imperative]** "Did you mean '/quit' or something else?"
  → User wants clarification on command, prefers explicit confirmation of intent before proceeding.
