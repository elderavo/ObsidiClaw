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
export function extractMessageText(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        const parts = [];
        for (const c of content) {
            if (typeof c === "string") {
                parts.push(c);
            }
            else if (c && typeof c === "object" && "text" in c && typeof c.text === "string") {
                parts.push(c.text);
            }
        }
        return parts.join("\n");
    }
    if (content && typeof content === "object" && "text" in content && typeof content.text === "string") {
        return content.text;
    }
    return "";
}
/**
 * Extract the first text block from an MCP CallToolResult.
 *
 * MCP's `callTool()` returns `{ [x: string]: unknown; content: ContentBlock[] }`
 * where the index signature widens `content` to `unknown` in TypeScript.
 * This helper casts safely and returns the first text content block.
 */
export function extractMcpText(result) {
    const blocks = result.content ?? [];
    const textBlock = blocks.find((c) => c.type === "text");
    return textBlock?.text ?? "";
}
//# sourceMappingURL=text-utils.js.map