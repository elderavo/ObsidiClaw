/**
 * Built-in normalize job — periodically scans md_db for formatting issues
 * and auto-fixes safe inconsistencies (frontmatter format, missing type fields).
 */
import type { JobDefinition } from "../types.js";
/**
 * Create a normalize job that runs normalizeMdDb with fix: true.
 *
 * @param mdDbPath  Absolute path to the md_db directory
 * @param intervalHours  How often to normalize (default: 2)
 */
export declare function createNormalizeJob(mdDbPath: string, intervalHours?: number): JobDefinition;
//# sourceMappingURL=normalize.d.ts.map