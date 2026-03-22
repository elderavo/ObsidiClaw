/**
 * OS-abstracted process operations.
 *
 * All process spawning, signal handling, and exit calls go through this module.
 * If a future platform needs different behavior (e.g., Windows vs Unix signal
 * semantics), only this file changes.
 */
import { spawn } from "child_process";
// ---------------------------------------------------------------------------
// Process spawning
// ---------------------------------------------------------------------------
/**
 * Spawn a child process. Wraps `child_process.spawn` behind a
 * platform-agnostic interface.
 */
export function spawnProcess(command, args, opts) {
    const child = spawn(command, args, {
        detached: opts?.detached,
        stdio: (opts?.stdio ?? "pipe"),
        cwd: opts?.cwd,
        env: opts?.env ? { ...process.env, ...opts.env } : undefined,
        windowsHide: true,
    });
    return {
        get pid() {
            return child.pid;
        },
        unref() {
            child.unref();
        },
        kill(signal) {
            return child.kill(signal);
        },
    };
}
// ---------------------------------------------------------------------------
// Signal handling
// ---------------------------------------------------------------------------
/**
 * Register a handler for a process signal (e.g., "SIGINT", "SIGTERM").
 */
export function onSignal(signal, handler) {
    process.on(signal, handler);
}
// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------
/**
 * Exit the current process with the given code.
 */
export function exitProcess(code) {
    process.exit(code);
}
/**
 * Return the path to the current Node.js executable.
 */
export function getExecPath() {
    return process.execPath;
}
//# sourceMappingURL=process.js.map