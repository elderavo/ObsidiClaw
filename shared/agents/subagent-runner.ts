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

import { RunLogger } from "../../logger/run-logger.js";
import { OrchestratorSession } from "../../orchestrator/session.js";
import { loadPersonality } from "./personality-loader.js";
import { extractMessageText } from "../text-utils.js";
import { resolvePaths } from "../config.js";
import type { ContextEngine } from "../../context_engine/context-engine.js";
import type { PersonalityConfig, SubagentSpec, SubagentResult } from "./types.js";
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

}

// ---------------------------------------------------------------------------
// SubagentRunner
// ---------------------------------------------------------------------------

export class SubagentRunner {
  private readonly config: {
    dbPath: string;
    contextEngine?: ContextEngine;
    personalitiesDir: string;
  };

  constructor(config: SubagentRunnerConfig) {
    this.config = {
      dbPath: config.dbPath,
      contextEngine: config.contextEngine,
      personalitiesDir: config.personalitiesDir ?? resolvePaths().personalitiesDir,
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
        runKind: "subagent",
        model: personality?.provider?.model,
        parentRunId: spec.parentRunId,
        parentSessionId: spec.parentSessionId,
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

