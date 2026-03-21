/**
 * Context Reviewer — synthesis step between retrieval and MCP delivery.
 *
 * Takes the raw formatted context + query and asks the configured
 * personality's LLM to synthesize a focused, query-specific context
 * document. The LLM outputs natural language (markdown), not structured
 * JSON — no fragile parsing required.
 *
 * Always-on by default. Falls back to raw context on LLM/network errors.
 * Set `enabled: false` to explicitly disable.
 *
 * Configurable:
 *   - enabled: on by default
 *   - personality: which personality profile to use for the review LLM
 *   - maxLatencyMs: timeout for the review call
 */

import axios from "axios";
import { loadPersonality } from "../../shared/agents/personality-loader.js";
import { getOllamaConfig } from "../../shared/config.js";
import type { PersonalityConfig } from "../../shared/agents/types.js";
import type { RetrievedNote } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextReviewConfig {
  /** Whether review is enabled. Default: true (always-on). */
  enabled: boolean;

  /** Personality name to use for the review. Default: "context-gardener". */
  personality: string;

  /** Max time for the review call in ms. Default: 15000. */
  maxLatencyMs: number;

  /** Path to personalities directory. */
  personalitiesDir: string;
}

export interface ReviewResult {
  /** Synthesized context document. Null if review was skipped or failed. */
  synthesizedContext: string | null;

  /** Time taken for review in ms. */
  reviewMs: number;

  /** Whether the review was skipped. */
  skipped: boolean;

  /** Reason for skipping, if skipped. */
  skipReason?: "disabled" | "timeout" | "error" | "no_notes";
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: ContextReviewConfig = {
  enabled: true,
  personality: "context-gardener",
  maxLatencyMs: 15_000,
  personalitiesDir: "",
};

// ---------------------------------------------------------------------------
// ContextReviewer
// ---------------------------------------------------------------------------

export class ContextReviewer {
  private readonly config: ContextReviewConfig;

  constructor(config: Partial<ContextReviewConfig>) {
    this.config = { ...DEFAULTS, ...config };
  }

  /**
   * Review retrieved context and produce a synthesized, query-focused version.
   *
   * @param query              The user's original query.
   * @param notes              Retrieved notes (used for no-notes skip check).
   * @param rawFormattedContext Pre-formatted context from formatContext() — sent to the LLM as input.
   * @returns ReviewResult with synthesizedContext (the LLM's output) or null if skipped/failed.
   */
  async review(query: string, notes: RetrievedNote[], rawFormattedContext: string): Promise<ReviewResult> {
    const t0 = Date.now();

    // Skip if disabled
    if (!this.config.enabled) {
      return { synthesizedContext: null, reviewMs: 0, skipped: true, skipReason: "disabled" };
    }

    // Skip if no notes
    if (notes.length === 0) {
      return { synthesizedContext: null, reviewMs: 0, skipped: true, skipReason: "no_notes" };
    }

    // Load personality for system prompt and model config
    const personality = loadPersonality(this.config.personality, this.config.personalitiesDir);

    try {
      const synthesized = await this.callSynthesizeLLM(query, rawFormattedContext, personality);
      return {
        synthesizedContext: synthesized,
        reviewMs: Date.now() - t0,
        skipped: false,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[context_review] Review failed (${errMsg}), using raw context`);
      return {
        synthesizedContext: null,
        reviewMs: Date.now() - t0,
        skipped: true,
        skipReason: "error",
      };
    }
  }

  /**
   * Direct Ollama API call for context synthesis.
   * Returns the synthesized markdown context document.
   */
  private async callSynthesizeLLM(
    query: string,
    rawContext: string,
    personality: PersonalityConfig | null,
  ): Promise<string> {
    const ollamaConfig = getOllamaConfig();

    // Determine model: personality > default
    const model = personality?.provider?.model ?? ollamaConfig.model;

    // Determine host: strip /v1 from OpenAI-compat URL to get native Ollama URL
    const baseUrl = personality?.provider?.baseUrl ?? ollamaConfig.baseUrl;
    const ollamaHost = baseUrl.replace(/\/v1\/?$/, "");

    const systemPrompt = personality?.content ?? "You synthesize retrieved context into focused, query-relevant summaries.";

    const userPrompt = [
      `## Query`,
      `"${query}"`,
      ``,
      `## Retrieved Context`,
      rawContext,
      ``,
      `## Instructions`,
      `Rewrite the context above into a focused document that contains ONLY information relevant to the query. Be ruthless:`,
      `- Cut background, history, and generic descriptions that don't help answer the query`,
      `- Keep specific facts, patterns, code signatures, warnings, and rules that apply`,
      `- If a section has nothing relevant, omit it entirely`,
      `- Preserve code blocks and API signatures verbatim when relevant`,
      `- Always include warnings, failure modes, and "NEVER" rules that apply to the query`,
      `- Output markdown. No preamble, no meta-commentary, just the focused context.`,
    ].join("\n");

    const response = await axios.post(
      `${ollamaHost}/api/chat`,
      {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        stream: false,
      },
      {
        timeout: this.config.maxLatencyMs,
        signal: AbortSignal.timeout(this.config.maxLatencyMs),
      },
    );

    const content = response.data?.message?.content ?? "";
    if (!content.trim()) {
      throw new Error("Empty response from synthesis LLM");
    }

    return content.trim();
  }
}
