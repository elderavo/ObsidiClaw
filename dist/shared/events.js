export {};
/**
 * Shared event schema for ObsidiClaw.
 *
 * TODO: Phase 1 — migrate RunEvent discriminated union out of orchestrator/types.ts
 * and define the canonical event schema here.
 *
 * Events to define:
 *   - RunStartEvent
 *   - StageChangeEvent
 *   - ToolCallEvent
 *   - ToolResultEvent
 *   - RunEndEvent
 *   - RunErrorEvent
 *
 * Each event should have: type, runId, timestamp (ms), and event-specific payload.
 */
//# sourceMappingURL=events.js.map