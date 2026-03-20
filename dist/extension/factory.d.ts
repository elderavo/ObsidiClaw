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
export declare function createObsidiClawExtension(config?: ObsidiClawExtensionConfig): ExtensionFactory;
//# sourceMappingURL=factory.d.ts.map