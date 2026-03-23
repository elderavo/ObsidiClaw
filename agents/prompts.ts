// Centralized model-facing prompt strings and template snippets.

// Used in entry/extension.ts to remind about KB and engine availability in UI prompts.
export const TOOL_REMINDER = `
## ObsidiClaw Knowledge Base

The context block above was automatically retrieved from the knowledge base for your prompt. If it doesn't cover what you need, call \`retrieve_context\` again with a more specific query.
`.trim();

// Used in entry/extension.ts to warn when the context engine is unavailable.
export const ENGINE_UNAVAILABLE_WARNING = `
## ⚠️ ObsidiClaw Context Engine Unavailable

The context engine failed to initialize. You are running **without** knowledge base access.

- \`retrieve_context\` and \`rate_context\` will not work this session.
- Preferences and project structure injection may be missing or stale.
- You must rely on direct file reads (\`read\`, \`bash\`) instead of retrieval.

**Likely causes**: the knowledge graph subprocess failed to start, the conda environment is missing, or the database is corrupted.
`.trim();

// Used in knowledge/engine/mcp/mcp-server.ts; appended to every retrieve_context result to prompt rating.
export const RATE_CONTEXT_REMINDER = `
<!-- After using this context, call rate_context to report how well it answered your query. -->
`.trim();

// Used in agents/subagent/subagent-runner.ts to append shared footer guidance.
export const SUBAGENT_FOOTER_BASE_LINES = [
  "",
  "---",
  "Focus exclusively on the plan above. Work systematically towards the success criteria.",
];

// Used in knowledge/engine/context-engine.ts when composing RAG subagent prompts.
export const SUBAGENT_RAG_FOOTER_LINES = [
  ...SUBAGENT_FOOTER_BASE_LINES,
  "Use `retrieve_context` for additional knowledge lookup.",
];

// Used in knowledge/engine/review/context-reviewer.ts when no personality content is available.
export const CONTEXT_REVIEW_FALLBACK_SYSTEM_PROMPT =
  "You synthesize retrieved context into focused, query-relevant summaries.";

// Used in agents/insight/session_review.ts for the session review subagent.
export const SESSION_REVIEW_PROMPT =
  "You are a review subagent. Read the provided session transcript and current preferences/meta-notes (via retrieval). Decide if any general, enduring preference should be updated, and whether any specific heuristic/insight should become a new concept note. Output JSON per schema.";

// Used in agents/insight/session_review.ts to outline the review subagent plan.
export const SESSION_REVIEW_PLAN = `
1) Skim transcript for corrections, strong preferences, repeated patterns.
2) Check if these are already encoded in preferences/meta-notes (via retrieval context).
3) For each candidate lesson, decide:
   - General + durable -> preferences update.
   - Specific/domain -> new concept note.
4) Limit to at most 3 preference updates and 3 new notes.
5) Produce JSON per schema; avoid duplicates; include reasons.`;

// Used in agents/insight/session_review.ts as success criteria for the review subagent.
export const SESSION_REVIEW_SUCCESS_CRITERIA = `
- Output valid JSON only.
- Max 3 preference updates, max 3 new notes.
- Each item has a concise reason.
- No secrets or private data. Preference changes must be general, not project-specific.`;

// Used in agents/insight/session_review.ts to describe the JSON schema for session reviews.
export const SESSION_REVIEW_SCHEMA_TEXT = `
Schema (JSON):
{
  "trigger": "session_end" | "pre_compaction",
  "should_update_preferences": boolean,
  "preferences_updates": [
    { "action": "add"|"modify"|"deprecate", "section": string, "rule_id": string, "text": string, "reason": string }
  ],
  "new_notes": [
    { "path": string, "title": string, "type": string, "tags": string[], "body": string, "reason": string }
  ]
}
All fields optional except trigger. Keep lists small (<=3 items each).`;

// Used in automation/scripts/run_session_review.ts when running session review without context engine.
export const DETACHED_SESSION_REVIEW_SYSTEM_PROMPT = `You analyze conversations between a user and an AI coding agent to extract preferences and behavioral signals. Respond with JSON only: { "signals": [...], "preferences": [...] }. If the conversation is purely task execution with no preference signals, return empty lists.`;

// Used in automation/jobs/scheduled/summarize-code.ts as the default system prompt for code summaries.
export const SUMMARIZE_CODE_SYSTEM_PROMPT = `You are a senior software engineer writing internal documentation. Given a source code file, its structured mirror note (imports, exports, call graph), and a list of existing tags, provide a technical summary and relevant tags. Write a concise 2-3 sentence description of what this module does and why it exists. Pick 2-5 tags from the existing list (prefer reuse, only create new if needed). Respond in exactly this format:
TAGS: tag1, tag2, tag3
SUMMARY: Your summary here.`;

// Used in automation/jobs/scheduled/merge-inbox.ts as the system prompt for merging preferences inbox items.
export const MERGE_INBOX_SYSTEM_PROMPT = `You help maintain an AI agent's preferences.md file.

You receive:
1. A "preferences inbox" containing signals and synthesized preferences from recent sessions
2. The current preferences.md file

Your job:
- Decide which inbox items should be **added** to preferences.md as new rules
- Decide which inbox items should **modify** existing rules in preferences.md
- Decide which inbox items should **be dropped** (too weak, already covered, or contradictory)

Rules for promotion:
- **Strong** items: always promote (explicit user instruction)
- **Moderate** items: promote if they appear in 2+ sessions, or if they reinforce an existing preference
- **Weak** items: drop unless they form a pattern with other signals
- Never add duplicate rules — if the preference is already covered, skip it
- Never contradict existing strong preferences without noting the conflict
- Keep rules concise and actionable

Respond with JSON only:
{
  "additions": [
    { "rule": "concise rule for preferences.md", "evidence": "which session/signal this came from" }
  ],
  "modifications": [
    { "find": "exact text to find in preferences.md", "replace": "replacement text", "reason": "why" }
  ],
  "dropped": [
    { "item": "what was dropped", "reason": "why" }
  ]
}

If nothing needs to change, return {"additions": [], "modifications": [], "dropped": []}`;
