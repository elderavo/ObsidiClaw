/**
 * Orchestrator-local type definitions.
 *
 * These are INLINE stubs for Phase 3. In Phase 1, the canonical versions of
 * these types will be defined in shared/types.ts and shared/events.ts, and
 * this file will re-export from there.
 *
 * TODO: Phase 1 — migrate all types below to shared/ and re-export here.
 */

// ---------------------------------------------------------------------------
// Core identifiers
// ---------------------------------------------------------------------------

/** Unique identifier for a single agent run. UUIDv4. */
export type RunId = string;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Ordered stages of a single orchestrator run.
 *
 * init           → bootstrapping: generate run_id, validate config
 * context_inject → TODO Phase 5: call context_engine, build ContextPackage
 * run            → active pi agent session
 * post_process   → TODO Phase 7: comparison engine
 *                  TODO Phase 8: insight generation + md_db write-back
 * done           → run completed successfully
 * error          → run failed; see RunResult.error
 */
export type LifecycleStage =
  | "init"
  | "context_inject"
  | "run"
  | "post_process"
  | "done"
  | "error";

// ---------------------------------------------------------------------------
// Run config
// ---------------------------------------------------------------------------

export interface RunConfig {
  /** The user prompt to send to the pi agent. */
  prompt: string;

  /** Optional system prompt override. If omitted, the pi agent uses its default. */
  systemPrompt?: string;

  /**
   * Ollama model ID to use. Defaults to OLLAMA_MODEL env var or "llama3".
   * TODO: Phase 1 — pull from shared/config.ts OllamaConfig.
   */
  model?: string;

  /**
   * TODO: Phase 5 — add ContextPackage from context_engine here.
   * contextPackage?: ContextPackage;
   */
}

// ---------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------

export interface RunResult {
  runId: RunId;

  /** Final stage reached. "done" on success, "error" on failure. */
  stage: LifecycleStage;

  durationMs: number;

  /**
   * Full message history from the pi session.
   * TODO: Phase 1 — type as AgentMessage[] from @mariozechner/pi-coding-agent.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[];

  /** Present only when stage === "error". */
  error?: string;
}

// ---------------------------------------------------------------------------
// Run events (for logger)
// TODO: Phase 1 — migrate to shared/events.ts as a proper discriminated union
// ---------------------------------------------------------------------------

export type RunEvent =
  | { type: "run_start";      runId: RunId; timestamp: number; config: RunConfig }
  | { type: "stage_change";   runId: RunId; timestamp: number; from: LifecycleStage; to: LifecycleStage }
  | { type: "context_built";  runId: RunId; timestamp: number; noteCount: number; toolCount: number; retrievalMs: number }
  | { type: "tool_call";      runId: RunId; timestamp: number; toolName: string }
  | { type: "tool_result";    runId: RunId; timestamp: number; toolName: string; isError: boolean }
  | { type: "run_end";        runId: RunId; timestamp: number; durationMs: number }
  | { type: "run_error";      runId: RunId; timestamp: number; error: string };
