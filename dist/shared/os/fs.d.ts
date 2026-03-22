/**
 * OS-abstracted filesystem operations.
 *
 * Wraps Node.js `fs` behind a thin interface so that future platform-specific
 * behavior (permissions, path conventions, etc.) can be swapped in one place.
 */
/**
 * Ensure a directory exists, creating it (and parents) if needed.
 */
export declare function ensureDir(dirPath: string): void;
/**
 * Read a file as UTF-8 text. Throws if the file does not exist.
 */
export declare function readText(filePath: string): string;
/**
 * Write UTF-8 text to a file, creating or overwriting it.
 */
export declare function writeText(filePath: string, content: string): void;
/**
 * Append UTF-8 text to a file, creating it if needed.
 */
export declare function appendText(filePath: string, content: string): void;
/**
 * Check whether a file or directory exists at the given path.
 */
export declare function fileExists(filePath: string): boolean;
/**
 * Delete a file. Throws if the file does not exist.
 */
export declare function removeFile(filePath: string): void;
/**
 * List entries in a directory. Returns filenames (not full paths).
 */
export declare function listDir(dirPath: string): string[];
//# sourceMappingURL=fs.d.ts.map