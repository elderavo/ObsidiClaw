/**
 * Built-in normalize job — periodically scans md_db for formatting issues
 * and auto-fixes safe inconsistencies (frontmatter format, missing type fields).
 */

import type { JobDefinition } from "../types.js";

/**
 * Create a normalize job definition.
 *
 * @param intervalHours  How often to normalize (default: 2)
 */
export function createNormalizeJob(intervalHours = 2): JobDefinition {
  return {
    name: "normalize-md-db",
    description: "Scan and auto-fix markdown formatting issues in md_db",
    schedule: { hours: intervalHours },
    skipIfRunning: true,
    timeoutMs: 60_000,
  };
}
