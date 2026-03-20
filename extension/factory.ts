/**
 * ObsidiClaw ExtensionFactory — plugs context injection into Pi via the
 * before_agent_start hook.
 *
 * Usage (programmatic — custom runner):
 *   Pass an already-initialized ContextEngine so the extension reuses it:
 *     createObsidiClawExtension({ contextEngine: myEngine })
 *
 * Usage (Pi native TUI — .pi/extensions/obsidi-claw.ts):
 *   Pass only mdDbPath; the extension owns init/close:
 *     createObsidiClawExtension({ mdDbPath: "/path/to/md_db" })
 *
 * Flow per turn:
 *   before_agent_start fires
 *     → contextEngine.build(prompt)
 *     → return { systemPrompt: original + "\n\n" + formattedContext }
 *     → Pi continues with enriched system prompt
 */

import { join } from "path";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { ContextEngine } from "../context_engine/index.js";
import { RunLogger } from "../logger/index.js";

export interface ObsidiClawExtensionConfig {
  /**
   * Already-initialized ContextEngine to reuse (e.g. from a custom runner).
   * When provided, the extension will NOT call initialize() or close() on it —
   * the caller owns the lifecycle.
   */
  contextEngine?: ContextEngine;

  /**
   * Path to the md_db directory.
   * Only used when contextEngine is not provided.
   * Defaults to process.cwd()/md_db.
   */
  mdDbPath?: string;

  /**
   * RunLogger instance for synthesis metrics.
   * When provided (custom runner), the caller owns close().
   * When not provided and ownsEngine is true (Pi TUI), the extension
   * creates and closes its own logger.
   */
  logger?: RunLogger;
}

export function createObsidiClawExtension(
  config: ObsidiClawExtensionConfig = {},
): ExtensionFactory {
  return async (pi) => {
    // Determine whether we own the ContextEngine (and must close it) or
    // whether the caller passed one in and owns it themselves.
    let engine: ContextEngine;
    let ownsEngine: boolean;

    if (config.contextEngine) {
      engine = config.contextEngine;
      ownsEngine = false;
    } else {
      const mdDbPath = config.mdDbPath ?? join(process.cwd(), "md_db");
      engine = new ContextEngine({ mdDbPath });
      ownsEngine = true;
    }

    // Logger: use provided one, or create our own if we own the engine.
    const logger: RunLogger | undefined = config.logger ?? (ownsEngine ? new RunLogger() : undefined);
    const ownsLogger = !config.logger && ownsEngine;

    // ── session_start: initialize engine if we own it ─────────────────────
    pi.on("session_start", async () => {
      if (ownsEngine) {
        await engine.initialize();
      }
    });

    // ── before_agent_start: RAG → inject into system prompt ───────────────
    pi.on("before_agent_start", async (event, ctx) => {
      try {
        if (ctx.hasUI) ctx.ui.setWorkingMessage("ObsidiClaw: retrieving context…");

        const pkg = await engine.build(event.prompt);

        if (ctx.hasUI) ctx.ui.setWorkingMessage();

        // Record synthesis metrics to SQLite
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
          systemPrompt: event.systemPrompt + "\n\n" + pkg.formattedContext,
        };
      } catch {
        // Fail silently — Pi still runs, just without injected context.
        if (ctx.hasUI) ctx.ui.setWorkingMessage();
        return;
      }
    });

    // ── session_shutdown: release resources if we own them ────────────────
    pi.on("session_shutdown", () => {
      if (ownsEngine) engine.close();
      if (ownsLogger) logger?.close();
    });
  };
}
