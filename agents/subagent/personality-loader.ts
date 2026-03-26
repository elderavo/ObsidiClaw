/**
 * Personality loader — reads personality markdown files from disk.
 *
 * Personality files live in shared/agents/personalities/ (outside md_db)
 * so they are NOT indexed by the context engine and don't pollute
 * retrieval results.
 *
 * File format:
 * ```markdown
 * ---
 * type: personality
 * title: Deep Researcher
 * provider:
 *   model: llama3
 *   baseUrl: http://localhost:11434/v1
 * ---
 * # Deep Researcher
 * You are a deep researcher...
 * ```
 */

import { join } from "path";
import { readText, fileExists, listDir } from "../../core/os/fs.js";
import { parseFrontmatter } from "../../knowledge/markdown/frontmatter.js";
import { getLlmConfig } from "../../core/config.js";
import type { ChatOptions } from "../../core/llm-client.js";
import type { PersonalityConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a personality by name from the given directory.
 * Returns null if the file doesn't exist.
 */
export function loadPersonality(
  name: string,
  personalitiesDir: string,
): PersonalityConfig | null {
  const filePath = join(personalitiesDir, `${name}.md`);

  if (!fileExists(filePath)) {
    return null;
  }

  const raw = readText(filePath);
  const { frontmatter, body } = parseFrontmatter(raw);

  return {
    name,
    content: body,
    provider: extractProvider(frontmatter),
  };
}

/**
 * List all available personality names in the given directory.
 * Returns names without the .md extension.
 */
export function listPersonalities(personalitiesDir: string): string[] {
  if (!fileExists(personalitiesDir)) {
    return [];
  }

  return listDir(personalitiesDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));
}

/**
 * Resolve LLM chat options from personality config with cascade:
 * .env global defaults → personality frontmatter overrides.
 *
 * Call sites should use this instead of manually constructing ChatOptions.
 */
export function resolvePersonalityChatOptions(
  personality: PersonalityConfig | null,
): ChatOptions {
  const defaults = getLlmConfig();
  const p = personality?.provider;
  return {
    model: p?.model ?? defaults.model,
    temperature: p?.temperature,
    numCtx: p?.numCtx,
    maxTokens: p?.maxTokens ?? defaults.maxTokens,
    providerType: p?.type,
    apiKey: p?.apiKey,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract provider config from parsed frontmatter.
 * Handles both flat and nested formats:
 *   provider:
 *     model: llama3
 *     baseUrl: http://...
 */
function extractProvider(
  fm: Record<string, unknown>,
): PersonalityConfig["provider"] | undefined {
  const provider = fm["provider"];
  if (!provider || typeof provider !== "object") return undefined;

  const p = provider as Record<string, unknown>;
  const type = typeof p["type"] === "string" ? p["type"] as "ollama" | "openai" | "anthropic" : undefined;
  const model = typeof p["model"] === "string" ? p["model"] : undefined;
  const baseUrl = typeof p["baseUrl"] === "string" ? p["baseUrl"] : undefined;
  const numCtx = typeof p["numCtx"] === "number" ? p["numCtx"] : undefined;
  const maxTokens = typeof p["maxTokens"] === "number" ? p["maxTokens"] : undefined;
  const temperature = typeof p["temperature"] === "number" ? p["temperature"] : undefined;

  // Resolve apiKey — supports "env:VAR_NAME" pattern
  let apiKey: string | undefined;
  if (typeof p["apiKey"] === "string") {
    const raw = p["apiKey"];
    apiKey = raw.startsWith("env:") ? process.env[raw.slice(4)] : raw;
  }

  const hasAny = type || model || baseUrl || apiKey || numCtx !== undefined || maxTokens !== undefined || temperature !== undefined;
  if (!hasAny) return undefined;

  return { type, model, baseUrl, apiKey, numCtx, maxTokens, temperature };
}
