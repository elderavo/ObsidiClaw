/**
 * Shared configuration for ObsidiClaw.
 *
 * Centralises Ollama provider settings and path resolution so that
 * orchestrator, extensions, and detached workers all share one source of truth.
 */

import { join } from "path";

// ---------------------------------------------------------------------------
// Ollama provider config
// ---------------------------------------------------------------------------

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
}

export function getOllamaConfig(overrides?: Partial<OllamaConfig>): OllamaConfig {
  return {
    baseUrl: overrides?.baseUrl ?? process.env["OLLAMA_BASE_URL"] ?? "http://10.0.132.100:11434/v1",
    model: overrides?.model ?? process.env["OLLAMA_MODEL"] ?? "cogito:8b",
    contextWindow: overrides?.contextWindow ?? 32768,
    maxTokens: overrides?.maxTokens ?? 4096,
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
  /** SQLite graph.db path (knowledge graph store). */
  graphDbPath: string;
  /** Personality markdown files directory. */
  personalitiesDir: string;
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
    graphDbPath: join(root, ".obsidi-claw", "graph.db"),
    personalitiesDir: join(root, "shared", "agents", "personalities"),
  };
}
