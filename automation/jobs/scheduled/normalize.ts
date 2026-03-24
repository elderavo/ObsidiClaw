/**
 * Built-in normalize job — periodically scans md_db for formatting issues
 * and auto-fixes safe inconsistencies (frontmatter format, missing type fields).
 */

import type { JobDefinition } from "../types.js";
import type { ObsidiClawPaths } from "../../../core/config.js";
import { normalizeMdDb } from "../../../knowledge/markdown/normalizer.js";

export function createNormalizeJob(intervalHours = 2): JobDefinition {
  return {
    name: "normalize-md-db",
    description: "Scan and auto-fix markdown formatting issues in md_db",
    schedule: { hours: intervalHours },
    skipIfRunning: true,
    timeoutMs: 60_000,
  };
}

export function run(paths: ObsidiClawPaths): Promise<void> {
  const result = normalizeMdDb(paths.mdDbPath, { fix: true });
  if (result.fixed > 0 || result.issues.length > 0) {
    // console.log(`scanned=${result.scanned} issues=${result.issues.length} fixed=${result.fixed}`);
  }
  return Promise.resolve();
}
