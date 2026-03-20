"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunLogger = void 0;
/**
 * RunLogger — records events that occur during an orchestrator run.
 *
 * Phase 3 (this file): console.log stub so the orchestrator has something
 * to call. No persistence.
 *
 * TODO: Phase 4 — replace with SQLite backend.
 *   Schema sketch:
 *     runs(run_id TEXT PK, started_at INTEGER, ended_at INTEGER, stage TEXT, error TEXT)
 *     events(id INTEGER PK, run_id TEXT FK, type TEXT, timestamp INTEGER, payload TEXT)
 *
 * TODO: Phase 4 — add getRunHistory(runId?: string): Promise<RunEvent[]>
 * TODO: Phase 7 — add getRuns(): Promise<RunSummary[]> for comparison engine
 */
var RunLogger = /** @class */ (function () {
    function RunLogger() {
    }
    RunLogger.prototype.logEvent = function (event) {
        // TODO: Phase 4 — write to SQLite instead
        var ts = new Date(event.timestamp).toISOString();
        console.error("[".concat(ts, "] [").concat(event.type, "]"), JSON.stringify(event));
    };
    return RunLogger;
}());
exports.RunLogger = RunLogger;
