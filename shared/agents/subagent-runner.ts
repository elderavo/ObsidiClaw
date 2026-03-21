/**
 * SubagentRunner — first-class subagent executor.
 *
 * Can be called from anywhere without requiring a parent Pi session:
 *   - Pi tool handler (spawn_subagent)
 *   - Scheduler job
 *   - Standalone script
 *   - Context reviewer
 *
 * Encapsulates the full subagent lifecycle:
 *   1. Load personality (if specified)
 *   2. Build system prompt (with or without RAG context)
 *   3. Create child OrchestratorSession
 *   4. Run prompt with timeout/abort
 *   5. Extract output, dispose, return result
 */

import { randomUUID } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { RunLogger } from "../../logger/run-logger.js";
import { OrchestratorSession } from "../../orchestrator/session.js";
import { loadPersonality } from "./personality-loader.js";
import { spawnProcess, getExecPath } from "../os/process.js";
import { ensureDir, writeText } from "../os/fs.js";
import type { ContextEngine } from "../../context_engine/context-engine.js";
import type { PersonalityConfig, SubagentSpec, SubagentResult } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PERSONALITIES_DIR = join(__dirname, "personalities");
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SubagentRunnerConfig {
  /** Path to runs.db for event logging. */
  dbPath: string;

  /** ContextEngine for RAG. Optional — runs without RAG if omitted. */
  contextEngine?: ContextEngine;

  /** Path to personalities directory. Default: shared/agents/personalities/ */
  personalitiesDir?: string;

  /** Root directory for detached subagent work dirs. */
  rootDir?: string;
}

// ---------------------------------------------------------------------------
// SubagentRunner
// ---------------------------------------------------------------------------

export class SubagentRunner {
  private readonly config: Required<Omit<SubagentRunnerConfig, "contextEngine">> & {
    contextEngine?: ContextEngine;
  };

  constructor(config: SubagentRunnerConfig) {
    this.config = {
      dbPath: config.dbPath,
      contextEngine: config.contextEngine,
      personalitiesDir: config.personalitiesDir ?? DEFAULT_PERSONALITIES_DIR,
      rootDir: config.rootDir ?? process.cwd(),
    };
  }

  /**
   * Run a subagent to completion.
   *
   * Creates a child OrchestratorSession, runs the plan, extracts the
   * last assistant message, and returns a SubagentResult.
   */
  async run(spec: SubagentSpec, signal?: AbortSignal): Promise<SubagentResult> {
    const startTime = Date.now();
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // ── Load personality ───────────────────────────────────────────────
    let personality: PersonalityConfig | null = null;
    if (spec.personality) {
      personality = loadPersonality(spec.personality, this.config.personalitiesDir);
    }

    // ── Build system prompt ────────────────────────────────────────────
    let systemPrompt: string;

    if (this.config.contextEngine) {
      // RAG path: use the engine to build a context-enriched system prompt
      const pkg = await this.config.contextEngine.buildSubagentPackage({
        prompt: spec.callerContext?.trim() || spec.prompt,
        plan: spec.plan,
        successCriteria: spec.successCriteria,
        personality: spec.personality,
      });
      systemPrompt = pkg.formattedSystemPrompt;
    } else {
      // No-RAG path: build system prompt from personality + spec directly
      systemPrompt = formatSystemPromptNoRAG(spec, personality);
    }

    // ── Create child session ───────────────────────────────────────────
    const childLogger = new RunLogger({ dbPath: this.config.dbPath });
    let outputBuffer = "";

    const childSession = new OrchestratorSession(
      childLogger,
      this.config.contextEngine,
      {
        systemPrompt,
        onOutput: (delta) => { outputBuffer += delta; },
        isSubagent: true,
        model: personality?.provider?.model,
      },
    );

    // ── Run with timeout + cancellation ────────────────────────────────
    const runPromise = (async (): Promise<"done"> => {
      await childSession.prompt(spec.plan);
      return "done";
    })();

    const timeoutPromise = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), timeoutMs);
      if (timer.unref) timer.unref();
    });

    let cancelResolve: ((v: "cancelled") => void) | undefined;
    const cancelPromise = new Promise<"cancelled">((resolve) => {
      cancelResolve = resolve;
    });
    const abortHandler = () => cancelResolve?.("cancelled");
    signal?.addEventListener("abort", abortHandler, { once: true });

    let outcome: "done" | "timeout" | "cancelled";
    let runId = "";

    try {
      outcome = await Promise.race([runPromise, timeoutPromise, cancelPromise]);
      runId = childSession.lastRunId;
    } catch (err) {
      runId = childSession.lastRunId;
      return {
        runId,
        outcome: "error",
        output: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    } finally {
      signal?.removeEventListener("abort", abortHandler);
      childSession.dispose();
      childLogger.close();
    }

    // ── Extract output ─────────────────────────────────────────────────
    const messages = childSession.messages as Array<{ role: string; content: unknown }>;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const output = extractMessageText(lastAssistant?.content) || outputBuffer || "(no output)";

    return {
      runId,
      outcome,
      output,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Run a subagent in a detached child process (fire-and-forget).
   * Returns immediately with the job ID and result path.
   */
  runDetached(spec: SubagentSpec): { jobId: string; resultPath: string } {
    const jobId = randomUUID();
    const workDir = join(this.config.rootDir, ".obsidi-claw", "subagents");
    const specPath = join(workDir, `${jobId}.json`);
    const resultPath = join(workDir, `${jobId}.result.json`);
    const logPath = join(workDir, `${jobId}.log`);
    const scriptPath = join(this.config.rootDir, "dist", "scripts", "run_detached_subagent.js");

    ensureDir(workDir);

    const specJson = {
      type: "subagent",
      jobId,
      rootDir: this.config.rootDir,
      plan: spec.plan,
      context: spec.callerContext ?? "",
      successCriteria: spec.successCriteria,
      personality: spec.personality,
      timeoutMinutes: spec.timeoutMs ? spec.timeoutMs / 60_000 : undefined,
      resultPath,
      logPath,
      createdAt: Date.now(),
    };

    writeText(specPath, JSON.stringify(specJson, null, 2));

    const child = spawnProcess(getExecPath(), [scriptPath, specPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    return { jobId, resultPath };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a system prompt without RAG context.
 * Used when no ContextEngine is available.
 */
function formatSystemPromptNoRAG(
  spec: SubagentSpec,
  personality: PersonalityConfig | null,
): string {
  const sections: string[] = ["# Subagent Task"];

  if (personality) {
    sections.push("", "## Personality", personality.content);
  }

  sections.push(
    "",
    "## Your Task",
    spec.prompt,
    "",
    "## Implementation Plan",
    spec.plan,
    "",
    "## Success Criteria",
    spec.successCriteria,
  );

  if (spec.callerContext) {
    sections.push("", "## Additional Context", spec.callerContext);
  }

  sections.push(
    "",
    "---",
    "Focus exclusively on the plan above. Work systematically towards the success criteria.",
  );

  return sections.join("\n");
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((c) => typeof c?.text === "string")
      .map((c) => c.text!)
      .join("\n");
  }
  return "";
}
