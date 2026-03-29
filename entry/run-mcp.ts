/**
 * Headless entry point for running the MCP server directly (no Pi TUI).
 *
 * This ensures required env vars are set, then loads `mcp-process.ts` which
 * owns the full stack and serves MCP over stdio.
 */

import "dotenv/config";
import { randomUUID } from "crypto";

if (!process.env["OBSIDI_SESSION_ID"]) {
  process.env["OBSIDI_SESSION_ID"] = randomUUID();
}

if (!process.env["OBSIDI_ROOT_DIR"]) {
  process.env["OBSIDI_ROOT_DIR"] = process.cwd();
}

await import("./mcp-process.js");
