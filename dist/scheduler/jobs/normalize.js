/**
 * Built-in normalize job — periodically scans md_db for formatting issues
 * and auto-fixes safe inconsistencies (frontmatter format, missing type fields).
 */
import { normalizeMdDb } from "../../shared/markdown/normalizer.js";
/**
 * Create a normalize job that runs normalizeMdDb with fix: true.
 *
 * @param mdDbPath  Absolute path to the md_db directory
 * @param intervalHours  How often to normalize (default: 2)
 */
export function createNormalizeJob(mdDbPath, intervalHours = 2) {
    return {
        name: "normalize-md-db",
        description: "Scan and auto-fix markdown formatting issues in md_db",
        schedule: { hours: intervalHours },
        skipIfRunning: true,
        async execute(ctx) {
            if (ctx.signal.aborted)
                return;
            const result = normalizeMdDb(mdDbPath, { fix: true });
            if (result.fixed > 0 || result.issues.length > 0) {
                console.log(`[normalize-md-db] scanned=${result.scanned} issues=${result.issues.length} fixed=${result.fixed}`);
            }
        },
    };
}
//# sourceMappingURL=normalize.js.map