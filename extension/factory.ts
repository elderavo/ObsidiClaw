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

        return {
          systemPrompt: event.systemPrompt + "\n\n" + pkg.formattedContext,
        };
      } catch {
        // Fail silently — Pi still runs, just without injected context.
        if (ctx.hasUI) ctx.ui.setWorkingMessage();
        return;
      }
    });

    // ── session_shutdown: release resources if we own the engine ──────────
    pi.on("session_shutdown", () => {
      if (ownsEngine) {
        engine.close();
      }
    });
  };
}
