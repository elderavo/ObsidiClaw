import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionUIContext } from "@mariozechner/pi-coding-agent";

export interface CaptureNoteToolDeps {
  getLatestUI: () => ExtensionUIContext | undefined;
  captureNoteToInbox: (
    ui: ExtensionUIContext,
    suggestedTitle?: string,
    suggestedContent?: string,
  ) => Promise<string>;
}

export function registerCaptureNoteTool(pi: ExtensionAPI, deps: CaptureNoteToolDeps): void {
  pi.registerTool({
    name: "capture_note",
    label: "Capture Note",
    description:
      "Open the note capture modal so the user can save a note to their vault inbox. " +
      "Call this when the user asks to 'make a note', 'save this', or 'note that down'. " +
      "Pass suggested_title and suggested_content pre-filled from the conversation context — " +
      "the user will review and edit before submitting.",
    promptSnippet: "capture_note(suggested_title?, suggested_content?) — open note capture modal",
    parameters: Type.Object({
      suggested_title: Type.Optional(Type.String({
        description: "Pre-filled title for the note, derived from the conversation.",
      })),
      suggested_content: Type.Optional(Type.String({
        description: "Pre-filled body for the note, derived from the conversation.",
      })),
    }),
    execute: async (_toolCallId, args) => {
      const { suggested_title, suggested_content } = args as {
        suggested_title?: string;
        suggested_content?: string;
      };

      const ui = deps.getLatestUI();
      if (!ui) {
        return {
          content: [{ type: "text" as const, text: "UI not available. Run `notetaker` from the CLI instead." }],
          details: {},
        };
      }

      const result = await deps.captureNoteToInbox(ui, suggested_title, suggested_content);
      return {
        content: [{ type: "text" as const, text: result }],
        details: {},
      };
    },
  });
}
