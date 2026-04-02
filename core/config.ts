/**
 * Shared configuration for ObsidiClaw.
 *
 * Centralises LLM and embedding provider settings and path resolution so that
 * orchestrator, extensions, and detached workers all share one source of truth.
 *
 * Environment variables:
 *   OBSIDI_EMBED_PROVIDER  — "ollama" | "openai" | "local"  (default: "ollama")
 *   OBSIDI_EMBED_MODEL     — embedding model name            (default: "nomic-embed-text:latest")
 *   OBSIDI_EMBED_HOST      — embedding provider host         (default: "http://localhost:11434")
 *   OBSIDI_LLM_PROVIDER    — "ollama" | "openai"             (default: "ollama")
 *   OBSIDI_LLM_MODEL       — LLM model name                  (default: "cogito:8b")
 *   OBSIDI_LLM_HOST        — LLM provider host               (default: "http://localhost:11434")
 *   OPENAI_API_KEY         — OpenAI API key (for openai provider)
 */

import { join } from "path";

// ---------------------------------------------------------------------------
// Embedding provider config
// ---------------------------------------------------------------------------

export type EmbedProvider = "ollama" | "openai" | "local";

export interface EmbedConfig {
  provider: EmbedProvider;
  model: string;
  host: string;
  apiKey?: string;
  /** Max token context length for the embedding model. Default: 8192. */
  contextLength: number;
}

export function getEmbedConfig(): EmbedConfig {
  return {
    provider: (process.env["OBSIDI_EMBED_PROVIDER"] as EmbedProvider) ?? "ollama",
    model: process.env["OBSIDI_EMBED_MODEL"] ?? "nomic-embed-text:latest",
    host: process.env["OBSIDI_EMBED_HOST"] ?? "http://localhost:11434",
    apiKey: process.env["OPENAI_API_KEY"],
    contextLength: parseInt(process.env["OBSIDI_EMBED_CONTEXT_LENGTH"] ?? "512", 10),
  };
}

// ---------------------------------------------------------------------------
// LLM provider config
// ---------------------------------------------------------------------------

export type LlmProvider = "ollama" | "openai" | "anthropic";

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  host: string;
  apiKey?: string;
  contextWindow: number;
  maxTokens: number;
}

export function getLlmConfig(): LlmConfig {
  const rawLlmHost = process.env["OBSIDI_LLM_HOST"];
  const rawOllamaBase = process.env["OLLAMA_BASE_URL"]; // may include /v1
  const normalizedHost = (rawLlmHost ?? rawOllamaBase ?? "http://localhost:11434")
    // Strip common suffixes accidentally provided by users ("/v1" or full endpoint path)
    .replace(/\/$/, "")
    .replace(/\/v1(?:\/chat\/completions)?\/?$/, "");

  return {
    provider: (process.env["OBSIDI_LLM_PROVIDER"] as LlmProvider) ?? "ollama",
    model: process.env["OBSIDI_LLM_MODEL"] ?? process.env["OLLAMA_MODEL"] ?? "cogito:8b",
    host: normalizedHost,
    apiKey: process.env["OPENAI_API_KEY"],
    contextWindow: parseInt(process.env["OBSIDI_LLM_CONTEXT_WINDOW"] ?? "32768", 10),
    maxTokens: parseInt(process.env["OBSIDI_LLM_MAX_TOKENS"] ?? "4096", 10),
  };
}

// ---------------------------------------------------------------------------
// Ollama provider config (deprecated — use getLlmConfig())
// ---------------------------------------------------------------------------

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
}

/**
 * @deprecated Use `getLlmConfig()` for provider-agnostic config.
 * Kept for backward compatibility — maps to getLlmConfig() internally.
 */
export function getOllamaConfig(overrides?: Partial<OllamaConfig>): OllamaConfig {
  const llm = getLlmConfig();
  return {
    baseUrl: overrides?.baseUrl ?? `${llm.host}/v1`,
    model: overrides?.model ?? llm.model,
    contextWindow: overrides?.contextWindow ?? llm.contextWindow,
    maxTokens: overrides?.maxTokens ?? llm.maxTokens,
  };
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export interface ObsidiClawPaths {
  /** Project root directory. */
  rootDir: string;
  /** Knowledge graph markdown directory. */
  mdDbPath: string;
  /** SQLite runs.db path (run/trace logging). */
  dbPath: string;
  /** SQLite notes.db path (note retrieval metrics, prune clusters). */
  notesDbPath: string;
  /** SQLite graph.db path (knowledge graph store). */
  graphDbPath: string;
  /** Personality markdown files directory. */
  personalitiesDir: string;
  /** Workspace registry JSON path. */
  workspacesPath: string;
}

/**
 * Resolve all ObsidiClaw paths from a root directory.
 * Falls back to process.cwd() only if no rootDir is provided.
 */
export function resolvePaths(rootDir?: string): ObsidiClawPaths {
  const root = rootDir ?? process.cwd();
  return {
    rootDir: root,
    mdDbPath: join(root, "md_db"),
    dbPath: join(root, ".obsidi-claw", "runs.db"),
    notesDbPath: join(root, ".obsidi-claw", "notes.db"),
    graphDbPath: join(root, ".obsidi-claw", "graph.db"),
    personalitiesDir: join(root, "agents", "personalities"),
    workspacesPath: join(root, ".obsidi-claw", "workspaces.json"),
  };
}
