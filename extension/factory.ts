/**
 * ObsidiClaw ExtensionFactory — context injection + retrieve_context tool.
 *
 * Two hooks per session:
 *
 * 1. before_agent_start (every turn):
 *    - Runs RAG on the user's prompt → pre-injects initial context into system prompt
 *    - Appends a standing instruction reminding Pi to prefer retrieve_context
 *      over its own knowledge for anything project-specific
 *
 * 2. retrieve_context tool (Pi-driven, any number of times per turn):
 *    - Pi calls this when it wants to look something up more specifically
 *    - Runs engine.build(query) with Pi's own query string
 *    - Returns formatted context as a tool result (visible in conversation)
 *
 * Usage (custom runner — engine already initialized):
 *   createObsidiClawExtension({ contextEngine: myEngine, logger: myLogger })
 *
 * Usage (Pi native TUI — .pi/extensions/):
 *   createObsidiClawExtension({ mdDbPath: "/path/to/md_db" })
 */

import { join } from "path";
import { Type } from "@sinclair/typebox";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { ContextEngine } from "../context_engine/index.js";
import { RunLogger } from "../logger/index.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ObsidiClawExtensionConfig {
  /**
   * Already-initialized ContextEngine to reuse (e.g. from a custom runner).
   * Caller owns lifecycle — the extension will not call initialize() or close().
   */
  contextEngine?: ContextEngine;

  /**
   * Path to the md_db directory.
   * Only used when contextEngine is not provided.
   * Defaults to process.cwd()/md_db.
   */
  mdDbPath?: string;

  /**
   * RunLogger for synthesis metrics.
   * Caller owns close() when provided.
   * When omitted and the extension owns the engine, it creates its own logger.
   */
  logger?: RunLogger;
}

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

export function createObsidiClawExtension(
  config: ObsidiClawExtensionConfig = {},
): ExtensionFactory {
  return async (pi) => {
    // Engine lifecycle
    let engine: ContextEngine;
    let ownsEngine: boolean;

    if (config.contextEngine) {
      engine = config.contextEngine;
      ownsEngine = false;
    } else {
      engine = new ContextEngine({ mdDbPath: config.mdDbPath ?? join(process.cwd(), "md_db") });
      ownsEngine = true;
    }

    // Logger lifecycle
    const logger = config.logger ?? (ownsEngine ? new RunLogger() : undefined);
    const ownsLogger = !config.logger && ownsEngine;

    // ── session_start: initialize engine if we own it ─────────────────────
    pi.on("session_start", async () => {
      if (ownsEngine) await engine.initialize();
    });

    // ── retrieve_context tool: Pi calls this when it decides it needs info ─
    pi.registerTool({
      name: "retrieve_context",
      label: "Knowledge Base Retrieval",
      description:
        "Search the ObsidiClaw project knowledge base for relevant notes, tools, " +
        "concepts, and best practices. Returns markdown-formatted context from the " +
        "md_db knowledge graph. Call this before relying on your own knowledge for " +
        "any project-specific question.",
      promptSnippet: "retrieve_context(query) — search the project knowledge base",
      parameters: Type.Object({
        query: Type.String({
          description: "What to search for in the knowledge base.",
        }),
      }),
      execute: async (_toolCallId, { query }, _signal, _onUpdate, ctx) => {
        const pkg = await engine.build(query);

        logger?.logSynthesis({
          sessionId: ctx.sessionManager.getSessionId(),
          timestamp: Date.now(),
          promptSnippet: query.slice(0, 120),
          seedCount: pkg.seedNoteIds?.length ?? 0,
          expandedCount: pkg.expandedNoteIds?.length ?? 0,
          toolCount: pkg.suggestedTools.length,
          retrievalMs: pkg.retrievalMs,
          rawChars: pkg.rawChars,
          strippedChars: pkg.strippedChars,
          estimatedTokens: pkg.estimatedTokens,
        });

        return {
          content: [{ type: "text" as const, text: pkg.formattedContext }],
          details: {
            query,
            retrievalMs: pkg.retrievalMs,
            noteCount: pkg.retrievedNotes.length,
            estimatedTokens: pkg.estimatedTokens,
          },
        };
      },
    });

    // ── before_agent_start: warm context + standing tool reminder ─────────
    pi.on("before_agent_start", async (event, ctx) => {
      try {
        if (ctx.hasUI) ctx.ui.setWorkingMessage("ObsidiClaw: retrieving context…");

        const pkg = await engine.build(event.prompt);

        if (ctx.hasUI) ctx.ui.setWorkingMessage();

        logger?.logSynthesis({
          sessionId: ctx.sessionManager.getSessionId(),
          timestamp: Date.now(),
          promptSnippet: event.prompt.slice(0, 120),
          seedCount: pkg.seedNoteIds?.length ?? 0,
          expandedCount: pkg.expandedNoteIds?.length ?? 0,
          toolCount: pkg.suggestedTools.length,
          retrievalMs: pkg.retrievalMs,
          rawChars: pkg.rawChars,
          strippedChars: pkg.strippedChars,
          estimatedTokens: pkg.estimatedTokens,
        });

        return {
          systemPrompt:
            event.systemPrompt +
            "\n\n" +
            pkg.formattedContext +
            "\n\n" +
            TOOL_REMINDER,
        };
      } catch {
        // Fail open — Pi still runs without injected context.
        if (ctx.hasUI) ctx.ui.setWorkingMessage();
        return;
      }
    });

    // ── session_shutdown ───────────────────────────────────────────────────
    pi.on("session_shutdown", () => {
      if (ownsEngine) engine.close();
      if (ownsLogger) logger?.close();
    });
  };
}
