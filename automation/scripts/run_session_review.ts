/**
 * Session review worker — extracts preferences from conversation history.
 *
 * Runs as a detached child process on session shutdown. Self-contained:
 * no ContextEngine, no Python, no Pi session. Just Ollama.
 *
 * Pipeline:
 *   1. Read spec JSON (contains full message history)
 *   2. Extract user/assistant conversation pairs as readable text
 *   3. Send to Ollama — identify imperatives, preferences, praise,
 *      concessions, and synthesize overarching preferences
 *   4. Append findings to md_db/preferences_inbox.md
 *   5. Delete the spec file (transcript no longer needed)
 *
 * Usage: node dist/automation/scripts/run_session_review.js <specPath>
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import axios from "axios";

import { getOllamaConfig, resolvePaths } from "../../core/config.js";
import { loadPersonality } from "../../agents/subagent/personality-loader.js";
import { DETACHED_SESSION_REVIEW_SYSTEM_PROMPT } from "../../agents/prompts.js";
import { readText, writeText, ensureDir, appendText, fileExists } from "../../core/os/fs.js";
import { exitProcess } from "../../core/os/process.js";

// ---------------------------------------------------------------------------
// Spec shape (written by extension/factory.ts on session_shutdown)
// ---------------------------------------------------------------------------

interface ReviewSpec {
  type: "review";
  jobId: string;
  sessionId: string;
  rootDir: string;
  trigger: string;
  messages: unknown[];
  mdDbPath: string;
  resultPath: string;
  logPath: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// LLM response shape
// ---------------------------------------------------------------------------

interface ReviewFindings {
  signals: Array<{
    type: "imperative" | "preference" | "praise" | "concession" | "correction";
    quote: string;
    synthesis: string;
    strength: "strong" | "moderate" | "weak";
  }>;
  preferences: Array<{
    rule: string;
    reason: string;
    strength: "strong" | "moderate" | "weak";
  }>;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const specPath = process.argv[2];
  if (!specPath) {
    process.stderr.write("Usage: run_session_review.js <specPath>\n");
    exitProcess(1);
  }

  const spec: ReviewSpec = JSON.parse(readText(specPath));
  const logPath = spec.logPath;
  const resultPath = spec.resultPath;
  const startedAt = Date.now();

  ensureDir(dirname(resultPath));
  ensureDir(dirname(logPath));

  const log = (msg: string) => {
    appendText(logPath, `[${new Date().toISOString()}] ${msg}\n`);
  };

  log(`Review started: ${spec.jobId}`);
  log(`Session: ${spec.sessionId}, trigger: ${spec.trigger}`);

  try {
    // ── Step 1: Extract readable conversation ─────────────────────────────
    const conversation = extractConversation(spec.messages);
    log(`Extracted ${conversation.turns} turns (${conversation.text.length} chars)`);

    if (conversation.turns === 0) {
      writeResult(resultPath, { jobId: spec.jobId, sessionId: spec.sessionId, status: "skipped", reason: "no conversation turns", startedAt, finishedAt: Date.now() });
      log("Skipped: no conversation turns");
      cleanupSpec(specPath, log);
      return;
    }

    // ── Step 2: Send to Ollama ────────────────────────────────────────────
    const personality = loadPersonality("session-reviewer", resolvePaths(spec.rootDir).personalitiesDir);
    const findings = await analyzeConversation(conversation.text, log, personality?.content, personality?.provider);

    if (!findings || (findings.signals.length === 0 && findings.preferences.length === 0)) {
      writeResult(resultPath, { jobId: spec.jobId, sessionId: spec.sessionId, status: "done", reason: "no actionable findings", signalCount: 0, preferenceCount: 0, startedAt, finishedAt: Date.now() });
      log("No actionable findings");
      cleanupSpec(specPath, log);
      return;
    }

    log(`Found ${findings.signals.length} signals, ${findings.preferences.length} synthesized preferences`);

    // ── Step 3: Write to inbox ────────────────────────────────────────────
    appendToInbox(spec.rootDir, spec.sessionId, findings);
    log(`Written to preferences_inbox.md`);

    writeResult(resultPath, {
      jobId: spec.jobId,
      sessionId: spec.sessionId,
      status: "done",
      signalCount: findings.signals.length,
      preferenceCount: findings.preferences.length,
      startedAt,
      finishedAt: Date.now(),
    });

    // ── Step 4: Cleanup transcript ────────────────────────────────────────
    cleanupSpec(specPath, log);

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`ERROR: ${error}`);
    if (err instanceof Error && err.stack) log(err.stack);
    writeResult(resultPath, { jobId: spec.jobId, sessionId: spec.sessionId, status: "error", error, startedAt, finishedAt: Date.now() });
  }
}

// ---------------------------------------------------------------------------
// Step 1: Extract readable conversation pairs
// ---------------------------------------------------------------------------

interface Conversation {
  text: string;
  turns: number;
}

function extractConversation(messages: unknown[]): Conversation {
  if (!Array.isArray(messages)) return { text: "", turns: 0 };

  const lines: string[] = [];
  let turns = 0;

  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown };
    const role = msg.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = extractText(msg.content).trim();
    if (!text) continue;

    // Truncate very long assistant replies — the user's words matter more
    const maxLen = role === "user" ? 2000 : 800;
    const truncated = text.length > maxLen
      ? text.slice(0, maxLen) + "\n[...truncated]"
      : text;

    lines.push(`**${role === "user" ? "User" : "Agent"}:**`);
    lines.push(truncated);
    lines.push("");
    turns++;
  }

  // Cap total to ~12k chars to stay within context window
  let result = lines.join("\n");
  if (result.length > 12000) {
    result = result.slice(-12000);
    result = "...(earlier conversation truncated)\n\n" + result;
  }

  return { text: result, turns: Math.ceil(turns / 2) };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : (c as { text?: string })?.text ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && "text" in content) {
    return String((content as { text: unknown }).text);
  }
  return "";
}

// ---------------------------------------------------------------------------
// Step 2: Analyze with Ollama
// ---------------------------------------------------------------------------

async function analyzeConversation(
  conversation: string,
  log: (msg: string) => void,
  systemPrompt?: string,
  providerOverride?: { model?: string; baseUrl?: string },
): Promise<ReviewFindings | null> {
  const ollama = getOllamaConfig({ model: providerOverride?.model, baseUrl: providerOverride?.baseUrl });
  const host = ollama.baseUrl.replace(/\/v1\/?$/, "");

  log(`Calling Ollama (${ollama.model}) at ${host}`);

  const response = await axios.post(
    `${host}/api/chat`,
    {
      model: ollama.model,
      messages: [
        { role: "system", content: systemPrompt ?? DETACHED_SESSION_REVIEW_SYSTEM_PROMPT },
        { role: "user", content: `## Conversation\n\n${conversation}` },
      ],
      stream: false,
      options: { num_ctx: 16384, temperature: 0.1 },
    },
    { timeout: 120_000, signal: AbortSignal.timeout(120_000) },
  );

  const raw = response.data?.message?.content ?? "";
  log(`LLM response: ${raw.length} chars`);

  if (!raw.trim()) return null;

  const jsonStr = extractJson(raw);
  if (!jsonStr) {
    log(`Failed to parse JSON: ${raw.slice(0, 300)}`);
    return null;
  }

  try {
    const parsed = JSON.parse(jsonStr) as ReviewFindings;
    if (!parsed.signals) parsed.signals = [];
    if (!parsed.preferences) parsed.preferences = [];
    return parsed;
  } catch {
    log(`JSON parse error: ${jsonStr.slice(0, 300)}`);
    return null;
  }
}

function extractJson(txt: string): string | null {
  try { JSON.parse(txt); return txt; } catch {}
  const match = txt.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// Step 3: Write to inbox
// ---------------------------------------------------------------------------

function appendToInbox(rootDir: string, sessionId: string, findings: ReviewFindings) {
  const inboxPath = join(rootDir, "md_db", "preferences_inbox.md");
  ensureDir(dirname(inboxPath));

  const header = fileExists(inboxPath)
    ? ""
    : `---\ntype: concept\n---\n\n# Preferences Inbox\n\nAuto-derived from session reviews. Strong items should be merged into preferences.md.\n\n`;

  const lines: string[] = [];
  const date = new Date().toISOString().slice(0, 10);
  lines.push(`\n## Session ${sessionId.slice(0, 8)} (${date})`);

  if (findings.signals.length > 0) {
    lines.push("\n### Signals");
    for (const s of findings.signals) {
      lines.push(`- **[${s.strength} ${s.type}]** "${s.quote}"`);
      lines.push(`  → ${s.synthesis}`);
    }
  }

  if (findings.preferences.length > 0) {
    lines.push("\n### Synthesized Preferences");
    for (const p of findings.preferences) {
      lines.push(`- **[${p.strength}]** ${p.rule}`);
      lines.push(`  - Evidence: ${p.reason}`);
    }
  }

  const existing = fileExists(inboxPath) ? readText(inboxPath) : "";
  writeText(inboxPath, existing + header + lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function cleanupSpec(specPath: string, log: (msg: string) => void) {
  try {
    require("fs").unlinkSync(specPath);
    log(`Cleaned up spec: ${specPath}`);
  } catch {
    log(`Warning: could not delete spec ${specPath}`);
  }
}

function writeResult(resultPath: string, data: Record<string, unknown>) {
  writeText(resultPath, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile || process.argv[1] === currentFile.replace(/\.ts$/, ".js")) {
  main().catch((err) => {
    process.stderr.write(String(err) + "\n");
    exitProcess(1);
  });
}
