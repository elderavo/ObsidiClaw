import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { extractMcpText } from "../../core/text-utils.js";
import type { ToolContext } from "./types.js";

export function registerWorkspaceTools(pi: ExtensionAPI, ctx: ToolContext): void {
  pi.registerTool({
    name: "register_workspace",
    label: "Register Workspace",
    description:
      "Register a source directory as a workspace for code mirroring. " +
      "Runs an initial mirror pass and starts a file watcher for continuous updates. " +
      "Mirrored notes become available via retrieve_context.",
    promptSnippet: "register_workspace(name, source_dir, mode?, languages?) — register a codebase for analysis",
    parameters: Type.Object({
      name: Type.String({
        description: "Unique slug (lowercase alphanumeric + hyphens, 2-64 chars). Used as folder name in md_db.",
      }),
      source_dir: Type.String({
        description: "Absolute path to the source directory to mirror.",
      }),
      mode: Type.Optional(Type.String({
        description: "'code' = mirror pipeline; 'know' = conversational knowledge (future). Default: 'code'.",
      })),
      languages: Type.Optional(Type.Array(Type.String(), {
        description: "Which languages to mirror, e.g. ['ts', 'py']. Default: ['ts'].",
      })),
    }),
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const { name, source_dir, mode, languages } = args as {
        name: string; source_dir: string; mode?: string; languages?: string[];
      };
      const mcpArgs: Record<string, unknown> = { name, source_dir };
      if (mode) mcpArgs.mode = mode;
      if (languages) mcpArgs.languages = languages;
      const result = await ctx.client.callTool({ name: "register_workspace", arguments: mcpArgs });
      const text = extractMcpText(result);
      return {
        content: [{ type: "text" as const, text }],
        details: { name, source_dir },
      };
    },
  });

  pi.registerTool({
    name: "list_workspaces",
    label: "List Workspaces",
    description: "List all registered workspaces and their status.",
    promptSnippet: "list_workspaces() — show all registered workspaces",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _args, _signal, _onUpdate, _ctx) => {
      const result = await ctx.client.callTool({ name: "list_workspaces", arguments: {} });
      const text = extractMcpText(result);
      return {
        content: [{ type: "text" as const, text }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "unregister_workspace",
    label: "Unregister Workspace",
    description:
      "Unregister a workspace: stops watcher, optionally deletes mirrored notes, " +
      "and removes from registry.",
    promptSnippet: "unregister_workspace(name, delete_notes?) — remove a registered workspace",
    parameters: Type.Object({
      name: Type.String({
        description: "Workspace name to remove.",
      }),
      delete_notes: Type.Optional(Type.Boolean({
        description: "Delete mirrored notes from md_db (default: true).",
      })),
    }),
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const { name, delete_notes } = args as { name: string; delete_notes?: boolean };
      const mcpArgs: Record<string, unknown> = { name };
      if (delete_notes != null) mcpArgs.delete_notes = delete_notes;
      const result = await ctx.client.callTool({ name: "unregister_workspace", arguments: mcpArgs });
      const text = extractMcpText(result);
      return {
        content: [{ type: "text" as const, text }],
        details: { name },
      };
    },
  });
}
