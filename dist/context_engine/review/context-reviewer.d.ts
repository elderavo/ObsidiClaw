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
import type { RetrievedNote } from "../types.js";
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
export declare class ContextReviewer {
    private readonly config;
    constructor(config: Partial<ContextReviewConfig>);
    /**
     * Review retrieved context and produce a synthesized, query-focused version.
     *
     * @param query              The user's original query.
     * @param notes              Retrieved notes (used for no-notes skip check).
     * @param rawFormattedContext Pre-formatted context from formatContext() — sent to the LLM as input.
     * @returns ReviewResult with synthesizedContext (the LLM's output) or null if skipped/failed.
     */
    review(query: string, notes: RetrievedNote[], rawFormattedContext: string): Promise<ReviewResult>;
    /**
     * Direct Ollama API call for context synthesis.
     * Returns the synthesized markdown context document.
     */
    private callSynthesizeLLM;
}
//# sourceMappingURL=context-reviewer.d.ts.map