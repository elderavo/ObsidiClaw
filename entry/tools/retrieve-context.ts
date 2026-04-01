import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { extractMcpText } from "../../core/text-utils.js";
import type { ToolContext } from "./types.js";

export function registerRetrieveContextTool(pi: ExtensionAPI, ctx: ToolContext): void {
  pi.registerTool({
    name: "retrieve_context",
    label: "Knowledge Base Retrieval",
    description:
      "Search the ObsidiClaw knowledge base. The knowledge base contains multiple " +
      "workspaces — registered codebases (code mode) and knowledge collections " +
      "(know mode) — all in one unified graph. Returns markdown-formatted context " +
      "organized by tier: module overviews, file details, symbol signatures, call " +
      "relationships, concepts, and suggested tools. Call this before relying on " +
      "your own knowledge for any project-specific or domain-specific question.",
    promptSnippet:
      "retrieve_context(query, workspace?, max_chars?) — search the knowledge base. " +
      "Omit workspace to search everything; pass a workspace name to scope results.",
    promptGuidelines: [
      "Always call retrieve_context before answering questions about project tools, architecture, patterns, or domain knowledge.",
      "Name specific things in your query: symbols, functions, classes, files, concepts, topics. The knowledge base indexes at symbol level for code and at note level for concepts — specific queries return sharper context than broad ones.",
      "Include your intent alongside the subject: not just 'X' but 'how X is initialized', 'failure modes of X', 'what calls X', 'signature of X'. This helps the synthesizer surface the right information.",
      "For control-flow questions, name both the entry point and the destination: 'how A triggers B' returns better results than 'how does B work'.",
      "Use the workspace parameter to scope results when you know which codebase or knowledge domain is relevant. Omit it to search across all registered workspaces.",
      "Use list_workspaces to discover available workspaces if you're unsure what's registered.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "What to search for. Name specific symbols, functions, classes, concepts, or topics. " +
          "Include your intent (e.g. 'signature of X', 'failure modes of Y', 'how A calls B'). " +
          "Vague queries return vague context.",
      }),
      workspace: Type.Optional(Type.String({
        description:
          "Limit search to a specific registered workspace by name (e.g. 'obsidi-claw'). " +
          "Omit to search all workspaces.",
      })),
      max_chars: Type.Optional(Type.Number({
        description:
          "Maximum characters to return (default: 15000). Use a smaller value for tighter, " +
          "more focused context when you only need a quick answer.",
      })),
    }),
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const { query, workspace, max_chars } = args as { query: string; workspace?: string; max_chars?: number };
      const mcpArgs: Record<string, unknown> = { query };
      // Explicit workspace arg wins; fall back to active workspace selection.
      const effectiveWorkspace = workspace ?? ctx.activeWorkspace;
      if (effectiveWorkspace) mcpArgs.workspace = effectiveWorkspace;
      if (max_chars != null) mcpArgs.max_chars = max_chars;
      const result = await ctx.client.callTool({ name: "retrieve_context", arguments: mcpArgs });
      const text = extractMcpText(result);
      return {
        content: [{ type: "text" as const, text }],
        details: { query, ...(workspace ? { workspace } : {}) },
      };
    },
  });
}
