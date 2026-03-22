/**
 * Shared Pi agent session factory.
 *
 * Eliminates duplicated Ollama provider registration + DefaultResourceLoader
 * boilerplate across OrchestratorSession and the detached subagent worker.
 */
import { type AgentSession, type ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { type OllamaConfig } from "./config.js";
export interface PiSessionOptions {
    /** Ollama provider overrides. */
    ollama?: Partial<OllamaConfig>;
    /** Additional extension factories to register (context injection, etc). */
    extensionFactories?: ExtensionFactory[];
    /** System prompt override — replaces the default pi system prompt. */
    systemPrompt?: string;
}
/**
 * Create a fully configured pi AgentSession with Ollama provider and optional
 * extension factories. This is the single source of truth for session creation.
 */
export declare function createPiAgentSession(options?: PiSessionOptions): Promise<AgentSession>;
//# sourceMappingURL=pi-session-factory.d.ts.map