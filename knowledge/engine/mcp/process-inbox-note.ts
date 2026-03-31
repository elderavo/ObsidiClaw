/**
 * Inbox pipeline for "know" workspace notes.
 *
 * Steps (run in order, each blocking the next):
 *   1. TODO resolution   — fill #TODO lines via LLM
 *   2. Tag suggestions   — propose tags from context + LLM; must be non-empty to promote
 *   3. Atomicity check   — detect multi-concept notes; flag with ## ⚠️ Atomicity section
 *   4. Promotion         — obsidian move to notes/permanent | notes/synthesized | sources/
 *
 * Returns a StepResult per step so callers can report details back to Pi.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { llmChat, ProviderUnreachableError } from "../../../core/llm-client.js";
import { parseFrontmatter, buildFrontmatter } from "../../../knowledge/markdown/frontmatter.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StepStatus = "ok" | "skipped" | "blocked" | "error";

export interface StepResult {
  step: string;
  status: StepStatus;
  detail: string;
}

export interface InboxPipelineResult {
  filePath: string;
  steps: StepResult[];
  promoted: boolean;
  destination?: string;
}

export interface InboxPipelineOptions {
  /** Absolute path to the vault root. */
  vaultDir: string;
  /** Absolute path to the inbox .md file. */
  filePath: string;
  /**
   * Optional: call retrieve_context for tag suggestions.
   * Returns raw markdown from the context engine.
   */
  retrieveContext?: (query: string, workspace: string) => Promise<string>;
  /** Workspace name (for retrieve_context scoping). */
  workspace?: string;
  /** LLM timeout per call in ms. Default: 60_000. */
  llmTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function processInboxNote(opts: InboxPipelineOptions): Promise<InboxPipelineResult> {
  const { vaultDir, filePath, retrieveContext, workspace, llmTimeoutMs = 60_000 } = opts;
  const steps: StepResult[] = [];

  // Read note
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    return {
      filePath,
      steps: [{ step: "read", status: "error", detail: `Cannot read file: ${err}` }],
      promoted: false,
    };
  }

  const { frontmatter, body } = splitNote(raw);

  const noteTitle = String(frontmatter.title ?? basename(filePath, ".md"));

  // ── Step 1: TODO resolution ────────────────────────────────────────────────
  const todoResult = await resolveTodos(body, noteTitle, llmTimeoutMs);
  steps.push(todoResult.step);

  let resolvedBody = todoResult.body;

  if (todoResult.step.status === "blocked") {
    writeNote(filePath, frontmatter, resolvedBody);
    return { filePath, steps, promoted: false };
  }

  // ── Step 2: Tag suggestions ────────────────────────────────────────────────
  const tagResult = await suggestTags(
    resolvedBody,
    frontmatter,
    retrieveContext,
    workspace,
    llmTimeoutMs,
  );
  steps.push(tagResult.step);

  if (tagResult.tags.length > 0) {
    frontmatter.tags = tagResult.tags;
  }

  if (tagResult.step.status === "blocked") {
    writeNote(filePath, frontmatter, resolvedBody);
    return { filePath, steps, promoted: false };
  }

  // ── Step 3: Atomicity check ────────────────────────────────────────────────
  const atomicityResult = await checkAtomicity(
    resolvedBody,
    noteTitle,
    llmTimeoutMs,
  );
  steps.push(atomicityResult.step);

  if (atomicityResult.blocked) {
    resolvedBody = resolvedBody.trimEnd() + "\n\n" + atomicityResult.flagSection;
    writeNote(filePath, frontmatter, resolvedBody);
    return { filePath, steps, promoted: false };
  }

  // Write back resolved body + updated tags before promotion
  writeNote(filePath, frontmatter, resolvedBody);

  // ── Step 4: Promotion ──────────────────────────────────────────────────────
  const promotionResult = await promote(vaultDir, filePath, String(frontmatter.type ?? "permanent"));
  steps.push(promotionResult.step);

  return {
    filePath,
    steps,
    promoted: promotionResult.step.status === "ok",
    destination: promotionResult.destination,
  };
}

// ---------------------------------------------------------------------------
// Step 1: TODO resolution
// ---------------------------------------------------------------------------

interface TodoStepResult {
  step: StepResult;
  body: string;
}

async function resolveTodos(body: string, title: string, timeoutMs: number): Promise<TodoStepResult> {
  const todoLines = body.match(/^.*#TODO.*$/gm);

  if (!todoLines || todoLines.length === 0) {
    return { step: { step: "todos", status: "ok", detail: "No TODOs found." }, body };
  }

  try {
    const { content } = await llmChat(
      [
        {
          role: "system",
          content:
            `You are a precise knowledge assistant. You will be given a markdown note and a list of #TODO items. ` +
            `For each TODO, replace the entire line with the completed content inline. ` +
            `Return the FULL note body with all #TODO lines replaced. Do not add explanations. ` +
            `Do not wrap in code blocks. Preserve all other content exactly.`,
        },
        {
          role: "user",
          content:
            `Note title: ${title}\n\nNote body:\n${body}\n\nTODOs to resolve:\n${todoLines.join("\n")}`,
        },
      ],
      { timeout: timeoutMs, temperature: 0.3 },
    );

    const remaining = content.match(/^.*#TODO.*$/gm);
    if (remaining && remaining.length > 0) {
      return {
        step: {
          step: "todos",
          status: "blocked",
          detail: `LLM could not resolve ${remaining.length} TODO(s): ${remaining.join("; ")}`,
        },
        body,
      };
    }

    return {
      step: {
        step: "todos",
        status: "ok",
        detail: `Resolved ${todoLines.length} TODO(s).`,
      },
      body: content,
    };
  } catch (err) {
    if (err instanceof ProviderUnreachableError) {
      return {
        step: {
          step: "todos",
          status: "blocked",
          detail: `LLM unreachable — cannot resolve ${todoLines.length} TODO(s) before promotion.`,
        },
        body,
      };
    }
    return {
      step: { step: "todos", status: "error", detail: `TODO resolution failed: ${err}` },
      body,
    };
  }
}

// ---------------------------------------------------------------------------
// Step 2: Tag suggestions
// ---------------------------------------------------------------------------

interface TagStepResult {
  step: StepResult;
  tags: string[];
}

async function suggestTags(
  body: string,
  frontmatter: Record<string, unknown>,
  retrieveContext: ((q: string, ws: string) => Promise<string>) | undefined,
  workspace: string | undefined,
  timeoutMs: number,
): Promise<TagStepResult> {
  const existingTags = Array.isArray(frontmatter.tags) ? (frontmatter.tags as string[]).filter(Boolean) : [];

  if (existingTags.length > 0) {
    return {
      step: { step: "tags", status: "ok", detail: `Tags already set: ${existingTags.join(", ")}` },
      tags: existingTags,
    };
  }

  const title = String(frontmatter.title ?? "");

  // Pull context tags as hints
  let contextHint = "";
  if (retrieveContext && workspace) {
    try {
      const ctx = await retrieveContext(`${title} ${body.slice(0, 300)}`, workspace);
      if (!ctx.startsWith("## Nothing Found")) {
        // Extract yaml tags from retrieved context
        const tagMatches = ctx.match(/tags:\s*\[([^\]]+)\]/g) ?? [];
        const inlineTags = ctx.match(/- (\w[\w-]+)/g)?.map((t) => t.slice(2)) ?? [];
        contextHint = `Existing related tags from the knowledge base: ${[...tagMatches, ...inlineTags].slice(0, 15).join(", ")}`;
      }
    } catch {
      // retrieve_context failure is non-fatal
    }
  }

  try {
    const { content } = await llmChat(
      [
        {
          role: "system",
          content:
            `You are a Zettelkasten librarian. Given a note, return 3–6 concise lowercase tags that best describe its topic. ` +
            `Tags should be single words or hyphenated phrases (e.g. machine-learning, attention, neural-networks). ` +
            `Return ONLY a comma-separated list of tags. No explanation, no punctuation beyond commas and hyphens.` +
            (contextHint ? `\n\n${contextHint}` : ""),
        },
        {
          role: "user",
          content: `Title: ${title}\n\n${body.slice(0, 800)}`,
        },
      ],
      { timeout: timeoutMs, temperature: 0.2 },
    );

    const tags = content
      .split(",")
      .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9-]/g, ""))
      .filter(Boolean)
      .slice(0, 8);

    if (tags.length === 0) {
      return {
        step: { step: "tags", status: "blocked", detail: "LLM returned no tags — cannot promote without tags." },
        tags: [],
      };
    }

    return {
      step: { step: "tags", status: "ok", detail: `Suggested tags: ${tags.join(", ")}` },
      tags,
    };
  } catch (err) {
    if (err instanceof ProviderUnreachableError) {
      return {
        step: { step: "tags", status: "blocked", detail: "LLM unreachable — tags required before promotion." },
        tags: [],
      };
    }
    return {
      step: { step: "tags", status: "error", detail: `Tag suggestion failed: ${err}` },
      tags: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Step 3: Atomicity check
// ---------------------------------------------------------------------------

interface AtomicityStepResult {
  step: StepResult;
  blocked: boolean;
  flagSection: string;
}

async function checkAtomicity(body: string, title: string, timeoutMs: number): Promise<AtomicityStepResult> {
  try {
    const { content } = await llmChat(
      [
        {
          role: "system",
          content:
            `You are a Zettelkasten reviewer. Determine whether the given note covers exactly one atomic concept. ` +
            `If it covers exactly one concept, respond with: ATOMIC\n` +
            `If it covers multiple concepts, respond with: SPLIT\n` +
            `Then on subsequent lines, list each concept as a bullet point starting with "- ". ` +
            `Nothing else.`,
        },
        {
          role: "user",
          content: `Title: ${title}\n\n${body.slice(0, 1200)}`,
        },
      ],
      { timeout: timeoutMs, temperature: 0.1 },
    );

    const trimmed = content.trim();
    if (trimmed.startsWith("SPLIT")) {
      const bullets = trimmed
        .split("\n")
        .filter((l) => l.startsWith("- "))
        .join("\n");
      const flagSection =
        `## ⚠️ Atomicity\n\n` +
        `This note may cover multiple concepts. Consider splitting into:\n\n${bullets}\n\n` +
        `Resolve this section and delete it before the note can be promoted.`;
      return {
        step: {
          step: "atomicity",
          status: "blocked",
          detail: `Multi-concept note detected. Split suggestions added to note body.`,
        },
        blocked: true,
        flagSection,
      };
    }

    return {
      step: { step: "atomicity", status: "ok", detail: "Single concept confirmed." },
      blocked: false,
      flagSection: "",
    };
  } catch (err) {
    if (err instanceof ProviderUnreachableError) {
      // Non-blocking: skip atomicity check if LLM is unavailable
      return {
        step: { step: "atomicity", status: "skipped", detail: "LLM unreachable — atomicity check skipped." },
        blocked: false,
        flagSection: "",
      };
    }
    return {
      step: { step: "atomicity", status: "skipped", detail: `Atomicity check failed (non-blocking): ${err}` },
      blocked: false,
      flagSection: "",
    };
  }
}

// ---------------------------------------------------------------------------
// Step 4: Promotion
// ---------------------------------------------------------------------------

interface PromotionStepResult {
  step: StepResult;
  destination?: string;
}

async function promote(
  vaultDir: string,
  filePath: string,
  noteType: string,
): Promise<PromotionStepResult> {
  const destinationDir =
    noteType === "source" ? "sources" :
    noteType === "synthesized" ? "notes/synthesized" :
    "notes/permanent";

  const slug = basename(filePath);
  const destination = `${destinationDir}/${slug}`;
  const vaultName = basename(vaultDir);

  try {
    await execFileAsync("obsidian", [
      `vault=${vaultName}`,
      "move",
      `path=notes/inbox/${slug}`,
      `to=${destinationDir}`,
    ]);

    return {
      step: {
        step: "promote",
        status: "ok",
        detail: `Moved to ${destination}`,
      },
      destination: join(vaultDir, destinationDir, slug),
    };
  } catch (err) {
    // obsidian CLI may fail if Obsidian isn't open — write exact error so user can diagnose
    return {
      step: {
        step: "promote",
        status: "error",
        detail: `obsidian move failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitNote(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  try {
    const parsed = parseFrontmatter(raw);
    return { frontmatter: parsed.frontmatter, body: parsed.body };
  } catch {
    return { frontmatter: {}, body: raw };
  }
}

function writeNote(filePath: string, frontmatter: Record<string, unknown>, body: string): void {
  const fm = buildFrontmatter(frontmatter);
  writeFileSync(filePath, fm + "\n" + body.trimStart(), "utf-8");
}
