import { dirname, join } from "path";
import { ContextEngine } from "../context_engine/index.js";
import { resolvePaths } from "../shared/config.js";
import { extractMessageText } from "../shared/text-utils.js";
import { ensureDir, fileExists, readText, writeText } from "../shared/os/fs.js";
import { buildFrontmatter } from "../shared/markdown/frontmatter.js";

export type ReviewTrigger = "session_end" | "pre_compaction";

interface ReviewProposal {
  trigger: ReviewTrigger;
  should_update_preferences?: boolean;
  preferences_updates?: Array<{
    action?: "add" | "modify" | "deprecate";
    section?: string;
    rule_id?: string;
    text?: string;
    reason?: string;
  }>;
  new_notes?: Array<{
    path?: string;
    title?: string;
    type?: string;
    tags?: string[];
    body?: string;
    reason?: string;
  }>;
}

interface ReviewRunner {
  runReview: (userMessage: string) => Promise<string>;
  dispose: () => void;
}

export interface SessionReviewOptions {
  trigger: ReviewTrigger;
  sessionId: string;
  messages: unknown[];
  contextEngine?: ContextEngine;
  compactionMeta?: unknown;
  now?: () => number;
  rootDir?: string;
  createChildSession: (systemPrompt: string) => Promise<ReviewRunner>;
}

const MAX_MESSAGES = 40;
const MAX_TRANSCRIPT_CHARS = 16000;

export async function runSessionReview(opts: SessionReviewOptions): Promise<void> {
  const { contextEngine } = opts;
  if (!contextEngine) return;

  const timestamp = (opts.now ?? Date.now)();
  const transcript = formatTranscript(opts.messages);

  const { prompt, plan, successCriteria, schemaText } = buildSpec();

  const pkg = await contextEngine.buildSubagentPackage({ prompt, plan, successCriteria });

  const systemPrompt = [
    pkg.formattedSystemPrompt,
    "",
    "## Output Format",
    "Respond with JSON only, matching the schema described below. Do not wrap in Markdown.",
    schemaText,
  ].join("\n");

  const runner = await opts.createChildSession(systemPrompt);

  try {
    const userMessage = buildUserMessage({
      trigger: opts.trigger,
      sessionId: opts.sessionId,
      transcript,
      compactionMeta: opts.compactionMeta,
    });

    const raw = await runner.runReview(userMessage);
    const proposal = parseProposal(raw, opts.trigger);
    if (!proposal) return;

    await applyProposal({ proposal, timestamp, rootDir: opts.rootDir ?? resolvePaths().rootDir });
  } finally {
    runner.dispose();
  }
}

function buildSpec() {
  const schemaText = `
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

  const prompt = `You are a review subagent. Read the provided session transcript and current preferences/meta-notes (via retrieval). Decide if any general, enduring preference should be updated, and whether any specific heuristic/insight should become a new concept note. Output JSON per schema.`;

  const plan = `
1) Skim transcript for corrections, strong preferences, repeated patterns.
2) Check if these are already encoded in preferences/meta-notes (via retrieval context).
3) For each candidate lesson, decide:
   - General + durable -> preferences update.
   - Specific/domain -> new concept note.
4) Limit to at most 3 preference updates and 3 new notes.
5) Produce JSON per schema; avoid duplicates; include reasons.`;

  const successCriteria = `
- Output valid JSON only.
- Max 3 preference updates, max 3 new notes.
- Each item has a concise reason.
- No secrets or private data. Preference changes must be general, not project-specific.`;

  return { prompt, plan, successCriteria, schemaText };
}

function buildUserMessage(input: { trigger: ReviewTrigger; sessionId: string; transcript: string; compactionMeta?: unknown }) {
  return [
    `Trigger: ${input.trigger}`,
    `Session: ${input.sessionId}`,
    input.compactionMeta ? `Compaction meta: ${JSON.stringify(input.compactionMeta).slice(0, 2000)}` : undefined,
    "\n## Transcript (trimmed)",
    input.transcript,
    "\nRemember: respond with JSON only (no markdown).",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatTranscript(messages: unknown[]): string {
  if (!Array.isArray(messages)) return "(no transcript)";
  const sliced = messages.slice(-MAX_MESSAGES);
  const mapped = sliced.map((m, idx) => {
    const role = (m as any)?.role ?? `msg_${idx}`;
    const content = stringifyContent((m as any)?.content);
    return `- ${role}: ${content}`;
  });
  const joined = mapped.join("\n");
  if (joined.length <= MAX_TRANSCRIPT_CHARS) return joined;
  return joined.slice(-MAX_TRANSCRIPT_CHARS);
}

function stringifyContent(content: unknown): string {
  const text = extractMessageText(content);
  if (text) return text;
  return JSON.stringify(content ?? "");
}

function parseProposal(raw: string, trigger: ReviewTrigger): ReviewProposal | null {
  const txt = raw.trim();
  const jsonStr = extractJson(txt);
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr) as ReviewProposal;
    if (!parsed.trigger) parsed.trigger = trigger;
    return parsed;
  } catch {
    return null;
  }
}

function extractJson(txt: string): string | null {
  if (!txt) return null;
  // If already valid JSON
  try {
    JSON.parse(txt);
    return txt;
  } catch {}

  // Try to extract first {...} block
  const match = txt.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

async function applyProposal(opts: { proposal: ReviewProposal; timestamp: number; rootDir: string }) {
  const { proposal, timestamp, rootDir } = opts;
  if (!proposal.preferences_updates?.length && !proposal.new_notes?.length) return;

  if (proposal.preferences_updates?.length) {
    appendPreferencesInbox({
      updates: proposal.preferences_updates,
      trigger: proposal.trigger,
      timestamp,
      rootDir,
    });
  }

  if (proposal.new_notes?.length) {
    for (const note of proposal.new_notes) {
      writeNewNote({ note, trigger: proposal.trigger, timestamp, rootDir });
    }
  }
}

function appendPreferencesInbox(opts: { updates: NonNullable<ReviewProposal["preferences_updates"]>; trigger: ReviewTrigger; timestamp: number; rootDir: string }) {
  const inboxPath = join(opts.rootDir, "md_db", "preferences_inbox.md");
  ensureDir(dirname(inboxPath));

  const header = fileExists(inboxPath) ? "" : `---\ntype: concept\n---\n\n# Preferences Inbox\n\nPending proposals auto-derived from sessions. Review and merge manually.\n\n`;

  const lines: string[] = [];
  lines.push(`\n## Proposal (${new Date(opts.timestamp).toISOString()}) — trigger: ${opts.trigger}`);
  for (const u of opts.updates) {
    lines.push("- action: " + (u.action ?? "add"));
    if (u.section) lines.push(`  section: ${u.section}`);
    if (u.rule_id) lines.push(`  rule_id: ${u.rule_id}`);
    if (u.text) lines.push(`  text: ${u.text}`);
    if (u.reason) lines.push(`  reason: ${u.reason}`);
  }

  const blob = header + lines.join("\n") + "\n";
  writeText(inboxPath, (fileExists(inboxPath) ? readText(inboxPath) : "") + blob);
}

function writeNewNote(opts: { note: NonNullable<ReviewProposal["new_notes"]>[number]; trigger: ReviewTrigger; timestamp: number; rootDir: string }) {
  const root = join(opts.rootDir, "md_db");
  const title = opts.note.title?.trim() || "Auto-derived Insight";
  const slug = slugify(opts.note.path || title);
  const relPath = opts.note.path?.trim() || join("concepts", "auto", `${slug}.md`).replace(/\\/g, "/");
  const absPath = join(root, relPath);

  ensureDir(dirname(absPath));

  const bodyProvided = opts.note.body?.trim();
  const tags = opts.note.tags?.length ? opts.note.tags : ["auto-derived", "insight"];
  const type = opts.note.type?.trim() || "concept";

  const fm = buildFrontmatter({
    title,
    type,
    created: new Date(opts.timestamp).toISOString(),
    updated: new Date(opts.timestamp).toISOString(),
    source_trigger: opts.trigger,
    tags,
  });

  const reason = opts.note.reason ? `\n\n## Source\nDerived automatically (trigger: ${opts.trigger}). Reason: ${opts.note.reason}` : "";

  const content = fm + (bodyProvided || "(no content provided)") + reason + "\n";

  writeText(absPath, content);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "note";
}
