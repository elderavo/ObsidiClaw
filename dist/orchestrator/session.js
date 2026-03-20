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
import { createAgentSession, DefaultResourceLoader, SessionManager, } from "@mariozechner/pi-coding-agent";
// ---------------------------------------------------------------------------
// Provider constants — TODO: Phase 1 move to shared/config.ts
// ---------------------------------------------------------------------------
const OLLAMA_BASE_URL = process.env["OLLAMA_BASE_URL"] ?? "http://10.0.132.100/v1";
const OLLAMA_MODEL = process.env["OLLAMA_MODEL"] ?? "llama3";
// ---------------------------------------------------------------------------
// OrchestratorSession
// ---------------------------------------------------------------------------
export class OrchestratorSession {
    logger;
    contextEngine;
    config;
    sessionId;
    /** pi SDK session — null until first prompt is received. */
    piSession = null;
    piSessionReady = false;
    /**
     * Current run ID — updated at the start of each prompt() call.
     * Used by the pi event subscription (subscribed once, references this field).
     */
    currentRunId = "";
    constructor(logger, contextEngine, config = {}) {
        this.logger = logger;
        this.contextEngine = contextEngine;
        this.config = config;
        this.sessionId = crypto.randomUUID();
        this.emit({ type: "session_start", sessionId: this.sessionId, timestamp: Date.now() });
    }
    // ── Public API ────────────────────────────────────────────────────────────
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
    async prompt(text) {
        const runId = crypto.randomUUID();
        this.currentRunId = runId;
        const startTime = Date.now();
        this.emit({ type: "prompt_received", sessionId: this.sessionId, runId, timestamp: Date.now(), text });
        try {
            // ── First prompt: build context + create pi session ──────────────────
            if (!this.piSessionReady) {
                let contextPackage;
                if (this.contextEngine) {
                    this.emit({ type: "context_inject_start", sessionId: this.sessionId, runId, timestamp: Date.now() });
                    contextPackage = await this.contextEngine.build(text);
                    this.emit({
                        type: "context_built",
                        sessionId: this.sessionId,
                        runId,
                        timestamp: Date.now(),
                        noteCount: contextPackage.retrievedNotes.length,
                        toolCount: contextPackage.suggestedTools.length,
                        retrievalMs: contextPackage.retrievalMs,
                    });
                    // TODO: Phase 6 — run suggestedTools here, append outputs to contextPackage
                    this.emit({ type: "context_inject_end", sessionId: this.sessionId, runId, timestamp: Date.now() });
                }
                this.piSession = await this.createPiSession(contextPackage);
                this.piSessionReady = true;
                // Subscribe ONCE — handler references this.currentRunId which is updated
                // before each prompt(), so events are always attributed to the right run.
                this.piSession.subscribe((event) => this.handlePiEvent(event));
                this.emit({
                    type: "pi_session_created",
                    sessionId: this.sessionId,
                    runId,
                    timestamp: Date.now(),
                    contextInjected: contextPackage !== undefined,
                });
            }
            // ── Send prompt to agent ──────────────────────────────────────────────
            this.emit({ type: "agent_prompt_sent", sessionId: this.sessionId, runId, timestamp: Date.now() });
            // piSession is guaranteed non-null here: set in the block above (first prompt)
            // or was already set on a previous prompt.
            await this.piSession.prompt(text);
            await this.piSession.agent.waitForIdle();
            this.emit({
                type: "prompt_complete",
                sessionId: this.sessionId,
                runId,
                timestamp: Date.now(),
                durationMs: Date.now() - startTime,
            });
        }
        catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            this.emit({ type: "prompt_error", sessionId: this.sessionId, runId, timestamp: Date.now(), error });
            throw err;
        }
    }
    /** Full message history from the pi session (undefined if session not started). */
    get messages() {
        return this.piSession?.messages ?? [];
    }
    /** Current stage of the last prompt round-trip (for single-shot compat). */
    getLastStage() {
        return this.piSessionReady ? "done" : "prompt_received";
    }
    dispose() {
        if (this.piSession) {
            this.piSession.dispose();
        }
        this.emit({ type: "session_end", sessionId: this.sessionId, timestamp: Date.now() });
    }
    // ── Private helpers ───────────────────────────────────────────────────────
    emit(event) {
        this.logger.logEvent(event);
    }
    /**
     * Handler for all pi session events — subscribed once at pi session creation.
     * References this.currentRunId which is updated per-prompt, so events from
     * any prompt in this session are attributed to the correct run.
     */
    handlePiEvent(event) {
        const runId = this.currentRunId;
        switch (event.type) {
            case "agent_start":
                this.emit({ type: "agent_turn_start", sessionId: this.sessionId, runId, timestamp: Date.now() });
                break;
            case "agent_end":
                this.emit({
                    type: "agent_done",
                    sessionId: this.sessionId,
                    runId,
                    timestamp: Date.now(),
                    messageCount: Array.isArray(event["messages"]) ? event["messages"].length : 0,
                });
                break;
            case "turn_end":
                this.emit({ type: "agent_turn_end", sessionId: this.sessionId, runId, timestamp: Date.now() });
                break;
            case "tool_execution_start":
                this.emit({
                    type: "tool_call",
                    sessionId: this.sessionId,
                    runId,
                    timestamp: Date.now(),
                    toolName: String(event["toolName"] ?? "unknown"),
                });
                break;
            case "tool_execution_end":
                this.emit({
                    type: "tool_result",
                    sessionId: this.sessionId,
                    runId,
                    timestamp: Date.now(),
                    toolName: String(event["toolName"] ?? "unknown"),
                    isError: Boolean(event["isError"]),
                });
                break;
            case "message_update": {
                const assistantEvent = event["assistantMessageEvent"];
                if (assistantEvent?.type === "text_delta" && this.config.onOutput) {
                    this.config.onOutput(assistantEvent.delta ?? "");
                }
                break;
            }
            default:
                break;
        }
    }
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
    async createPiSession(contextPackage) {
        const model = this.config.model ?? OLLAMA_MODEL;
        const loader = new DefaultResourceLoader({
            extensionFactories: [
                (pi) => {
                    pi.registerProvider("ollama", {
                        baseUrl: OLLAMA_BASE_URL,
                        apiKey: "ollama",
                        api: "openai-completions",
                        models: [
                            {
                                id: model,
                                name: `Ollama / ${model}`,
                                reasoning: false,
                                input: ["text"],
                                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                                contextWindow: 32768,
                                maxTokens: 4096,
                                compat: {
                                    supportsDeveloperRole: false,
                                    maxTokensField: "max_tokens",
                                },
                            },
                        ],
                    });
                },
            ],
            // Inject RAG context as system-level context (equivalent to AGENTS.md).
            // The agent sees this before every turn for the lifetime of the session.
            ...(contextPackage
                ? {
                    agentsFilesOverride: (current) => ({
                        agentsFiles: [
                            ...current.agentsFiles,
                            {
                                path: "obsidi-claw://md_db-context",
                                content: contextPackage.formattedContext,
                            },
                        ],
                    }),
                }
                : {}),
            ...(this.config.systemPrompt
                ? { systemPromptOverride: () => this.config.systemPrompt }
                : {}),
        });
        await loader.reload();
        const { session } = await createAgentSession({
            resourceLoader: loader,
            sessionManager: SessionManager.inMemory(),
        });
        return session;
    }
}
//# sourceMappingURL=session.js.map