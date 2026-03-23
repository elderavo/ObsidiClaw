/**
 * Provider-agnostic LLM chat client.
 *
 * Routes to Ollama or OpenAI based on `getLlmConfig()`.
 * Throws `ProviderUnreachableError` for network failures so callers can
 * distinguish "server down" from "bad auth" or "model not found".
 */

import axios, { type AxiosError } from "axios";
import { getLlmConfig, type LlmConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  /** Override model from config. */
  model?: string;
  /** Sampling temperature (0–2). */
  temperature?: number;
  /** Max tokens to generate (OpenAI max_tokens / Ollama num_predict). */
  maxTokens?: number;
  /** Context window size (Ollama num_ctx). */
  numCtx?: number;
  /** Request timeout in ms. */
  timeout?: number;
}

export interface ChatResult {
  content: string;
  model: string;
  provider: string;
}

// ---------------------------------------------------------------------------
// ProviderUnreachableError
// ---------------------------------------------------------------------------

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
]);

export class ProviderUnreachableError extends Error {
  readonly provider: string;
  readonly host: string;
  override readonly cause: unknown;

  constructor(provider: string, host: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`LLM provider "${provider}" unreachable at ${host}: ${msg}`);
    this.name = "ProviderUnreachableError";
    this.provider = provider;
    this.host = host;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a chat completion request to the configured LLM provider.
 *
 * @throws {ProviderUnreachableError} if the provider cannot be reached (network error).
 * @throws {Error} for auth failures, model-not-found, etc.
 */
export async function llmChat(
  messages: ChatMessage[],
  opts?: ChatOptions,
): Promise<ChatResult> {
  const config = getLlmConfig();
  const model = opts?.model ?? config.model;
  const timeout = opts?.timeout ?? 120_000;

  try {
    if (config.provider === "openai") {
      return await callOpenAI(config, model, messages, opts, timeout);
    }
    // Default: ollama
    return await callOllama(config, model, messages, opts, timeout);
  } catch (err) {
    if (err instanceof ProviderUnreachableError) throw err;
    if (isNetworkError(err)) {
      throw new ProviderUnreachableError(config.provider, config.host, err);
    }
    throw err;
  }
}

/**
 * Quick check whether the LLM provider is reachable.
 *
 * @returns `true` if a minimal chat succeeds, `false` on ProviderUnreachableError.
 * @throws on non-network errors (auth, model-not-found, etc.)
 */
export async function isLlmReachable(): Promise<boolean> {
  try {
    await llmChat(
      [{ role: "user", content: "ping" }],
      { maxTokens: 1, timeout: 5000 },
    );
    return true;
  } catch (err) {
    if (err instanceof ProviderUnreachableError) return false;
    // For other errors (e.g. 404, 401) — provider is reachable but misconfigured.
    // Still treat as "unreachable" for job gating purposes since we can't use it.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

async function callOllama(
  config: LlmConfig,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions | undefined,
  timeout: number,
): Promise<ChatResult> {
  const url = `${config.host}/api/chat`;

  const ollamaOpts: Record<string, unknown> = {};
  if (opts?.temperature !== undefined) ollamaOpts.temperature = opts.temperature;
  if (opts?.numCtx !== undefined) ollamaOpts.num_ctx = opts.numCtx;
  if (opts?.maxTokens !== undefined) ollamaOpts.num_predict = opts.maxTokens;

  const response = await axios.post(
    url,
    {
      model,
      messages,
      stream: false,
      options: Object.keys(ollamaOpts).length > 0 ? ollamaOpts : undefined,
    },
    { timeout, signal: AbortSignal.timeout(timeout) },
  );

  return {
    content: response.data?.message?.content ?? "",
    model,
    provider: "ollama",
  };
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

async function callOpenAI(
  config: LlmConfig,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions | undefined,
  timeout: number,
): Promise<ChatResult> {
  const host = config.host || "https://api.openai.com";
  const url = `${host}/v1/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages,
  };
  if (opts?.temperature !== undefined) body.temperature = opts.temperature;
  if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const response = await axios.post(url, body, {
    headers,
    timeout,
    signal: AbortSignal.timeout(timeout),
  });

  const choice = response.data?.choices?.[0];
  return {
    content: choice?.message?.content ?? "",
    model: response.data?.model ?? model,
    provider: "openai",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // Axios error with a network code
  const axErr = err as AxiosError;
  if (axErr.code && NETWORK_CODES.has(axErr.code)) return true;

  // Axios error: no response received (network level)
  if (axErr.isAxiosError && !axErr.response) return true;

  // AbortSignal timeout
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;

  // Check nested cause
  if ((err as { cause?: unknown }).cause) {
    return isNetworkError((err as { cause: unknown }).cause);
  }

  return false;
}
