/**
 * Orchestrator type definitions.
 *
 * TODO: Phase 1 — migrate to shared/types.ts and shared/events.ts once stable.
 */
/** Unique ID for a single pi agent session. UUIDv4. */
export type SessionId = string;
/**
 * Unique ID for a single prompt/response round-trip within a session.
 * A session has one or more runs (one per prompt).
 */
export type RunId = string;
/**
 * Lifecycle stages within a single prompt round-trip.
 *
 * prompt_received  → prompt arrived at orchestrator
 * context_inject   → context engine running (first prompt only)
 * pi_ready         → pi session created and ready
 * agent_running    → prompt sent to agent, waiting for response
 * done             → round-trip complete
 * error            → round-trip failed
 */
export type RunStage = "prompt_received" | "context_inject" | "pi_ready" | "agent_running" | "done" | "error";
export interface SessionConfig {
    /** System prompt override for the pi agent. */
    systemPrompt?: string;
    /** Ollama model override. Defaults to OLLAMA_MODEL env / "llama3". */
    model?: string;
    /**
     * Called with streaming text delta from the agent.
     * Use this to print agent output in real time.
     */
    onOutput?: (delta: string) => void;
}
export interface RunConfig extends SessionConfig {
    prompt: string;
}
export interface RunResult {
    sessionId: SessionId;
    runId: RunId;
    stage: RunStage;
    durationMs: number;
    messages: any[];
    error?: string;
}
export type RunEvent = {
    type: "session_start";
    sessionId: SessionId;
    timestamp: number;
} | {
    type: "session_end";
    sessionId: SessionId;
    timestamp: number;
} | {
    type: "prompt_received";
    sessionId: SessionId;
    runId: RunId;
    timestamp: number;
    text: string;
} | {
    type: "prompt_complete";
    sessionId: SessionId;
    runId: RunId;
    timestamp: number;
    durationMs: number;
} | {
    type: "prompt_error";
    sessionId: SessionId;
    runId: RunId;
    timestamp: number;
    error: string;
} | {
    type: "context_inject_start";
    sessionId: SessionId;
    runId: RunId;
    timestamp: number;
} | {
    type: "context_built";
    sessionId: SessionId;
    runId: RunId;
    timestamp: number;
    noteCount: number;
    toolCount: number;
    retrievalMs: number;
} | {
    type: "context_inject_end";
    sessionId: SessionId;
    runId: RunId;
    timestamp: number;
} | {
    type: "pi_session_created";
    sessionId: SessionId;
    runId: RunId;
    timestamp: number;
    contextInjected: boolean;
} | {
    type: "context_retrieved";
    sessionId: SessionId;
    runId: RunId;
    timestamp: number;
    query: string;
    seedCount: number;
    expandedCount: number;
    toolCount: number;
    retrievalMs: number;
    rawChars: number;
    strippedChars: number;
    estimatedTokens: number;
} | {
    type: "agent_prompt_sent";
    sessionId: SessionId;
    runId: RunId;
    timestamp: number;
} | {
    type: "agent_turn_start";
    sessionId: SessionId;
    runId: RunId;
    timestamp: number;
} | {
    type: "agent_turn_end";
    sessionId: SessionId;
    runId: RunId;
    timestamp: number;
} | {
    type: "agent_done";
    sessionId: SessionId;
    runId: RunId;
    timestamp: number;
    messageCount: number;
} | {
    type: "tool_call";
    sessionId: SessionId;
    runId: RunId;
    timestamp: number;
    toolName: string;
} | {
    type: "tool_result";
    sessionId: SessionId;
    runId: RunId;
    timestamp: number;
    toolName: string;
    isError: boolean;
};
//# sourceMappingURL=types.d.ts.map