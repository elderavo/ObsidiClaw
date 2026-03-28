/**
 * First-class subagent entity types.
 *
 * These types define the subagent as a standalone entity that can be
 * spawned from anywhere — Pi tool, scheduler, standalone script — without
 * requiring a parent Pi session.
 */

// ---------------------------------------------------------------------------
// Personality
// ---------------------------------------------------------------------------

export interface PersonalityConfig {
  /** Personality name (matches filename without .md extension). */
  name: string;

  /** Markdown body — injected into the subagent's system prompt. */
  content: string;

  /** LLM provider override for this personality. */
  provider?: {
    /** Provider type — overrides global OBSIDI_LLM_PROVIDER. */
    type?: "ollama" | "openai" | "anthropic";
    /** Model name — overrides global OBSIDI_LLM_MODEL. */
    model?: string;
    /** Base URL for ollama/openai providers. */
    baseUrl?: string;
    /** API key (literal or "env:VAR_NAME" to read from env). */
    apiKey?: string;
    /** Context window size (Ollama num_ctx). */
    numCtx?: number;
    /** Max output tokens. */
    maxTokens?: number;
    /** Sampling temperature (0–2). */
    temperature?: number;
    /** Enable/disable thinking mode (Ollama only, e.g. qwen3). */
    think?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Subagent spec & result
// ---------------------------------------------------------------------------

export interface SubagentSpec {
  /** What the subagent should do (top-level task description). */
  prompt: string;

  /** Detailed implementation plan. */
  plan: string;

  /** Measurable success criteria. */
  successCriteria: string;

  /** Personality name to use (loads from agents/subagent/personalities/). */
  personality?: string;

  /** Extra context from caller (not from RAG). */
  callerContext?: string;

  /** Timeout in ms. Default: 300_000 (5 minutes). */
  timeoutMs?: number;

  /** Run ID of the parent run that spawned this subagent (for lineage tracking). */
  parentRunId?: string;

  /** Session ID of the parent session (for cross-session lineage). */
  parentSessionId?: string;
}

export interface SubagentResult {
  /** Run ID for tracing in runs.db. */
  runId: string;

  /** How the run ended. */
  outcome: "done" | "timeout" | "cancelled" | "error";

  /** Last assistant message text (or error message). */
  output: string;

  /** Wall-clock duration in ms. */
  durationMs: number;
}
