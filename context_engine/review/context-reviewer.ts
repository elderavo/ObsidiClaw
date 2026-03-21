/**
 * Context Reviewer — quality gate between retrieval and MCP delivery.
 *
 * Evaluates retrieved notes for relevance to the query before they're
 * sent to the agent. Uses a direct Ollama API call with the configured
 * personality's model (default: context-gardener) to keep latency low.
 *
 * Configurable:
 *   - enabled: off by default
 *   - confidenceThreshold: review only triggers when avg score is below this
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
  /** Whether review is enabled. Default: false. */
  enabled: boolean;

  /**
   * Average retrieval score below which review triggers.
   * If avg score >= threshold, review is skipped (high confidence).
   * Default: 0.5
   */
  confidenceThreshold: number;

  /** Personality name to use for the review. Default: "context-gardener". */
  personality: string;

  /** Max time for the review call in ms. Default: 10000. */
  maxLatencyMs: number;

  /** Path to personalities directory. */
  personalitiesDir: string;
}

export interface ReviewResult {
  /** Note IDs filtered out by the reviewer. */
  filteredNoteIds: string[];

  /** Time taken for review in ms. */
  reviewMs: number;

  /** Whether the review was skipped. */
  skipped: boolean;

  /** Reason for skipping, if skipped. */
  skipReason?: "disabled" | "high_confidence" | "timeout" | "error" | "no_notes";
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: ContextReviewConfig = {
  enabled: false,
  confidenceThreshold: 0.5,
  personality: "context-gardener",
  maxLatencyMs: 10_000,
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
   * Review retrieved notes for relevance to the query.
   *
   * Returns which notes to filter out. If review is skipped (disabled,
   * high confidence, timeout), returns an empty filteredNoteIds array.
   */
  async review(query: string, notes: RetrievedNote[]): Promise<ReviewResult> {
    const t0 = Date.now();

    // Skip if disabled
    if (!this.config.enabled) {
      return { filteredNoteIds: [], reviewMs: 0, skipped: true, skipReason: "disabled" };
    }

    // Skip if no notes
    if (notes.length === 0) {
      return { filteredNoteIds: [], reviewMs: 0, skipped: true, skipReason: "no_notes" };
    }

    // Skip if high confidence (avg score above threshold)
    const avgScore = notes.reduce((sum, n) => sum + n.score, 0) / notes.length;
    if (avgScore >= this.config.confidenceThreshold) {
      return {
        filteredNoteIds: [],
        reviewMs: Date.now() - t0,
        skipped: true,
        skipReason: "high_confidence",
      };
    }

    // Load personality for system prompt and model config
    const personality = loadPersonality(this.config.personality, this.config.personalitiesDir);

    try {
      const filteredNoteIds = await this.callReviewLLM(query, notes, personality);
      return {
        filteredNoteIds,
        reviewMs: Date.now() - t0,
        skipped: false,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[context_review] Review failed (${errMsg}), passing all notes through`);
      return {
        filteredNoteIds: [],
        reviewMs: Date.now() - t0,
        skipped: true,
        skipReason: "error",
      };
    }
  }

  /**
   * Direct Ollama API call for context review.
   * Returns IDs of notes to filter out.
   */
  private async callReviewLLM(
    query: string,
    notes: RetrievedNote[],
    personality: PersonalityConfig | null,
  ): Promise<string[]> {
    const ollamaConfig = getOllamaConfig();

    // Determine model: personality > default
    const model = personality?.provider?.model ?? ollamaConfig.model;

    // Determine host: strip /v1 from OpenAI-compat URL to get native Ollama URL
    const baseUrl = personality?.provider?.baseUrl ?? ollamaConfig.baseUrl;
    const ollamaHost = baseUrl.replace(/\/v1\/?$/, "");

    // Build the prompt
    const notesList = notes
      .map((n, i) => `[${i + 1}] ID: "${n.noteId}" | Score: ${n.score.toFixed(3)} | Type: ${n.type}\n${n.content.slice(0, 300)}`)
      .join("\n\n");

    const systemPrompt = personality?.content ?? "You evaluate retrieved context for relevance.";

    const userPrompt = [
      `## Query`,
      `"${query}"`,
      ``,
      `## Retrieved Notes`,
      notesList,
      ``,
      `## Instructions`,
      `Evaluate each note for relevance to the query.`,
      `Return a JSON object with two arrays:`,
      `- "keep": IDs of notes that are relevant and should be included`,
      `- "filter": IDs of notes that are NOT relevant and should be removed`,
      ``,
      `Respond with JSON only, no markdown wrapping.`,
    ].join("\n");

    // Call Ollama native API
    const response = await axios.post(
      `${ollamaHost}/api/chat`,
      {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        stream: false,
        format: "json",
      },
      {
        timeout: this.config.maxLatencyMs,
        signal: AbortSignal.timeout(this.config.maxLatencyMs),
      },
    );

    // Parse response
    const content = response.data?.message?.content ?? "";
    return this.parseReviewResponse(content, notes);
  }

  /**
   * Parse the LLM's JSON response to extract filtered note IDs.
   * Gracefully handles malformed responses by keeping all notes.
   */
  private parseReviewResponse(raw: string, notes: RetrievedNote[]): string[] {
    try {
      const parsed = JSON.parse(raw.trim()) as { keep?: string[]; filter?: string[] };
      const validIds = new Set(notes.map((n) => n.noteId));

      if (Array.isArray(parsed.filter)) {
        return parsed.filter.filter((id) => validIds.has(id));
      }

      // If only "keep" is provided, filter = all notes not in keep
      if (Array.isArray(parsed.keep)) {
        const keepSet = new Set(parsed.keep);
        return notes.filter((n) => !keepSet.has(n.noteId)).map((n) => n.noteId);
      }

      return [];
    } catch {
      return [];
    }
  }
}
