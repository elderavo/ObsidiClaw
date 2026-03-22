/**
 * OS-abstracted filesystem operations.
 *
 * Wraps Node.js `fs` behind a thin interface so that future platform-specific
 * behavior (permissions, path conventions, etc.) can be swapped in one place.
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, readdirSync, } from "fs";
/**
 * Ensure a directory exists, creating it (and parents) if needed.
 */
export function ensureDir(dirPath) {
    mkdirSync(dirPath, { recursive: true });
}
/**
 * Read a file as UTF-8 text. Throws if the file does not exist.
 */
export function readText(filePath) {
    return readFileSync(filePath, "utf8");
}
/**
 * Write UTF-8 text to a file, creating or overwriting it.
 */
export function writeText(filePath, content) {
    writeFileSync(filePath, content, "utf8");
}
/**
 * Append UTF-8 text to a file, creating it if needed.
 */
export function appendText(filePath, content) {
    appendFileSync(filePath, content, "utf8");
}
/**
 * Check whether a file or directory exists at the given path.
 */
export function fileExists(filePath) {
    return existsSync(filePath);
}
/**
 * Delete a file. Throws if the file does not exist.
 */
export function removeFile(filePath) {
    unlinkSync(filePath);
}
/**
 * List entries in a directory. Returns filenames (not full paths).
 */
export function listDir(dirPath) {
    return readdirSync(dirPath);
}
//# sourceMappingURL=fs.js.map