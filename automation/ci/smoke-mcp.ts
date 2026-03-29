/**
 * CI smoke test: ensure the TS MCP client can spawn the Node MCP server,
 * which in turn can spawn the Python knowledge graph subprocess.
 *
 * Runs in "offline" mode by default:
 * - OBSIDI_EMBED_PROVIDER=local (no vector embeddings)
 * - OBSIDI_CONTEXT_REVIEW=0 (no LLM calls for review/synthesis)
 */

import { randomUUID } from "crypto";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main(): Promise<void> {
  const rootDir = process.env["OBSIDI_ROOT_DIR"] ?? process.cwd();
  const sessionId = process.env["OBSIDI_SESSION_ID"] ?? randomUUID();

  const transport = new StdioClientTransport({
    command: "node",
    args: [join(rootDir, "dist", "entry", "mcp-process.js")],
    env: {
      ...process.env,
      OBSIDI_ROOT_DIR: rootDir,
      OBSIDI_SESSION_ID: sessionId,
      OBSIDI_EMBED_PROVIDER: process.env["OBSIDI_EMBED_PROVIDER"] ?? "local",
      OBSIDI_CONTEXT_REVIEW: process.env["OBSIDI_CONTEXT_REVIEW"] ?? "0",
      OBSIDI_CLAW_DEBUG: process.env["OBSIDI_CLAW_DEBUG"] ?? "0",
    } as any,
  });

  const client = new Client({ name: "obsidi-claw-ci-smoke", version: "1.0.0" });

  await client.connect(transport);

  // Basic RPC sanity: preferences should always exist.
  const prefs = await client.callTool({ name: "get_preferences", arguments: {} });
  const blocks = (prefs as any)?.content as { type: string; text?: string }[] | undefined;
  const text = blocks?.find((b) => b.type === "text")?.text ?? "";
  if (!text || text.length < 20) {
    throw new Error("Smoke test failed: get_preferences returned empty content");
  }

  // Retrieval wiring: should return some context even in local/degraded mode.
  const ctx = await client.callTool({ name: "retrieve_context", arguments: { query: "graceful degradation" } });
  const ctxBlocks = (ctx as any)?.content as { type: string; text?: string }[] | undefined;
  const ctxText = ctxBlocks?.find((b) => b.type === "text")?.text ?? "";
  if (!ctxText || ctxText.length < 50) {
    throw new Error("Smoke test failed: retrieve_context returned empty content");
  }

  await client.close();
}

main().catch((err) => {
  process.stderr.write(`[smoke-mcp] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
