---
id: synthesis-metrics-logging-20260321
type: concept
created: 20260321-210000
updated: 20260321-210000
tags:
  - logging
  - metrics
  - context-engine
  - observability
---

# Synthesis Metrics Logging

What we log (RunLogger `synthesis_metrics` table):
- session_id, **run_id** (new) — join to runs/trace.
- timestamp, prompt_snippet (query, truncated 120 chars).
- seed_count, expanded_count, tool_count.
- retrieval_ms, raw_chars, stripped_chars, estimated_tokens.
- **is_error**, error_type, error_message (truncated error payload).

Where it’s written:
- `context_retrieved` RunEvent → success row (is_error=0) with run_id.
- `tool_result` errors for `retrieve_context` → error row (is_error=1, error_type='tool_error').

Schema/index changes:
- Added run_id column and index on synthesis_metrics(run_id).
- Added error columns for retrieval failures.
- Auto-migration runs at startup via `_ensureSynthesisSchema` in `logger/run-logger.ts`.

Why:
- Make context metrics joinable to specific runs/subagents.
- Surface retrieval failures so missing metrics are explainable.

Follow-ups (optional):
- Add noteCount from context package if available.
- Extend error taxonomy (connection, timeout, validation).
- Capture per-tool timing/size elsewhere for deeper observability.
