import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { extractMcpText } from "../../core/text-utils.js";
import type { ToolContext } from "./types.js";

export function registerRateContextTool(pi: ExtensionAPI, ctx: ToolContext): void {
  pi.registerTool({
    name: "rate_context",
    label: "Rate Retrieved Context",
    description:
      "Rate how well the last retrieve_context result answered your query. " +
      "Call this AFTER you've used the retrieved context to answer or act. " +
      "Your rating helps the knowledge base improve over time.",
    promptSnippet: "rate_context(retrieval_id, query, score, missing, helpful) — rate last retrieval quality",
    parameters: Type.Object({
      retrieval_id: Type.String({ description: "The retrieval_id from the <!-- retrieval_id: ... --> comment in the retrieve_context response." }),
      query: Type.String({ description: "The original query you searched for." }),
      score: Type.Number({
        description: "1=irrelevant, 2=mostly unhelpful, 3=partial, 4=good, 5=exactly right.",
        minimum: 1,
        maximum: 5,
      }),
      missing: Type.String({ description: "What was missing? Empty string if nothing." }),
      helpful: Type.String({ description: "Which notes/sections helped most? Empty string if none." }),
    }),
    execute: async (_toolCallId, args, _signal, _onUpdate, _ctx) => {
      const result = await ctx.client.callTool({ name: "rate_context", arguments: args });
      const text = extractMcpText(result);
      return {
        content: [{ type: "text" as const, text }],
        details: { query: args.query, score: args.score },
      };
    },
  });
}
