/**
 * MCP server child process — standalone entry point.
 *
 * Spawned by the TUI process (extension.ts) via StdioClientTransport.
 * Owns the full ObsidiClawStack (ContextEngine, WorkspaceRegistry, Python subprocess)
 * and exposes it through the MCP protocol over stdin/stdout.
 *
 * Stderr is free for Python subprocess logs + Node diagnostics.
 *
 * Lifecycle:
 *   1. TUI spawns this process with env OBSIDI_SESSION_ID
 *   2. Creates stack, MCP server, connects StdioServerTransport
 *   3. Initializes stack (mirrors + engine) — sends index progress notifications
 *   4. Serves MCP tool calls until stdin closes or SIGTERM
 *   5. Graceful shutdown: close engine, watchers, loggers
 */

import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContextEngineMcpServer } from "../knowledge/engine/index.js";
import { createObsidiClawStack } from "./stack.js";
import { drainWorkers } from "../automation/jobs/watchers/mirror-watcher.js";
import type { RunEvent } from "../logger/types.js";

// ---------------------------------------------------------------------------
// Session ID from parent process
// ---------------------------------------------------------------------------

if (!process.env["OBSIDI_SESSION_ID"]) {
  process.stderr.write("[mcp-process] FATAL: OBSIDI_SESSION_ID not set\n");
  process.exit(1);
}
const sessionId: string = process.env["OBSIDI_SESSION_ID"];

const rootDir = process.env["OBSIDI_ROOT_DIR"] ?? process.cwd();

// ---------------------------------------------------------------------------
// Stack + MCP server
// ---------------------------------------------------------------------------

// Build knowVaults map before stack init so it's ready for the MCP server.
// Populated once stack (and workspaceRegistry) is created.
const knowVaults = new Map<string, string>();

const stack = createObsidiClawStack({
  rootDir,
  sessionId,
  onInboxNote: (workspaceName, filePath) => {
    // Fire-and-forget: process_inbox_note MCP tool handles it properly.
    // Here we just log the event so runs.db has a trace.
    stack.logger.logEvent({
      type: "diagnostic",
      sessionId,
      timestamp: Date.now(),
      module: "inbox_watcher",
      level: "info",
      message: `Inbox note queued: ${workspaceName}/${filePath.split(/[\\/]/).pop()}`,
    } as RunEvent);
  },
});

// Populate knowVaults after stack is created — use mirrorDir (md_db/know/{ws})
for (const ws of stack.workspaceRegistry.list()) {
  if (ws.mode === "know" && ws.active) {
    knowVaults.set(ws.name, stack.workspaceRegistry.mirrorDir(ws));
  }
}

const mcpServer = createContextEngineMcpServer({
  engine: stack.engine,
  pruneStorage: stack.noteMetrics.pruneStorage,
  workspaceRegistry: stack.workspaceRegistry,
  mdDbPath: stack.paths.mdDbPath,
  knowVaults,
  onContextBuilt: (pkg) => {
    const noteHits = pkg.retrievedNotes.map((n) => ({
      noteId: n.noteId,
      score: n.score,
      depth: n.depth ?? 0,
      source: n.retrievalSource,
      tier: n.tier,
      noteType: n.type,
      symbolKind: n.symbolKind,
    }));
    const ts = Date.now();
    stack.logger.logEvent({
      type: "context_retrieved",
      sessionId,
      timestamp: ts,
      query: pkg.query,
      seedCount: pkg.seedNoteIds?.length ?? 0,
      expandedCount: pkg.expandedNoteIds?.length ?? 0,
      toolCount: pkg.suggestedTools.length,
      retrievalMs: pkg.retrievalMs,
      rawChars: pkg.rawChars,
      strippedChars: pkg.strippedChars,
      estimatedTokens: pkg.estimatedTokens,
      reviewMs: pkg.reviewResult?.reviewMs,
      reviewSkipped: pkg.reviewResult?.skipped,
      noteHits,
    } as RunEvent);
    stack.noteMetrics.logRetrieval({
      sessionId,
      timestamp: ts,
      query: pkg.query,
      seedCount: pkg.seedNoteIds?.length ?? 0,
      expandedCount: pkg.expandedNoteIds?.length ?? 0,
      toolCount: pkg.suggestedTools.length,
      retrievalMs: pkg.retrievalMs,
      rawChars: pkg.rawChars,
      strippedChars: pkg.strippedChars,
      estimatedTokens: pkg.estimatedTokens,
      noteHits,
    });
  },
  onContextRated: (rating) => {
    const ts = Date.now();
    stack.logger.logEvent({
      type: "context_rated",
      sessionId,
      timestamp: ts,
      retrievalId: rating.retrievalId,
      query: rating.query,
      score: rating.score,
      missing: rating.missing,
      helpful: rating.helpful,
    } as RunEvent);
    stack.noteMetrics.logRating({
      retrievalId: rating.retrievalId,
      sessionId,
      timestamp: ts,
      query: rating.query,
      score: rating.score,
      missing: rating.missing,
      helpful: rating.helpful,
    });
  },
  onBackgroundError: (context, err) => {
    stack.logger.logEvent({
      type: "diagnostic",
      sessionId,
      timestamp: Date.now(),
      module: "mcp_server",
      level: "error",
      message: `${context}: ${err instanceof Error ? err.message : String(err)}`,
    });
  },
});

// ---------------------------------------------------------------------------
// Index progress → MCP notification to TUI
// ---------------------------------------------------------------------------

stack.engine.on("indexProgress", (done: number, total: number) => {
  mcpServer.server.notification({
    method: "notifications/progress",
    params: {
      progressToken: "index",
      progress: done,
      total,
    },
  }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Connect transport + initialize
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();

async function main(): Promise<void> {
  // Connect transport FIRST so the TUI can establish MCP immediately.
  // Tool calls that arrive before init completes will get "ContextEngine not
  // initialized" errors — this is acceptable and expected. The TUI shows a
  // splash screen while waiting for the obsidi-claw/ready notification.
  await mcpServer.connect(transport);

  // Initialize stack (mirrors + engine). This is the slow part (20+ seconds
  // on slow path). Watchers start during init so source file edits are
  // captured even while embeddings are being generated.
  let initError: Error | undefined;
  try {
    await stack.initialize();
  } catch (err) {
    initError = err instanceof Error ? err : new Error(String(err));
    stack.logger.logEvent({
      type: "diagnostic",
      sessionId,
      timestamp: Date.now(),
      module: "mcp_process",
      level: "error",
      message: `context engine failed to initialize: ${initError.message}`,
    });
  }

  // Send ready notification — TUI uses this for startup splash + engine state
  if (initError) {
    await mcpServer.server.notification({
      method: "obsidi-claw/ready",
      params: {
        engineState: "unavailable",
        degradedReason: initError.message,
        noteCount: 0,
        edgeCount: 0,
        indexLoaded: false,
        activeWorkspaces: [],
      },
    } as any).catch(() => {});
  } else {
    const stats = await stack.engine.getGraphStats().catch(() => ({
      noteCount: 0, edgeCount: 0, indexLoaded: false,
    }));
    const activeWs = stack.workspaceRegistry.list().filter((w) => w.active);

    await mcpServer.server.notification({
      method: "obsidi-claw/ready",
      params: {
        engineState: stack.engine.isDegraded ? "degraded" : "ok",
        degradedReason: stack.engine.degradedReasonMessage ?? null,
        noteCount: stats.noteCount,
        edgeCount: stats.edgeCount,
        indexLoaded: stats.indexLoaded,
        activeWorkspaces: activeWs.map((w) => ({
          name: w.name,
          mode: w.mode,
          languages: w.languages,
          sourceDir: w.sourceDir,
        })),
      },
    } as any).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(): Promise<void> {
  try {
    // Wait for any running summarize workers to finish before closing the
    // logger and engine. This ensures summarizer_done events and the notes
    // they write (+ their reindex) land in the current session.
    await drainWorkers(30_000);
    await mcpServer.close();
    await stack.shutdown();
  } catch {
    // Best effort
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

// When parent disconnects, stdin closes
process.stdin.on("end", () => void shutdown());

main().catch((err) => {
  process.stderr.write(`[mcp-process] FATAL: ${err}\n`);
  process.exit(1);
});
