// Centralized model-facing prompt strings and template snippets.

export const TOOL_REMINDER = `
## ObsidiClaw Knowledge Base

The context block above was automatically retrieved from the knowledge base for your prompt. If it doesn't cover what you need, call \`retrieve_context\` again with a more specific query.
`.trim();

export const ENGINE_UNAVAILABLE_WARNING = `
## ⚠️ ObsidiClaw Context Engine Unavailable

The context engine failed to initialize. You are running **without** knowledge base access.

- \`retrieve_context\` and \`rate_context\` will not work this session.
- Preferences and project structure injection may be missing or stale.
- You must rely on direct file reads (\`read\`, \`bash\`) instead of retrieval.

**Likely causes**: the knowledge graph subprocess failed to start, the conda environment is missing, or the database is corrupted.
`.trim();

// Subagent footers (shared between RAG + no-RAG prompts)
export const SUBAGENT_FOOTER_BASE_LINES = [
  "",
  "---",
  "Focus exclusively on the plan above. Work systematically towards the success criteria.",
];

export const SUBAGENT_RAG_FOOTER_LINES = [
  ...SUBAGENT_FOOTER_BASE_LINES,
  "Use `retrieve_context` for additional knowledge lookup.",
];

// Context reviewer fallback (when personality content is missing)
export const CONTEXT_REVIEW_FALLBACK_SYSTEM_PROMPT =
  "You synthesize retrieved context into focused, query-relevant summaries.";

// Session review (subagent spec)
export const SESSION_REVIEW_PROMPT =
  "You are a review subagent. Read the provided session transcript and current preferences/meta-notes (via retrieval). Decide if any general, enduring preference should be updated, and whether any specific heuristic/insight should become a new concept note. Output JSON per schema.";

export const SESSION_REVIEW_PLAN = `
1) Skim transcript for corrections, strong preferences, repeated patterns.
2) Check if these are already encoded in preferences/meta-notes (via retrieval context).
3) For each candidate lesson, decide:
   - General + durable -> preferences update.
   - Specific/domain -> new concept note.
4) Limit to at most 3 preference updates and 3 new notes.
5) Produce JSON per schema; avoid duplicates; include reasons.`;

export const SESSION_REVIEW_SUCCESS_CRITERIA = `
- Output valid JSON only.
- Max 3 preference updates, max 3 new notes.
- Each item has a concise reason.
- No secrets or private data. Preference changes must be general, not project-specific.`;

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

// Detached session review (no context engine)
export const DETACHED_SESSION_REVIEW_SYSTEM_PROMPT = `You analyze conversations between a user and an AI coding agent to extract preferences and behavioral signals. Respond with JSON only: { "signals": [...], "preferences": [...] }. If the conversation is purely task execution with no preference signals, return empty lists.`;

// Code summarization job
export const SUMMARIZE_CODE_SYSTEM_PROMPT = `You are a senior software engineer writing internal documentation. Given a source code file, its structured mirror note (imports, exports, call graph), and the project directory tree, write a concise 2-3 sentence technical description of what this module does and why it exists. Be precise and technical. Write in present tense. Output only the description — no headers, no preamble, no bullet points.`;

// Merge preferences inbox job
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
