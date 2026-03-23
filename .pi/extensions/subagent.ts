/**
 * Subagent Extension
 *
 * Enables the main Pi agent to spawn a focused in-process subagent.
 * This is a thin wrapper around SubagentRunner — the first-class subagent entity
 * that can also be called from the scheduler or standalone scripts.
 *
 * Workflow:
 *   1. Main agent calls spawn_subagent(plan, context, success_criteria, personality?)
 *   2. Extension delegates to SubagentRunner.run(spec)
 *   3. Subagent runs to completion; run is marked `awaiting_review` in runs.db
 *   4. Tool result instructs the main agent to ask the user for a grade
 *   5. Main agent calls grade_subagent(run_id, score, feedback) → persisted
 *
 * Human review loop:
 *   Subagent runs finalize as `awaiting_review` instead of `done`. The main
 *   agent is instructed to ask the user for a utility score (1-3) and optional
 *   feedback. This creates a training signal for the insight engine.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ContextEngine } from "../../knowledge/engine/index.js";
import { RunLogger } from "../../logger/run-logger.js";
import { SubagentRunner } from "../../agents/subagent/subagent-runner.js";
import { resolvePaths, type ObsidiClawPaths } from "../../core/config.js";
import { getSharedEngine, getSharedRunner } from "../../entry/extension.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SubagentExtensionConfig {
  /** Parent's ContextEngine — reused instead of creating a second one. */
  contextEngine?: ContextEngine;
  /** Explicit paths. Defaults to resolvePaths(). */
  paths?: ObsidiClawPaths;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function subagentExtension(
  pi: ExtensionAPI,
  config: SubagentExtensionConfig = {},
) {
  const paths = config.paths ?? resolvePaths();

  // Engine — may be provided or lazily created
  let engine: ContextEngine | undefined = config.contextEngine;
  let ownsEngine = false;

  // SubagentRunner — lazily created once engine is ready
  let runner: SubagentRunner | undefined;

  // Track completed subagent runs awaiting review (run_id → plan summary)
  const pendingReviews = new Map<string, { plan: string; output: string; durationS: number }>();

  async function ensureRunner(): Promise<SubagentRunner> {
    if (runner) return runner;

    // Prefer shared instances from the main ObsidiClaw extension (avoids duplicate engine)
    const sharedRunner = getSharedRunner();
    if (sharedRunner) {
      runner = sharedRunner;
      return runner;
    }

    // Fallback: create own engine if main extension hasn't initialized yet
    if (!engine) {
      const sharedEngine = getSharedEngine();
      if (sharedEngine) {
        engine = sharedEngine;
      } else {
        engine = new ContextEngine({ mdDbPath: paths.mdDbPath });
        await engine.initialize();
        ownsEngine = true;
      }
    }

    runner = new SubagentRunner({
      dbPath: paths.dbPath,
      contextEngine: engine,
      rootDir: paths.rootDir,
    });

    return runner;
  }

  // ── spawn_subagent tool ───────────────────────────────────────────────────
  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Subagent",
    description:
      "Launch a focused in-process Pi subagent. Before calling, create a detailed " +
      "implementation spec. The subagent gets full retrieve_context access and a system " +
      "prompt built from the plan + retrieved knowledge + optional personality. " +
      "After the subagent finishes, you MUST ask the user to grade the result using grade_subagent.",
    promptSnippet: "spawn_subagent(plan, context, success_criteria, personality?) — launch focused subagent",
    promptGuidelines: [
      "Write a detailed plan before calling — the plan drives knowledge retrieval",
      "success_criteria should be unambiguous and measurable",
      "Use context to pass any facts the subagent needs that aren't in the knowledge base",
      "Use personality to select a behavioral profile (e.g., 'deep-researcher', 'code-reviewer')",
      "IMPORTANT: After receiving the result, immediately ask the user to review it with grade_subagent",
    ],
    parameters: Type.Object({
      plan: Type.String({
        description: "Detailed implementation plan for the subagent to execute",
      }),
      context: Type.String({
        description: "Additional background facts from the main agent (complements retrieved knowledge)",
      }),
      success_criteria: Type.String({
        description: "Clear, measurable criteria for determining task completion",
      }),
      personality: Type.Optional(
        Type.String({
          description: "Named personality profile (e.g., 'deep-researcher', 'code-reviewer', 'context-gardener')",
        }),
      ),
      timeout_minutes: Type.Optional(
        Type.Number({
          description: "Max runtime in minutes (default: 5, max: 30)",
          minimum: 1,
          maximum: 30,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const r = await ensureRunner();

      onUpdate?.({
        content: [{ type: "text", text: "Preparing and running subagent..." }],
        details: { status: "running" },
      });

      const result = await r.run(
        {
          prompt: params.context.trim() || params.plan,
          plan: params.plan,
          successCriteria: params.success_criteria,
          personality: params.personality,
          callerContext: params.context,
          timeoutMs: (params.timeout_minutes ?? 5) * 60 * 1000,
        },
        signal,
      );

      const durationS = Math.round(result.durationMs / 1000);

      // Mark as awaiting review
      if (result.runId && result.outcome === "done") {
        const logger = new RunLogger({ dbPath: paths.dbPath });
        try {
          logger.markAwaitingReview(result.runId);
        } finally {
          logger.close();
        }
      }

      if (result.outcome === "cancelled") {
        return {
          content: [{ type: "text" as const, text: `Subagent cancelled after ${durationS}s.\n\n${result.output}` }],
          details: { outcome: "cancelled", duration_ms: result.durationMs },
        };
      }

      if (result.outcome === "timeout") {
        return {
          content: [{ type: "text" as const, text: `Subagent timed out after ${params.timeout_minutes ?? 5}m.\n\n${result.output}` }],
          details: { outcome: "timeout", duration_ms: result.durationMs },
        };
      }

      if (result.outcome === "error") {
        return {
          content: [{ type: "text" as const, text: `Subagent error: ${result.output}` }],
          details: { outcome: "error", duration_ms: result.durationMs },
        };
      }

      // Track for grade_subagent
      if (result.runId) {
        pendingReviews.set(result.runId, {
          plan: params.plan.slice(0, 200),
          output: result.output.slice(0, 500),
          durationS,
        });
      }

      return {
        content: [{
          type: "text" as const,
          text: [
            `**Subagent completed** (${durationS}s)`,
            `**Run ID:** \`${result.runId}\``,
            "",
            result.output,
            "",
            "---",
            `**Review required.** Please ask the user to grade this subagent result.`,
            `Use \`grade_subagent\` with run_id \`${result.runId}\`, a utility score (1-3), and any feedback.`,
          ].join("\n"),
        }],
        details: { outcome: "awaiting_review", run_id: result.runId, duration_ms: result.durationMs },
      };
    },
  });

  // ── grade_subagent tool — human review of subagent results ────────────────
  pi.registerTool({
    name: "grade_subagent",
    label: "Grade Subagent Result",
    description:
      "Record the user's review of a subagent run. Call this after showing the user " +
      "a subagent's output and asking them to rate it. The score and feedback are " +
      "persisted to runs.db for the insight engine to learn from.",
    promptSnippet: "grade_subagent(run_id, utility_score, feedback) — record human review",
    promptGuidelines: [
      "Ask the user: 'How useful was this subagent result? (1 = not useful, 2 = partially useful, 3 = fully useful)'",
      "If the user gives a score below 3, ask what was wrong or missing",
      "Pass the user's exact words as feedback — don't summarize or filter",
    ],
    parameters: Type.Object({
      run_id: Type.String({
        description: "The run_id returned by spawn_subagent",
      }),
      utility_score: Type.Number({
        description: "User's utility rating: 1 (not useful), 2 (partially useful), 3 (fully useful)",
        minimum: 1,
        maximum: 3,
      }),
      feedback: Type.Optional(
        Type.String({
          description: "User's feedback on what was wrong, missing, or could be improved. Required if score < 3.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const score = Math.round(params.utility_score);
      if (score < 1 || score > 3) {
        return {
          content: [{ type: "text" as const, text: "Invalid score. Must be 1, 2, or 3." }],
        };
      }

      const feedback = params.feedback?.trim() || null;
      if (score < 3 && !feedback) {
        return {
          content: [{ type: "text" as const, text: "Feedback is required when utility score is below 3. Please ask the user what was wrong or missing." }],
        };
      }

      const logger = new RunLogger({ dbPath: paths.dbPath });
      try {
        logger.recordReview(params.run_id, score, feedback);
      } finally {
        logger.close();
      }

      const meta = pendingReviews.get(params.run_id);
      pendingReviews.delete(params.run_id);

      const scoreLabel = score === 3 ? "fully useful" : score === 2 ? "partially useful" : "not useful";

      return {
        content: [{
          type: "text" as const,
          text: [
            `Review recorded for run \`${params.run_id}\`.`,
            `Score: **${score}/3** (${scoreLabel})`,
            feedback ? `Feedback: ${feedback}` : "",
          ].filter(Boolean).join("\n"),
        }],
        details: {
          run_id: params.run_id,
          score,
          feedback,
          plan_snippet: meta?.plan,
        },
      };
    },
  });

  // ── session_shutdown: clean up ────────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    if (ownsEngine) engine?.close();
  });
}
