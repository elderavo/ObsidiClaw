/**
 * OrchestratorSession — long-lived wrapper around a single pi agent session.
 *
 * Lifecycle per session:
 *   construction → [first prompt] → pi_session_created
 *               → [all prompts]   → agent_prompt_sent → agent_done
 *
 * Context injection is handled by the ObsidiClaw ExtensionFactory wired into
 * the DefaultResourceLoader. The extension intercepts before_agent_start on
 * every turn, runs RAG, and injects formattedContext into the system prompt —
 * no manual inject logic here.
 *
 * Logging:
 *   Every interface boundary emits a RunEvent to the RunLogger:
 *     prompt_received → pi_session_created (first prompt only)
 *     → agent_prompt_sent → [agent_turn_start/end, tool_call/result]
 *     → agent_done → prompt_complete
 */
import { RunLogger } from "../logger/index.js";
import type { ContextEngine } from "../context_engine/index.js";
import { type ReviewTrigger } from "../insight_engine/session_review.js";
import type { RunStage, SessionConfig, SessionId } from "./types.js";
export declare class OrchestratorSession {
    private readonly logger;
    private readonly contextEngine?;
    private readonly config;
    readonly sessionId: SessionId;
    /** pi SDK session — null until first prompt is received. */
    private piSession;
    private piSessionReady;
    /**
     * Current run ID — updated at the start of each prompt() call.
     * Used by the pi event subscription (subscribed once, references this field).
     */
    private currentRunId;
    private readonly isSubagent;
    constructor(logger: RunLogger, contextEngine?: ContextEngine | undefined, config?: SessionConfig);
    /**
     * Send a prompt to the pi agent.
     *
     * First call: creates the pi session (extension handles context injection).
     * Subsequent calls: reuses existing session; agent retains full conversation history.
     * Context injection runs on every turn via the before_agent_start extension hook.
     */
    prompt(text: string): Promise<void>;
    /** Full message history from the pi session (undefined if session not started). */
    get messages(): import("@mariozechner/pi-agent-core").AgentMessage[];
    /** Current stage of the last prompt round-trip (for single-shot compat). */
    getLastStage(): RunStage;
    /**
     * Preferred teardown: runs review (if enabled) then disposes.
     * Falls back to dispose() if review is skipped.
     */
    finalize(trigger?: ReviewTrigger): Promise<void>;
    dispose(): void;
    private emit;
    /**
     * Handler for all pi session events — subscribed once at pi session creation.
     * References this.currentRunId which is updated per-prompt, so events from
     * any prompt in this session are attributed to the correct run.
     */
    private handlePiEvent;
    /**
     * Run the review subagent for the given trigger. No-ops if contextEngine
     * is unavailable or if this session is already a subagent.
     */
    private runReviewHook;
    /**
     * Creates a pi agent session configured for Ollama, with the ObsidiClaw
     * context-injection extension wired in.
     *
     * Called ONCE per OrchestratorSession (lazy, on first prompt).
     *
     * TODO: Phase 1 — pull Ollama config from shared/config.ts
     */
    private createPiSession;
}
//# sourceMappingURL=session.d.ts.map