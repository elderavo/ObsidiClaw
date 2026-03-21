/**
 * Subagent Extension
 *
 * Enables the main Pi agent to spawn a focused in-process subagent.
 *
 * Workflow:
 *   1. Main agent calls spawn_subagent(plan, context, success_criteria)
 *   2. Extension calls MCP prepare_subagent → ContextEngine builds SubagentPackage
 *   3. Extension creates a child OrchestratorSession with injected system prompt
 *   4. Subagent runs to completion; run is marked `awaiting_review` in runs.db
 *   5. Tool result instructs the main agent to ask the user for a grade
 *   6. Main agent calls grade_subagent(run_id, score, feedback) → persisted
 *
 * Human review loop:
 *   Subagent runs finalize as `awaiting_review` instead of `done`. The main
 *   agent is instructed to ask the user for a utility score (1-3) and optional
 *   feedback. This creates a training signal for refining the context engine's
 *   prompt synthesizer over time.
 */

import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ContextEngine } from "../../context_engine/index.js";
import { createContextEngineMcpServer } from "../../context_engine/index.js";
import { RunLogger } from "../../logger/run-logger.js";
import { OrchestratorSession } from "../../orchestrator/session.js";
import { resolvePaths, type ObsidiClawPaths } from "../../shared/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(result: unknown): string {
  const blocks = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return blocks.find((c) => c.type === "text")?.text ?? "";
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SubagentExtensionConfig {
  /** Parent's ContextEngine — reused instead of creating a second one. */
  contextEngine?: ContextEngine;
  /** Explicit paths. Defaults to resolvePaths(). */
  paths?: ObsidiClawPaths;
  /** Explicit session ID. Defaults to a new UUID. */
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function subagentExtension(
  pi: ExtensionAPI,
  config: SubagentExtensionConfig = {},
) {
  const paths = config.paths ?? resolvePaths();
  const sessionId = config.sessionId ?? randomUUID();

  // Engine + MCP client — may be provided or lazily created
  let engine: ContextEngine | undefined = config.contextEngine;
  let ownsEngine = false;
  let mcpClient: Client | undefined;

  // Track completed subagent runs awaiting review (run_id → plan summary)
  const pendingReviews = new Map<string, { plan: string; output: string; durationS: number }>();

  async function ensureInitialized(): Promise<void> {
    if (engine && mcpClient) return;

    if (!engine) {
      engine = new ContextEngine({ mdDbPath: paths.mdDbPath });
      await engine.initialize();
      ownsEngine = true;
    }

    const server = createContextEngineMcpServer(engine);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    mcpClient = new Client({ name: "subagent-ext", version: "1.0.0" });

    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
  }

  // ── spawn_subagent tool ───────────────────────────────────────────────────
  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Subagent",
    description:
      "Launch a focused in-process Pi subagent. Before calling, create a detailed " +
      "implementation spec using the subagent spec template. The subagent gets full " +
      "retrieve_context access and a system prompt built from the plan + retrieved knowledge. " +
      "After the subagent finishes, you MUST ask the user to grade the result using grade_subagent.",
    promptSnippet: "spawn_subagent(plan, context, success_criteria) — launch focused subagent",
    promptGuidelines: [
      "Write a detailed plan before calling — the plan drives knowledge retrieval",
      "success_criteria should be unambiguous and measurable",
      "Use context to pass any facts the subagent needs that aren't in the knowledge base",
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
      timeout_minutes: Type.Optional(
        Type.Number({
          description: "Max runtime in minutes (default: 5, max: 30)",
          minimum: 1,
          maximum: 30,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      await ensureInitialized();

      const startTime = Date.now();

      // ── Step 1: prepare_subagent via MCP ─────────────────────────────────
      onUpdate?.({
        content: [{ type: "text", text: "Retrieving context for subagent..." }],
        details: { status: "preparing" },
      });

      const prepResult = await mcpClient!.callTool({
        name: "prepare_subagent",
        arguments: {
          prompt: params.context.trim() || params.plan,
          plan: params.plan,
          success_criteria: params.success_criteria,
        },
      });

      const formattedSystemPrompt = extractText(prepResult);

      if (!formattedSystemPrompt) {
        return {
          content: [{ type: "text" as const, text: "prepare_subagent returned no content — cannot spawn subagent." }],
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: "Context packaged. Spawning subagent..." }],
        details: { status: "spawning" },
      });

      // ── Step 2: create child OrchestratorSession ──────────────────────────
      const childLogger = new RunLogger({ dbPath: paths.dbPath });

      let outputBuffer = "";
      const childSession = new OrchestratorSession(childLogger, engine, {
        systemPrompt: formattedSystemPrompt,
        onOutput: (delta) => { outputBuffer += delta; },
        isSubagent: true,
      });

      // ── Step 3: run the subagent with timeout + cancellation ─────────────
      const timeoutMs = (params.timeout_minutes ?? 5) * 60 * 1000;

      const runPromise = (async (): Promise<"done"> => {
        await childSession.prompt(params.plan);
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

        // Mark subagent run as awaiting human review instead of 'done'
        if (runId && outcome === "done") {
          childLogger.markAwaitingReview(runId);
        }
      } finally {
        signal?.removeEventListener("abort", abortHandler);
        childSession.dispose();
        childLogger.close();
      }

      // ── Step 4: extract output ────────────────────────────────────────────
      const messages = childSession.messages as Array<{ role: string; content: unknown }>;
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      const output = extractMessageText(lastAssistant?.content) || outputBuffer || "(no output)";

      const durationS = Math.round((Date.now() - startTime) / 1000);

      if (outcome === "cancelled") {
        return {
          content: [{ type: "text" as const, text: `Subagent cancelled after ${durationS}s.\n\n${output}` }],
          details: { outcome: "cancelled", duration_ms: Date.now() - startTime },
        };
      }

      if (outcome === "timeout") {
        return {
          content: [{ type: "text" as const, text: `Subagent timed out after ${params.timeout_minutes ?? 5}m.\n\n${output}` }],
          details: { outcome: "timeout", duration_ms: Date.now() - startTime },
        };
      }

      // Track this run for the grade_subagent tool
      if (runId) {
        pendingReviews.set(runId, {
          plan: params.plan.slice(0, 200),
          output: output.slice(0, 500),
          durationS,
        });
      }

      return {
        content: [{
          type: "text" as const,
          text: [
            `**Subagent completed** (${durationS}s)`,
            `**Run ID:** \`${runId}\``,
            "",
            output,
            "",
            "---",
            `**Review required.** Please ask the user to grade this subagent result.`,
            `Use \`grade_subagent\` with run_id \`${runId}\`, a utility score (1-3), and any feedback.`,
          ].join("\n"),
        }],
        details: { outcome: "awaiting_review", run_id: runId, duration_ms: Date.now() - startTime },
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

      // Open a fresh logger to record the review (the child logger is long closed)
      const logger = new RunLogger({ dbPath: paths.dbPath });
      try {
        logger.recordReview(params.run_id, score, feedback);
      } finally {
        logger.close();
      }

      // Clean up from pending list
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

  // ── spawn_subagent_detached tool — fire-and-forget background run ────────
  pi.registerTool({
    name: "spawn_subagent_detached",
    label: "Spawn Subagent (Detached)",
    description:
      "Queue a subagent to run in a detached worker process. The worker packages context, " +
      "runs the subagent, logs to runs.db under this session, and writes a result JSON to .obsidi-claw/subagents.",
    promptSnippet: "spawn_subagent_detached(plan, context, success_criteria) — background subagent",
    promptGuidelines: [
      "Provide a detailed plan; the worker will run it with packaged context.",
      "Check the result JSON path to read the output.",
    ],
    parameters: Type.Object({
      plan: Type.String({ description: "Detailed implementation plan for the subagent to execute" }),
      context: Type.String({ description: "Additional background facts (optional, empty ok)" }),
      success_criteria: Type.String({ description: "Clear, measurable criteria for success" }),
      timeout_minutes: Type.Optional(
        Type.Number({ description: "Timeout in minutes (default 5, max 30)", minimum: 1, maximum: 30 }),
      ),
    }),

    async execute(_toolCallId, params) {
      const jobId = randomUUID();
      const workDir = join(paths.rootDir, ".obsidi-claw", "subagents");
      const specPath = join(workDir, `${jobId}.json`);
      const resultPath = join(workDir, `${jobId}.result.json`);
      const logPath = join(workDir, `${jobId}.log`);
      const scriptPath = join(paths.rootDir, "dist", "scripts", "run_detached_subagent.js");

      mkdirSync(workDir, { recursive: true });

      const spec = {
        type: "subagent",
        jobId,
        sessionId,
        rootDir: paths.rootDir,
        mdDbPath: paths.mdDbPath,
        plan: params.plan,
        context: params.context,
        successCriteria: params.success_criteria,
        timeoutMinutes: params.timeout_minutes,
        resultPath,
        logPath,
        createdAt: Date.now(),
      };

      writeFileSync(specPath, JSON.stringify(spec, null, 2), "utf8");

      const child = spawn(process.execPath, [scriptPath, specPath], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      return {
        content: [
          {
            type: "text" as const,
            text: `Detached subagent queued.\njob: ${jobId}\nsession: ${sessionId}\nspec: ${specPath}\nresult: ${resultPath}`,
          },
        ],
        details: { job_id: jobId, session_id: sessionId, spec_path: specPath, result_path: resultPath },
      };
    },
  });

  // ── session_shutdown: clean up ────────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    await mcpClient?.close();
    if (ownsEngine) engine?.close();
  });
}
