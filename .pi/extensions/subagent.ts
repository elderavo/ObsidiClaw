/**
 * Subagent Extension Framework
 * 
 * Enables the main LLM to spawn specialized subagents for focused tasks.
 * Each subagent call gets its own run in the logging system.
 */

import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { spawn } from "node:child_process";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const activeSubagents = new Set<{ process: any; tempFiles: string[] }>();

  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn Subagent", 
    description: "Launch a specialized Pi subagent for a focused task with specific plan, context, and success criteria",
    promptSnippet: "spawn_subagent(plan, context, success_criteria) — launch specialized subagent",
    parameters: Type.Object({
      plan: Type.String({
        description: "Detailed plan of what the subagent should accomplish"
      }),
      context: Type.String({
        description: "Relevant context and background information for the subagent"  
      }),
      success_criteria: Type.String({
        description: "Clear criteria for determining if the task was completed successfully"
      }),
      timeout_minutes: Type.Optional(Type.Number({
        description: "Maximum runtime in minutes (default: 5)",
        minimum: 1,
        maximum: 30
      }))
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const startTime = Date.now();
      const subagentId = randomUUID();
      
      onUpdate?.({ 
        content: [{ type: "text", text: `🤖 Launching subagent: ${params.plan.slice(0, 80)}...` }],
        details: { subagentId, status: "launching" }
      });

      try {
        const result = await spawnSubagent(params, {
          signal,
          onUpdate: (status, message) => {
            onUpdate?.({
              content: [{ type: "text", text: `🤖 ${status}: ${message}` }],
              details: { subagentId, status }
            });
          }
        });

        const duration = Date.now() - startTime;
        
        return {
          content: [{
            type: "text",
            text: result.success 
              ? `✅ **Subagent completed** (${Math.round(duration/1000)}s)\n\n${result.output}`
              : `❌ **Subagent failed** (${Math.round(duration/1000)}s)\n\n**Error:** ${result.error}\n\n**Output:** ${result.output}`
          }],
          details: { subagent_result: result, duration_ms: duration }
        };

      } catch (error) {
        const duration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        return {
          content: [{
            type: "text", 
            text: `💥 **Subagent failed** (${Math.round(duration/1000)}s): ${errorMessage}`
          }],
          details: { error: errorMessage, duration_ms: duration }
        };
      }
    }
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", async () => {
    for (const subagent of activeSubagents) {
      try {
        subagent.process.kill('SIGTERM');
        for (const file of subagent.tempFiles) {
          await unlink(file).catch(() => {});
        }
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    activeSubagents.clear();
  });

  async function spawnSubagent(
    params: { plan: string; context: string; success_criteria: string; timeout_minutes?: number },
    options: {
      signal?: AbortSignal;
      onUpdate?: (status: string, message: string) => void;
    }
  ) {
    const { signal, onUpdate } = options;
    const tempFiles: string[] = [];
    const subagentId = randomUUID();
    
    try {
      // Create session directory
      const sessionDir = join(process.cwd(), '.claude', 'subagent-sessions', subagentId);
      await mkdir(sessionDir, { recursive: true });

      // Create prompt file
      const promptFile = join(sessionDir, 'prompt.txt');
      tempFiles.push(promptFile);
      
      const prompt = createSubagentPrompt(params);
      await writeFile(promptFile, prompt, 'utf8');
      
      onUpdate?.("initializing", "Created subagent prompt");

      // Spawn Pi process
      const piProcess = spawn('npx', ['pi', '-p'], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      // Track for cleanup
      const subagentInfo = { process: piProcess, tempFiles };
      activeSubagents.add(subagentInfo);

      let stdout = '';
      let stderr = '';
      
      piProcess.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      
      piProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle cancellation
      if (signal) {
        signal.addEventListener('abort', () => {
          piProcess.kill('SIGTERM');
        });
      }

      onUpdate?.("running", `Started subagent (PID: ${piProcess.pid})`);

      // Send prompt
      piProcess.stdin?.write(prompt);
      piProcess.stdin?.end();

      // Wait for completion with timeout
      const timeoutMs = (params.timeout_minutes || 5) * 60 * 1000;
      const timeoutId = setTimeout(() => {
        piProcess.kill('SIGTERM');
      }, timeoutMs);

      const exitCode = await new Promise<number | null>((resolve) => {
        piProcess.on('close', (code) => {
          clearTimeout(timeoutId);
          resolve(code);
        });
      });

      // Cleanup
      activeSubagents.delete(subagentInfo);
      for (const file of tempFiles) {
        await unlink(file).catch(() => {});
      }

      const success = exitCode === 0;
      onUpdate?.("completed", success ? "Success" : `Failed (exit ${exitCode})`);

      return {
        success,
        output: stdout.trim() || "(no output)",
        error: success ? undefined : (stderr || `Process exited with code ${exitCode}`),
        exit_code: exitCode
      };

    } catch (error) {
      // Cleanup on error
      for (const file of tempFiles) {
        await unlink(file).catch(() => {});
      }
      
      throw error;
    }
  }

  function createSubagentPrompt(params: { plan: string; context: string; success_criteria: string }): string {
    return `# Subagent Task

You are a specialized AI assistant focused on completing a specific task.

## Your Mission

**PLAN**: ${params.plan}

**CONTEXT**: ${params.context}

**SUCCESS CRITERIA**: ${params.success_criteria}

## Instructions

1. Focus exclusively on the plan above
2. Use the provided context to inform your approach
3. Work systematically towards the success criteria
4. Use available tools as needed (read, write, edit, bash)
5. Be efficient - you have limited time
6. Provide a clear summary when complete

Your task is complete when: ${params.success_criteria}

Begin working now.
`;
  }
}