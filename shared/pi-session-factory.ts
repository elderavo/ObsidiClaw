/**
 * Shared Pi agent session factory.
 *
 * Eliminates duplicated Ollama provider registration + DefaultResourceLoader
 * boilerplate across OrchestratorSession and the detached subagent worker.
 */

import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";

import { getOllamaConfig, type OllamaConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PiSessionOptions {
  /** Ollama provider overrides. */
  ollama?: Partial<OllamaConfig>;
  /** Additional extension factories to register (context injection, etc). */
  extensionFactories?: ExtensionFactory[];
  /** System prompt override — replaces the default pi system prompt. */
  systemPrompt?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fully configured pi AgentSession with Ollama provider and optional
 * extension factories. This is the single source of truth for session creation.
 */
export async function createPiAgentSession(
  options: PiSessionOptions = {},
): Promise<AgentSession> {
  const cfg = getOllamaConfig(options.ollama);

  const loader = new DefaultResourceLoader({
    extensionFactories: [
      // Ollama provider registration
      (pi) => {
        pi.registerProvider("ollama", {
          baseUrl: cfg.baseUrl,
          apiKey: "ollama",
          api: "openai-completions",
          models: [
            {
              id: cfg.model,
              name: `Ollama / ${cfg.model}`,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: cfg.contextWindow,
              maxTokens: cfg.maxTokens,
              compat: {
                supportsDeveloperRole: false,
                maxTokensField: "max_tokens",
              },
            },
          ],
        });
      },
      // Caller-supplied extensions
      ...(options.extensionFactories ?? []),
    ],

    ...(options.systemPrompt
      ? { systemPromptOverride: () => options.systemPrompt! }
      : {}),
  });

  await loader.reload();

  const { session } = await createAgentSession({
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
  });

  return session;
}
