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
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { ContextEngine } from "../context_engine/index.js";
import { RunLogger } from "../logger/index.js";
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
export declare function createObsidiClawExtension(config?: ObsidiClawExtensionConfig): ExtensionFactory;
//# sourceMappingURL=factory.d.ts.map