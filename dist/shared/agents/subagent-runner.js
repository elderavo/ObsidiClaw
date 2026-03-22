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
import { extractMessageText } from "../text-utils.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PERSONALITIES_DIR = join(__dirname, "personalities");
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
// ---------------------------------------------------------------------------
// SubagentRunner
// ---------------------------------------------------------------------------
export class SubagentRunner {
    config;
    constructor(config) {
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
    async run(spec, signal) {
        const startTime = Date.now();
        const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        // ── Load personality ───────────────────────────────────────────────
        let personality = null;
        if (spec.personality) {
            personality = loadPersonality(spec.personality, this.config.personalitiesDir);
        }
        // ── Build system prompt ────────────────────────────────────────────
        let systemPrompt;
        if (this.config.contextEngine) {
            // RAG path: use the engine to build a context-enriched system prompt
            const pkg = await this.config.contextEngine.buildSubagentPackage({
                prompt: spec.callerContext?.trim() || spec.prompt,
                plan: spec.plan,
                successCriteria: spec.successCriteria,
                personality: spec.personality,
            });
            systemPrompt = pkg.formattedSystemPrompt;
        }
        else {
            // No-RAG path: build system prompt from personality + spec directly
            systemPrompt = formatSystemPromptNoRAG(spec, personality);
        }
        // ── Create child session ───────────────────────────────────────────
        const childLogger = new RunLogger({ dbPath: this.config.dbPath });
        let outputBuffer = "";
        const childSession = new OrchestratorSession(childLogger, this.config.contextEngine, {
            systemPrompt,
            onOutput: (delta) => { outputBuffer += delta; },
            runKind: "subagent",
            model: personality?.provider?.model,
            parentRunId: spec.parentRunId,
            parentSessionId: spec.parentSessionId,
        }, undefined, undefined, undefined);
        // ── Run with timeout + cancellation ────────────────────────────────
        const runPromise = (async () => {
            await childSession.prompt(spec.plan);
            return "done";
        })();
        const timeoutPromise = new Promise((resolve) => {
            const timer = setTimeout(() => resolve("timeout"), timeoutMs);
            if (timer.unref)
                timer.unref();
        });
        let cancelResolve;
        const cancelPromise = new Promise((resolve) => {
            cancelResolve = resolve;
        });
        const abortHandler = () => cancelResolve?.("cancelled");
        signal?.addEventListener("abort", abortHandler, { once: true });
        let outcome;
        let runId = "";
        try {
            outcome = await Promise.race([runPromise, timeoutPromise, cancelPromise]);
            runId = childSession.lastRunId;
        }
        catch (err) {
            runId = childSession.lastRunId;
            return {
                runId,
                outcome: "error",
                output: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - startTime,
            };
        }
        finally {
            signal?.removeEventListener("abort", abortHandler);
            childSession.dispose();
            childLogger.close();
        }
        // ── Extract output ─────────────────────────────────────────────────
        const messages = childSession.messages;
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
    runDetached(spec) {
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
function formatSystemPromptNoRAG(spec, personality) {
    const sections = ["# Subagent Task"];
    if (personality) {
        sections.push("", "## Personality", personality.content);
    }
    sections.push("", "## Your Task", spec.prompt, "", "## Implementation Plan", spec.plan, "", "## Success Criteria", spec.successCriteria);
    if (spec.callerContext) {
        sections.push("", "## Additional Context", spec.callerContext);
    }
    sections.push("", "---", "Focus exclusively on the plan above. Work systematically towards the success criteria.");
    return sections.join("\n");
}
//# sourceMappingURL=subagent-runner.js.map