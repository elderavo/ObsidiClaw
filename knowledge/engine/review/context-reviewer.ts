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

import { llmChat } from "../../../core/llm-client.js";
import { loadPersonality } from "../../../agents/subagent/personality-loader.js";
import type { PersonalityConfig } from "../../../agents/subagent/types.js";
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
  maxLatencyMs: 120_000,
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
    } catch {
      // Error details surface via ce_review_done event (skipped=true, skipReason="error")
      // emitted by the ContextEngine caller. No console output needed.
      return {
        synthesizedContext: null,
        reviewMs: Date.now() - t0,
        skipped: true,
        skipReason: "error",
      };
    }
  }

  /**
   * LLM call for context synthesis.
   * Uses the provider-agnostic llmChat() client.
   * Returns the synthesized markdown context document.
   */
  private async callSynthesizeLLM(
    query: string,
    rawContext: string,
    personality: PersonalityConfig | null,
  ): Promise<string> {
    const systemPrompt = personality?.content ?? "You synthesize retrieved context into focused, query-relevant summaries.";

    const userPrompt = [
      `## Query`,
      `"${query}"`,
      ``,
      `## Retrieved Context`,
      rawContext,
    ].join("\n");

    const result = await llmChat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      {
        model: personality?.provider?.model,
        temperature: 0.1,
        numCtx: 16384,
        timeout: this.config.maxLatencyMs,
      },
    );

    const content = result.content;
    if (!content.trim()) {
      throw new Error("Empty response from synthesis LLM");
    }

    return content.trim();
  }
}
