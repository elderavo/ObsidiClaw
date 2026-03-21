---
title: Session Review Hooks
type: concept
created: 2026-03-21T00:00:00Z
updated: 2026-03-21T00:00:00Z
---

# Session Review Hooks

Automatically runs a review subagent at session end (and pre-compaction when available) to capture lessons and proposed preference updates.

## What it does
- On **session_end**: spawns a review subagent (via ContextEngine subagent package) to inspect the transcript and propose:
  - General, durable changes → appended as proposals to `preferences_inbox.md` (not directly to `preferences.md`).
  - Specific/project insights → new concept notes under `md_db/concepts/auto/`.
- On **pre_compaction**: if a Pi compaction event is observed, runs a lightweight review to snapshot key context before it is compacted.
- Skips when the session is already a subagent or when no ContextEngine is available.

## Files & locations
- Implementation: `insight_engine/session_review.ts`
- Orchestrator hooks: `orchestrator/session.ts` (`runReviewHook`, `finalize`) and `orchestrator/orchestrator.ts` (awaits `finalize()` in single-shot runs).
- Output targets:
  - `md_db/preferences_inbox.md` (append-only proposals for manual merge)
  - `md_db/concepts/auto/<slug>.md` (auto-derived insights)

## Safety & scope
- Does **not** auto-edit `preferences.md` to avoid destabilizing the system prompt.
- Limits proposed changes (max ~3 per category) and requires reasons.
- Subagent sessions are excluded to avoid recursion.

## Follow-ups
- Confirm actual Pi compaction event name; currently listens for `event.type === "compaction"`.
- (Optional) Reindex after auto-notes if you need immediate availability; currently deferred to next startup.
