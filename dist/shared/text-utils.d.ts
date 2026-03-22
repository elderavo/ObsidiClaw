/**
 * Shared text extraction utilities.
 *
 * Consolidates text extraction from MCP results and message content,
 * previously duplicated across extension/factory.ts, orchestrator/session.ts,
 * and shared/agents/subagent-runner.ts.
 */
/**
 * Extract text from a message content field.
 *
 * Handles:
 *   - Plain string
 *   - Object with a `text` property
 *   - Array of strings or `{ text }` objects
 *
 * Returns empty string for unrecognized shapes.
 */
export declare function extractMessageText(content: unknown): string;
/**
 * Extract the first text block from an MCP CallToolResult.
 *
 * MCP's `callTool()` returns `{ [x: string]: unknown; content: ContentBlock[] }`
 * where the index signature widens `content` to `unknown` in TypeScript.
 * This helper casts safely and returns the first text content block.
 */
export declare function extractMcpText(result: unknown): string;
//# sourceMappingURL=text-utils.d.ts.map