/**
 * Subagent Extension
 *
 * Enables the main Pi agent to spawn a focused in-process subagent.
 *
 * Workflow:
 *   1. Main agent calls spawn_subagent(plan, context, success_criteria)
 *   2. Extension calls MCP prepare_subagent → ContextEngine builds SubagentPackage
 *      (hybrid RAG on the plan, bundles plan + context + criteria into system prompt)
 *   3. Extension creates a fresh in-process Pi session with the SubagentPackage
 *      injected as the system prompt, plus its own retrieve_context tool
 *   4. Subagent runs to completion; output is returned to the main agent
 *
 * No subprocess spawning — everything runs in-process via createAgentSession.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { join } from "path";
import { ContextEngine } from "../../context_engine/index.js";
import { createContextEngineMcpServer } from "../../context_engine/index.js";
import { createObsidiClawExtension } from "../../extension/factory.js";

// ---------------------------------------------------------------------------
// Provider constants — mirrors orchestrator/session.ts
// ---------------------------------------------------------------------------

const OLLAMA_BASE_URL = process.env["OLLAMA_BASE_URL"] ?? "http://10.0.132.100/v1";
const OLLAMA_MODEL    = process.env["OLLAMA_MODEL"]    ?? "llama3";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(result: unknown): string {
  const blocks = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return blocks.find((c) => c.type === "text")?.text ?? "";
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((c) => typeof c?.text === "string")
      .map((c) => c.text!)
      .join("\n");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function subagentExtension(pi: ExtensionAPI) {
  let engine: ContextEngine | undefined;
  let mcpClient: Client | undefined;

  // ── session_start: create standalone engine + MCP client ─────────────────
  pi.on("session_start", async () => {
    const mdDbPath = join(process.cwd(), "md_db");
    engine = new ContextEngine({ mdDbPath });
    await engine.initialize();

    const server = createContextEngineMcpServer(engine);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    mcpClient = new Client({ name: "subagent-ext", version: "1.0.0" });

    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
  });

  // ── spawn_subagent tool ───────────────────────────────────────────────────
  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Subagent",
    description:
      "Launch a focused in-process Pi subagent. Before calling, create a detailed " +
      "implementation spec using the subagent spec template. The subagent gets full " +
      "retrieve_context access and a system prompt built from the plan + retrieved knowledge.",
    promptSnippet: "spawn_subagent(plan, context, success_criteria) — launch focused subagent",
    promptGuidelines: [
      "Write a detailed plan before calling — the plan drives knowledge retrieval",
      "success_criteria should be unambiguous and measurable",
      "Use context to pass any facts the subagent needs that aren't in the knowledge base",
    ],
    parameters: Type.Object({
      plan: Type.String({
        description: "Detailed implementation plan for the subagent to execute",
      }),
      context: Type.String({
        description: "Additional background facts from the main agent (complements retrieved knowledge)",
      }),
      success_criteria: Type.String({
        description: "Clear, measurable criteria for determining task completion",
      }),
      timeout_minutes: Type.Optional(
        Type.Number({
          description: "Max runtime in minutes (default: 5, max: 30)",
          minimum: 1,
          maximum: 30,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      if (!mcpClient || !engine) {
        return {
          content: [{ type: "text" as const, text: "Subagent extension not initialized — call during an active session." }],
        };
      }

      const startTime = Date.now();

      // ── Step 1: prepare_subagent via MCP ─────────────────────────────────
      // ContextEngine runs hybrid RAG on the plan and bundles everything into
      // a formattedSystemPrompt. The onSubagentPrepared callback fires here if
      // the orchestrator wired one (logs the subagent_start RunEvent).
      onUpdate?.({
        content: [{ type: "text", text: "Retrieving context for subagent..." }],
        details: { status: "preparing" },
      });

      const prepResult = await mcpClient.callTool({
        name: "prepare_subagent",
        arguments: {
          prompt: params.context.trim() || params.plan,
          plan: params.plan,
          success_criteria: params.success_criteria,
        },
      });

      const formattedSystemPrompt = extractText(prepResult);

      if (!formattedSystemPrompt) {
        return {
          content: [{ type: "text" as const, text: "prepare_subagent returned no content — cannot spawn subagent." }],
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: "Context packaged. Spawning subagent..." }],
        details: { status: "spawning" },
      });

      // ── Step 2: create in-process Pi subagent session ────────────────────
      // The subagent gets:
      //   - Ollama provider (same model as parent)
      //   - createObsidiClawExtension (own standalone engine) for retrieve_context
      //   - formattedSystemPrompt injected via systemPromptOverride
      const mdDbPath = join(process.cwd(), "md_db");
      const loader = new DefaultResourceLoader({
        extensionFactories: [
          (subPi) => {
            subPi.registerProvider("ollama", {
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
          createObsidiClawExtension({ mdDbPath }),
        ],
        systemPromptOverride: () => formattedSystemPrompt,
      });

      await loader.reload();

      const { session } = await createAgentSession({
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(),
      });

      // ── Step 3: run the subagent with timeout + cancellation ─────────────
      const timeoutMs = (params.timeout_minutes ?? 5) * 60 * 1000;

      const runPromise = (async (): Promise<"done"> => {
        await session.prompt(params.plan);
        await session.agent.waitForIdle();
        return "done";
      })();

      const timeoutPromise = new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), timeoutMs);
      });

      const cancelPromise = new Promise<"cancelled">((resolve) => {
        signal?.addEventListener("abort", () => resolve("cancelled"));
      });

      const outcome = await Promise.race([runPromise, timeoutPromise, cancelPromise]);

      // ── Step 4: extract output + dispose ─────────────────────────────────
      const messages = session.messages as Array<{ role: string; content: unknown }>;
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      const output = extractMessageText(lastAssistant?.content) || "(no output)";

      session.dispose();

      const durationS = Math.round((Date.now() - startTime) / 1000);

      if (outcome === "cancelled") {
        return {
          content: [{ type: "text" as const, text: `Subagent cancelled after ${durationS}s.\n\n${output}` }],
          details: { outcome: "cancelled", duration_ms: Date.now() - startTime },
        };
      }

      if (outcome === "timeout") {
        return {
          content: [{ type: "text" as const, text: `Subagent timed out after ${params.timeout_minutes ?? 5}m.\n\n${output}` }],
          details: { outcome: "timeout", duration_ms: Date.now() - startTime },
        };
      }

      return {
        content: [{ type: "text" as const, text: `**Subagent completed** (${durationS}s)\n\n${output}` }],
        details: { outcome: "done", duration_ms: Date.now() - startTime },
      };
    },
  });

  // ── session_shutdown: clean up ────────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    await mcpClient?.close();
    engine?.close();
  });
}
