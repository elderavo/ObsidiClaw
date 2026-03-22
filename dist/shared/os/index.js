/**
 * OS compatibility layer — re-exports.
 *
 * All OS-specific operations should be imported from this module.
 * Platform-specific behavior is isolated in the individual files.
 */
export { spawnProcess, onSignal, exitProcess, getExecPath, } from "./process.js";
export { ensureDir, readText, writeText, appendText, fileExists, removeFile, listDir, } from "./fs.js";
//# sourceMappingURL=index.js.map