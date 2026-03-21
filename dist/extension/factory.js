/**
 * ObsidiClaw ExtensionFactory — MCP-backed context injection + retrieve_context tool.
 *
 * Two hooks per session:
 *
 * 1. before_agent_start (every turn):
 *    - Calls MCP get_preferences → injects preferences.md into system prompt
 *    - Appends a standing instruction reminding Pi to use retrieve_context
 *
 * 2. retrieve_context tool (Pi-driven, any number of times per turn):
 *    - Pi calls this when it wants to look something up more specifically
 *    - Proxies through MCP retrieve_context → returns formattedContext as tool result
 *    - Metrics flow via onContextBuilt callback → orchestrator RunEvent → RunLogger
 *      (the extension itself is logger-free)
 *
 * Usage (custom runner — MCP server already built):
 *   createObsidiClawExtension({ mcpServer: myMcpServer })
 *
 * Usage (Pi native TUI — .pi/extensions/):
 *   createObsidiClawExtension({ mdDbPath: "/path/to/md_db" })
 */
import { join } from "path";
import { Type } from "@sinclair/typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAgentSession, DefaultResourceLoader, SessionManager, } from "@mariozechner/pi-coding-agent";
import { ContextEngine } from "../context_engine/index.js";
import { createContextEngineMcpServer } from "../context_engine/index.js";
import { runSessionReview } from "../insight_engine/session_review.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Extract the first text block from an MCP CallToolResult.
 * callTool() returns { [x: string]: unknown; content: ContentBlock[] } but the
 * index signature widens content to unknown in TypeScript, so we cast here.
 */
function extractText(result) {
    const blocks = result.content ?? [];
    return blocks.find((c) => c.type === "text")?.text ?? "";
}
// ---------------------------------------------------------------------------
// LLM defaults (mirrors orchestrator/session)
// ---------------------------------------------------------------------------
const OLLAMA_BASE_URL = process.env["OLLAMA_BASE_URL"] ?? "http://10.0.132.100/v1";
const OLLAMA_MODEL = process.env["OLLAMA_MODEL"] ?? "llama3";
// ---------------------------------------------------------------------------
// Standing system-prompt instruction (appended on every before_agent_start)
// ---------------------------------------------------------------------------
const TOOL_REMINDER = `
## ObsidiClaw Knowledge Base

You have access to a \`retrieve_context\` tool that searches this project's knowledge base (notes, tools, concepts, best practices).

**Always call \`retrieve_context\` before relying on your own knowledge** for any project-specific question — tools, architecture, patterns, or concepts. The context above was auto-retrieved for this prompt; use the tool with a more targeted query if you need different or deeper information.
`.trim();
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createObsidiClawExtension(config = {}) {
    return async (pi) => {
        // ── Engine + MCP server setup ────────────────────────────────────────────
        // When no server is provided, build our own engine and server (standalone path).
        let ownedEngine;
        let mcpServer;
        if (config.mcpServer) {
            mcpServer = config.mcpServer;
        }
        else {
            ownedEngine = new ContextEngine({
                mdDbPath: config.mdDbPath ?? join(process.cwd(), "md_db"),
            });
            mcpServer = createContextEngineMcpServer(ownedEngine);
        }
        // Track latest transcript (updated on agent_end) for review hook
        let latestMessages = [];
        // Create InMemoryTransport pair and client (connected in session_start).
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "obsidi-claw-ext", version: "1.0.0" });
        // ── session_start: initialize engine (if owned) + connect MCP pair ──────
        pi.on("session_start", async () => {
            if (ownedEngine)
                await ownedEngine.initialize();
            await mcpServer.connect(serverTransport);
            await client.connect(clientTransport);
        });
        // ── retrieve_context tool: Pi calls this when it decides it needs info ──
        pi.registerTool({
            name: "retrieve_context",
            label: "Knowledge Base Retrieval",
            description: "Search the ObsidiClaw project knowledge base for relevant notes, tools, " +
                "concepts, and best practices. Returns markdown-formatted context from the " +
                "md_db knowledge graph. Call this before relying on your own knowledge for " +
                "any project-specific question.",
            promptSnippet: "retrieve_context(query) — search the project knowledge base",
            parameters: Type.Object({
                query: Type.String({
                    description: "What to search for in the knowledge base.",
                }),
            }),
            execute: async (_toolCallId, { query }, _signal, _onUpdate, _ctx) => {
                const result = await client.callTool({ name: "retrieve_context", arguments: { query } });
                const text = extractText(result);
                return {
                    content: [{ type: "text", text }],
                    details: { query },
                };
            },
        });
        // ── before_agent_start: inject preferences + standing tool reminder ─────
        // Calls MCP get_preferences so the engine stays behind the MCP boundary.
        pi.on("before_agent_start", async (event, ctx) => {
            try {
                const result = await client.callTool({ name: "get_preferences", arguments: {} });
                const prefsContent = extractText(result);
                const contextBlock = prefsContent
                    ? `<!-- ObsidiClaw: Preferences -->\n\n${prefsContent}\n\n<!-- End ObsidiClaw Preferences -->`
                    : "";
                return {
                    systemPrompt: event.systemPrompt +
                        (contextBlock ? "\n\n" + contextBlock : "") +
                        "\n\n" +
                        TOOL_REMINDER,
                };
            }
            catch {
                // Fail open — Pi still runs without injected context.
                if (ctx.hasUI)
                    ctx.ui.setWorkingMessage();
                return;
            }
        });
        // ── agent_end: capture transcript for session review ─────────────────────
        pi.on("agent_end", (event) => {
            const messages = event?.messages;
            if (Array.isArray(messages))
                latestMessages = messages;
        });
        // ── session_shutdown ─────────────────────────────────────────────────────
        pi.on("session_shutdown", async () => {
            try {
                // Only run review when this extension owns the engine (pi TUI path).
                if (ownedEngine) {
                    await runSessionReview({
                        trigger: "session_end",
                        sessionId: `pi-tui-${Date.now()}`,
                        messages: latestMessages,
                        contextEngine: ownedEngine,
                        rootDir: process.cwd(),
                        createChildSession: async (systemPrompt) => {
                            const loader = new DefaultResourceLoader({
                                extensionFactories: [
                                    (piChild) => {
                                        piChild.registerProvider("ollama", {
                                            baseUrl: OLLAMA_BASE_URL,
                                            apiKey: "ollama",
                                            api: "openai-completions",
                                            models: [
                                                {
                                                    id: OLLAMA_MODEL,
                                                    name: `Ollama / ${OLLAMA_MODEL}`,
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
                                systemPromptOverride: () => systemPrompt,
                            });
                            await loader.reload();
                            const { session } = await createAgentSession({
                                resourceLoader: loader,
                                sessionManager: SessionManager.inMemory(),
                            });
                            return {
                                runReview: async (userMessage) => {
                                    await session.prompt(userMessage);
                                    const msgs = (session.messages ?? []);
                                    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
                                    return extractTextFromContent(lastAssistant?.content) ?? "";
                                },
                                dispose: () => {
                                    session.dispose();
                                },
                            };
                        },
                    });
                }
            }
            catch (err) {
                console.error("[session_review] failed in extension:", err);
            }
            finally {
                void client.close();
                void mcpServer.close();
                if (ownedEngine)
                    ownedEngine.close();
            }
        });
    };
}
function extractTextFromContent(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        const parts = content
            .map((c) => {
            if (typeof c === "string")
                return c;
            if (c && typeof c === "object" && "text" in c)
                return String(c.text);
            return null;
        })
            .filter(Boolean);
        return parts.join("\n") || null;
    }
    if (content && typeof content === "object" && "text" in content) {
        return String(content.text);
    }
    return null;
}
//# sourceMappingURL=factory.js.map