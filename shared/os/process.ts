/**
 * OS-abstracted process operations.
 *
 * All process spawning, signal handling, and exit calls go through this module.
 * If a future platform needs different behavior (e.g., Windows vs Unix signal
 * semantics), only this file changes.
 */

import { spawn, type ChildProcess, type StdioOptions } from "child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpawnOptions {
  detached?: boolean;
  stdio?: "ignore" | "pipe" | "inherit";
  cwd?: string;
  env?: Record<string, string>;
}

export interface SpawnedProcess {
  readonly pid: number | undefined;
  unref(): void;
  kill(signal?: string): boolean;
}

// ---------------------------------------------------------------------------
// Process spawning
// ---------------------------------------------------------------------------

/**
 * Spawn a child process. Wraps `child_process.spawn` behind a
 * platform-agnostic interface.
 */
export function spawnProcess(
  command: string,
  args: string[],
  opts?: SpawnOptions,
): SpawnedProcess {
  const child: ChildProcess = spawn(command, args, {
    detached: opts?.detached,
    stdio: (opts?.stdio ?? "pipe") as StdioOptions,
    cwd: opts?.cwd,
    env: opts?.env ? { ...process.env, ...opts.env } : undefined,
  });

  return {
    get pid() {
      return child.pid;
    },
    unref() {
      child.unref();
    },
    kill(signal?: string) {
      return child.kill(signal as NodeJS.Signals | undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// Signal handling
// ---------------------------------------------------------------------------

/**
 * Register a handler for a process signal (e.g., "SIGINT", "SIGTERM").
 */
export function onSignal(signal: string, handler: () => void): void {
  process.on(signal, handler);
}

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

/**
 * Exit the current process with the given code.
 */
export function exitProcess(code: number): never {
  process.exit(code);
}

/**
 * Return the path to the current Node.js executable.
 */
export function getExecPath(): string {
  return process.execPath;
}
