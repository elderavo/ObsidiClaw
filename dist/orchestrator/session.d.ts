/**
 * OrchestratorSession — long-lived wrapper around a single pi agent session.
 *
 * Lifecycle per session:
 *   construction → [first prompt] → context_inject → pi_session_created
 *               → [all prompts]   → agent_prompt_sent → agent_done
 *
 * The pi agent session is created LAZILY on the first prompt so that the
 * ContextPackage (from RAG) is available to inject via agentsFilesOverride
 * before the pi session is initialized.
 *
 * On successive prompts within the same session:
 *   - The existing pi session is reused.
 *   - Context engine does NOT run again.
 *   - The agent retains its full conversation history.
 *
 * Logging:
 *   Every interface boundary emits a RunEvent to the RunLogger:
 *     prompt_received → context_inject_start → context_built → context_inject_end
 *     → pi_session_created → agent_prompt_sent → [agent_turn_start/end, tool_call/result]
 *     → agent_done → prompt_complete
 */
import type { RunLogger } from "../logger/index.js";
import type { ContextEngine } from "../context_engine/index.js";
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
    constructor(logger: RunLogger, contextEngine?: ContextEngine | undefined, config?: SessionConfig);
    /**
     * Send a prompt to the pi agent.
     *
     * First call:
     *   1. Runs the context engine (if configured) to build a ContextPackage
     *   2. Creates the pi agent session with context injected into system context
     *   3. Sends the original prompt to the agent
     *
     * Subsequent calls:
     *   - Sends directly to the existing pi session (no context engine re-run)
     */
    prompt(text: string): Promise<void>;
    /** Full message history from the pi session (undefined if session not started). */
    get messages(): import("@mariozechner/pi-agent-core").AgentMessage[];
    /** Current stage of the last prompt round-trip (for single-shot compat). */
    getLastStage(): RunStage;
    dispose(): void;
    private emit;
    /**
     * Handler for all pi session events — subscribed once at pi session creation.
     * References this.currentRunId which is updated per-prompt, so events from
     * any prompt in this session are attributed to the correct run.
     */
    private handlePiEvent;
    /**
     * Creates a pi agent session configured for Ollama.
     * If a ContextPackage is provided, its formattedContext is injected as an
     * AGENTS.md-equivalent via agentsFilesOverride — the agent sees it as
     * system-level context before the first user prompt.
     *
     * This is called ONCE per OrchestratorSession (lazy, on first prompt).
     *
     * TODO: Phase 1 — pull Ollama config from shared/config.ts
     */
    private createPiSession;
}
//# sourceMappingURL=session.d.ts.map