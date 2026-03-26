import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { extractMcpText } from "../../core/text-utils.js";
import type { ToolContext } from "./types.js";

export function registerFindPathTool(pi: ExtensionAPI, ctx: ToolContext): void {
  pi.registerTool({
    name: "find_path",
    label: "Find Graph Path",
    description:
      "Find the shortest path between two concepts or notes in the ObsidiClaw knowledge graph. " +
      "Endpoints can be note paths (e.g. 'code/obsidi-claw/logger/run-logger.ts.md') or " +
      "natural language (e.g. 'logger subsystem'). Returns a step-by-step chain of notes " +
      "and edge labels connecting them.",
    promptSnippet:
      "find_path(start, end, edge_types?, max_depth?) — explain how two parts of the codebase are connected",
    promptGuidelines: [
      "Use find_path when you need to understand how two parts of the codebase relate structurally (e.g. how the scheduler connects to the context engine).",
      "Start/end can be fuzzy descriptions or exact note paths; the retriever will resolve them.",
      "Optionally restrict edge_types to focus on particular relationships (CALLS, IMPORTS, DEFINED_IN, BELONGS_TO, CONTAINS, CONTAINS_SYMBOL, LINKS_TO).",
    ],
    parameters: Type.Object({
      start: Type.String({
        description: "Starting concept, note path, or search query (e.g. 'scheduler jobs', 'code/obsidi-claw/entry/stack.md').",
      }),
      end: Type.String({
        description: "Ending concept, note path, or search query.",
      }),
      edge_types: Type.Optional(Type.Array(Type.String(), {
        description:
          "Optional edge types to traverse. Default: all. Options: CALLS, DEFINED_IN, BELONGS_TO, " +
          "CONTAINS, CONTAINS_SYMBOL, IMPORTS, LINKS_TO.",
      })),
      max_depth: Type.Optional(Type.Number({
        description: "Maximum path length in hops (default: 8).",
      })),
    }),
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const { start, end, edge_types, max_depth } = args as {
        start: string;
        end: string;
        edge_types?: string[];
        max_depth?: number;
      };

      const mcpArgs: Record<string, unknown> = { start, end };
      if (edge_types && edge_types.length > 0) mcpArgs.edge_types = edge_types;
      if (max_depth != null) mcpArgs.max_depth = max_depth;

      const result = await ctx.client.callTool({ name: "find_path", arguments: mcpArgs });
      const text = extractMcpText(result);
      return {
        content: [{ type: "text" as const, text }],
        details: { start, end },
      };
    },
  });
}
