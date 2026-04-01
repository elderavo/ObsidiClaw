#!/usr/bin/env node
/**
 * notetaker — standalone CLI note capture for the vault inbox.
 *
 * Launches an in-terminal UI using @mariozechner/pi-tui (already installed).
 * Steps: title → content → note type → write to vault inbox.
 *
 * Cold start: tsx init (~0.5-1s) + TUI render (negligible). No Python subprocess.
 * The inbox pipeline (lint + link suggestions) runs asynchronously in the MCP
 * child process when Pi is active, or on next Pi startup.
 *
 * Usage:
 *   npx tsx automation/scripts/notetaker.ts
 *   npm run note
 */

import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  ProcessTerminal,
  TUI,
  SelectList,
  type SelectItem,
  type SelectListTheme,
  Container,
  type Component,
  KeybindingsManager as TuiKeybindingsManager,
  TUI_KEYBINDINGS,
} from "@mariozechner/pi-tui";
import {
  ExtensionEditorComponent,
  ExtensionInputComponent,
  type KeybindingsManager,
} from "@mariozechner/pi-coding-agent";
import { resolvePaths } from "../../core/config.js";
import { buildNoteContent, buildInboxFilename, VAULT_NOTE_TYPES, NOTE_TYPE_DESCRIPTIONS, type VaultNoteType } from "../../knowledge/markdown/vault-schema.js";

// ---------------------------------------------------------------------------
// Vault path resolution
// ---------------------------------------------------------------------------

function findVaultInboxPath(): { inboxPath: string; workspace: string } | undefined {
  const paths = resolvePaths();
  const registryPath = join(paths.rootDir, ".obsidi-claw", "workspaces.json");
  if (!existsSync(registryPath)) return undefined;

  try {
    const entries = JSON.parse(readFileSync(registryPath, "utf-8")) as Array<{
      mode: string;
      name: string;
      active: boolean;
    }>;
    const ws = entries.find((e) => e.mode === "know" && e.active);
    if (!ws) return undefined;
    return {
      inboxPath: join(paths.mdDbPath, "know", ws.name, "inbox"),
      workspace: ws.name,
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Minimal theme helpers
// ---------------------------------------------------------------------------

const selectTheme: SelectListTheme = {
  selectedPrefix: (s) => `→ ${s}`,
  selectedText: (s) => s,
  description: (s) => `  ${s}`,
  scrollInfo: (s) => s,
  noMatch: (s) => s,
};

function headerLines(step: string, total = 3, current: number): string[] {
  const steps = ["Title", "Content", "Type"];
  const indicator = steps.map((s, i) => (i + 1 === current ? `[${s}]` : s)).join("  →  ");
  return [
    "",
    "  ObsidiClaw — Capture Note",
    `  ${indicator}`,
    "",
  ];
}

// ---------------------------------------------------------------------------
// Step machine component
// ---------------------------------------------------------------------------

type Step = "title" | "content" | "type" | "done" | "cancelled";

class NoteTakerApp extends Container {
  private step: Step = "title";
  private title = "";
  private content = "";
  private noteType: VaultNoteType = "permanent";

  private titleComp: ExtensionInputComponent;
  private contentComp: ExtensionEditorComponent;
  private typeComp: SelectList;

  private tui: TUI;
  onDone?: (result: { title: string; content: string; type: VaultNoteType } | null) => void;

  constructor(tui: TUI, kb: KeybindingsManager) {
    super();
    this.tui = tui;

    // Title step
    this.titleComp = new ExtensionInputComponent(
      "Note Title",
      "e.g. My insight about...",
      (val) => {
        this.title = val.trim() || "Untitled";
        this.goToContent();
      },
      () => this.cancel(),
    );

    // Content step
    this.contentComp = new ExtensionEditorComponent(
      tui,
      kb,
      "Note Content  (Ctrl+D to submit · Esc to cancel)",
      undefined,
      (val) => {
        this.content = val;
        this.goToType();
      },
      () => this.cancel(),
    );

    // Type step
    const typeItems: SelectItem[] = VAULT_NOTE_TYPES.map((t) => ({
      value: t,
      label: NOTE_TYPE_DESCRIPTIONS[t],
    }));
    this.typeComp = new SelectList(typeItems, 5, selectTheme);
    this.typeComp.onSelect = (item) => {
      this.noteType = item.value as VaultNoteType;
      this.finish();
    };
    this.typeComp.onCancel = () => this.cancel();

    // Start at title step
    this.setStep("title");
  }

  private setStep(step: Step): void {
    this.step = step;
    this.children = [];

    // Build header
    const stepNum = step === "title" ? 1 : step === "content" ? 2 : 3;
    const steps = ["Title", "Content", "Type"];
    const indicator = steps.map((s, i) => (i + 1 === stepNum ? `[${s}]` : s)).join("  →  ");

    const header = {
      render: (_width: number) => ["", "  ObsidiClaw — Capture Note", `  ${indicator}`, ""],
      handleInput: undefined,
      invalidate: () => {},
    } satisfies Component;

    this.addChild(header);

    if (step === "title") {
      this.addChild(this.titleComp);
      this.tui.setFocus(this.titleComp);
    } else if (step === "content") {
      this.addChild(this.contentComp);
      this.tui.setFocus(this.contentComp);
    } else if (step === "type") {
      this.addChild(this.typeComp);
      this.tui.setFocus(this.typeComp);
    }

    this.tui.requestRender();
  }

  private goToContent(): void {
    this.setStep("content");
  }

  private goToType(): void {
    this.setStep("type");
  }

  private finish(): void {
    this.step = "done";
    this.tui.stop();
    this.onDone?.({ title: this.title, content: this.content, type: this.noteType });
  }

  private cancel(): void {
    this.step = "cancelled";
    this.tui.stop();
    this.onDone?.(null);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const vaultTarget = findVaultInboxPath();
  if (!vaultTarget) {
    process.stderr.write(
      "No active 'know' workspace found.\n" +
      "Register your vault with: register_workspace(name, path, mode='know')\n",
    );
    process.exit(1);
  }

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, false);
  // pi-coding-agent's KeybindingsManager extends pi-tui's. The extra methods
  // (configPath, reload, getEffectiveConfig) aren't called in standalone use.
  const kb = new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager;

  const result = await new Promise<{ title: string; content: string; type: VaultNoteType } | null>((resolve) => {
    const app = new NoteTakerApp(tui, kb);
    app.onDone = resolve;
    tui.addChild(app);
    tui.start();
  });

  if (!result) {
    process.stdout.write("\nNote capture cancelled.\n");
    process.exit(0);
  }

  // Write to inbox
  mkdirSync(vaultTarget.inboxPath, { recursive: true });
  const filename = buildInboxFilename(result.title);
  const fileContent = buildNoteContent(result.type, result.title, result.content, [], [], vaultTarget.workspace);
  writeFileSync(join(vaultTarget.inboxPath, filename), fileContent, "utf-8");

  process.stdout.write(`\n✓ Note saved: ${filename}\n`);
  process.stdout.write(`  → ${vaultTarget.inboxPath}\n`);
  process.stdout.write("  The inbox pipeline will process it when Pi is next active.\n\n");
}

main().catch((err) => {
  process.stderr.write(`notetaker error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
