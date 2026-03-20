"use strict";
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
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrchestratorSession = void 0;
var pi_coding_agent_1 = require("@mariozechner/pi-coding-agent");
// ---------------------------------------------------------------------------
// Provider constants — TODO: Phase 1 move to shared/config.ts
// ---------------------------------------------------------------------------
var OLLAMA_BASE_URL = (_a = process.env["OLLAMA_BASE_URL"]) !== null && _a !== void 0 ? _a : "http://10.0.132.100/v1";
var OLLAMA_MODEL = (_b = process.env["OLLAMA_MODEL"]) !== null && _b !== void 0 ? _b : "llama3";
// ---------------------------------------------------------------------------
// OrchestratorSession
// ---------------------------------------------------------------------------
var OrchestratorSession = /** @class */ (function () {
    function OrchestratorSession(logger, contextEngine, config) {
        if (config === void 0) { config = {}; }
        this.logger = logger;
        this.contextEngine = contextEngine;
        this.config = config;
        /** pi SDK session — null until first prompt is received. */
        this.piSession = null;
        this.piSessionReady = false;
        /**
         * Current run ID — updated at the start of each prompt() call.
         * Used by the pi event subscription (subscribed once, references this field).
         */
        this.currentRunId = "";
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
    OrchestratorSession.prototype.prompt = function (text) {
        return __awaiter(this, void 0, void 0, function () {
            var runId, startTime, contextPackage, _a, err_1, error;
            var _this = this;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        runId = crypto.randomUUID();
                        this.currentRunId = runId;
                        startTime = Date.now();
                        this.emit({ type: "prompt_received", sessionId: this.sessionId, runId: runId, timestamp: Date.now(), text: text });
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 8, , 9]);
                        if (!!this.piSessionReady) return [3 /*break*/, 5];
                        contextPackage = void 0;
                        if (!this.contextEngine) return [3 /*break*/, 3];
                        this.emit({ type: "context_inject_start", sessionId: this.sessionId, runId: runId, timestamp: Date.now() });
                        return [4 /*yield*/, this.contextEngine.build(text)];
                    case 2:
                        contextPackage = _b.sent();
                        this.emit({
                            type: "context_built",
                            sessionId: this.sessionId,
                            runId: runId,
                            timestamp: Date.now(),
                            noteCount: contextPackage.retrievedNotes.length,
                            toolCount: contextPackage.suggestedTools.length,
                            retrievalMs: contextPackage.retrievalMs,
                        });
                        // TODO: Phase 6 — run suggestedTools here, append outputs to contextPackage
                        this.emit({ type: "context_inject_end", sessionId: this.sessionId, runId: runId, timestamp: Date.now() });
                        _b.label = 3;
                    case 3:
                        _a = this;
                        return [4 /*yield*/, this.createPiSession(contextPackage)];
                    case 4:
                        _a.piSession = _b.sent();
                        this.piSessionReady = true;
                        // Subscribe ONCE — handler references this.currentRunId which is updated
                        // before each prompt(), so events are always attributed to the right run.
                        this.piSession.subscribe(function (event) { return _this.handlePiEvent(event); });
                        this.emit({
                            type: "pi_session_created",
                            sessionId: this.sessionId,
                            runId: runId,
                            timestamp: Date.now(),
                            contextInjected: contextPackage !== undefined,
                        });
                        _b.label = 5;
                    case 5:
                        // ── Send prompt to agent ──────────────────────────────────────────────
                        this.emit({ type: "agent_prompt_sent", sessionId: this.sessionId, runId: runId, timestamp: Date.now() });
                        // piSession is guaranteed non-null here: set in the block above (first prompt)
                        // or was already set on a previous prompt.
                        return [4 /*yield*/, this.piSession.prompt(text)];
                    case 6:
                        // piSession is guaranteed non-null here: set in the block above (first prompt)
                        // or was already set on a previous prompt.
                        _b.sent();
                        return [4 /*yield*/, this.piSession.agent.waitForIdle()];
                    case 7:
                        _b.sent();
                        this.emit({
                            type: "prompt_complete",
                            sessionId: this.sessionId,
                            runId: runId,
                            timestamp: Date.now(),
                            durationMs: Date.now() - startTime,
                        });
                        return [3 /*break*/, 9];
                    case 8:
                        err_1 = _b.sent();
                        error = err_1 instanceof Error ? err_1.message : String(err_1);
                        this.emit({ type: "prompt_error", sessionId: this.sessionId, runId: runId, timestamp: Date.now(), error: error });
                        throw err_1;
                    case 9: return [2 /*return*/];
                }
            });
        });
    };
    Object.defineProperty(OrchestratorSession.prototype, "messages", {
        /** Full message history from the pi session (undefined if session not started). */
        get: function () {
            var _a, _b;
            return (_b = (_a = this.piSession) === null || _a === void 0 ? void 0 : _a.messages) !== null && _b !== void 0 ? _b : [];
        },
        enumerable: false,
        configurable: true
    });
    /** Current stage of the last prompt round-trip (for single-shot compat). */
    OrchestratorSession.prototype.getLastStage = function () {
        return this.piSessionReady ? "done" : "prompt_received";
    };
    OrchestratorSession.prototype.dispose = function () {
        if (this.piSession) {
            this.piSession.dispose();
        }
        this.emit({ type: "session_end", sessionId: this.sessionId, timestamp: Date.now() });
    };
    // ── Private helpers ───────────────────────────────────────────────────────
    OrchestratorSession.prototype.emit = function (event) {
        this.logger.logEvent(event);
    };
    /**
     * Handler for all pi session events — subscribed once at pi session creation.
     * References this.currentRunId which is updated per-prompt, so events from
     * any prompt in this session are attributed to the correct run.
     */
    OrchestratorSession.prototype.handlePiEvent = function (event) {
        var _a, _b, _c;
        var runId = this.currentRunId;
        switch (event.type) {
            case "agent_start":
                this.emit({ type: "agent_turn_start", sessionId: this.sessionId, runId: runId, timestamp: Date.now() });
                break;
            case "agent_end":
                this.emit({
                    type: "agent_done",
                    sessionId: this.sessionId,
                    runId: runId,
                    timestamp: Date.now(),
                    messageCount: Array.isArray(event["messages"]) ? event["messages"].length : 0,
                });
                break;
            case "turn_end":
                this.emit({ type: "agent_turn_end", sessionId: this.sessionId, runId: runId, timestamp: Date.now() });
                break;
            case "tool_execution_start":
                this.emit({
                    type: "tool_call",
                    sessionId: this.sessionId,
                    runId: runId,
                    timestamp: Date.now(),
                    toolName: String((_a = event["toolName"]) !== null && _a !== void 0 ? _a : "unknown"),
                });
                break;
            case "tool_execution_end":
                this.emit({
                    type: "tool_result",
                    sessionId: this.sessionId,
                    runId: runId,
                    timestamp: Date.now(),
                    toolName: String((_b = event["toolName"]) !== null && _b !== void 0 ? _b : "unknown"),
                    isError: Boolean(event["isError"]),
                });
                break;
            case "message_update": {
                var assistantEvent = event["assistantMessageEvent"];
                if ((assistantEvent === null || assistantEvent === void 0 ? void 0 : assistantEvent.type) === "text_delta" && this.config.onOutput) {
                    this.config.onOutput((_c = assistantEvent.delta) !== null && _c !== void 0 ? _c : "");
                }
                break;
            }
            default:
                break;
        }
    };
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
    OrchestratorSession.prototype.createPiSession = function (contextPackage) {
        return __awaiter(this, void 0, void 0, function () {
            var model, loader, session;
            var _this = this;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        model = (_a = this.config.model) !== null && _a !== void 0 ? _a : OLLAMA_MODEL;
                        loader = new pi_coding_agent_1.DefaultResourceLoader(__assign(__assign({ extensionFactories: [
                                function (pi) {
                                    pi.registerProvider("ollama", {
                                        baseUrl: OLLAMA_BASE_URL,
                                        apiKey: "ollama",
                                        api: "openai-completions",
                                        models: [
                                            {
                                                id: model,
                                                name: "Ollama / ".concat(model),
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
                            ] }, (contextPackage
                            ? {
                                agentsFilesOverride: function (current) { return ({
                                    agentsFiles: __spreadArray(__spreadArray([], current.agentsFiles, true), [
                                        {
                                            path: "obsidi-claw://md_db-context",
                                            content: contextPackage.formattedContext,
                                        },
                                    ], false),
                                }); },
                            }
                            : {})), (this.config.systemPrompt
                            ? { systemPromptOverride: function () { return _this.config.systemPrompt; } }
                            : {})));
                        return [4 /*yield*/, loader.reload()];
                    case 1:
                        _b.sent();
                        return [4 /*yield*/, (0, pi_coding_agent_1.createAgentSession)({
                                resourceLoader: loader,
                                sessionManager: pi_coding_agent_1.SessionManager.inMemory(),
                            })];
                    case 2:
                        session = (_b.sent()).session;
                        return [2 /*return*/, session];
                }
            });
        });
    };
    return OrchestratorSession;
}());
exports.OrchestratorSession = OrchestratorSession;
