/**
 * OS-abstracted process operations.
 *
 * All process spawning, signal handling, and exit calls go through this module.
 * If a future platform needs different behavior (e.g., Windows vs Unix signal
 * semantics), only this file changes.
 */
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
/**
 * Spawn a child process. Wraps `child_process.spawn` behind a
 * platform-agnostic interface.
 */
export declare function spawnProcess(command: string, args: string[], opts?: SpawnOptions): SpawnedProcess;
/**
 * Register a handler for a process signal (e.g., "SIGINT", "SIGTERM").
 */
export declare function onSignal(signal: string, handler: () => void): void;
/**
 * Exit the current process with the given code.
 */
export declare function exitProcess(code: number): never;
/**
 * Return the path to the current Node.js executable.
 */
export declare function getExecPath(): string;
//# sourceMappingURL=process.d.ts.map