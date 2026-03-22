/**
 * Shared configuration for ObsidiClaw.
 *
 * Centralises Ollama provider settings and path resolution so that
 * orchestrator, extensions, and detached workers all share one source of truth.
 */
import { join } from "path";
export function getOllamaConfig(overrides) {
    return {
        baseUrl: overrides?.baseUrl ?? process.env["OLLAMA_BASE_URL"] ?? "http://10.0.132.100:11434/v1",
        model: overrides?.model ?? process.env["OLLAMA_MODEL"] ?? "cogito:8b",
        contextWindow: overrides?.contextWindow ?? 32768,
        maxTokens: overrides?.maxTokens ?? 4096,
    };
}
/**
 * Resolve all ObsidiClaw paths from a root directory.
 * Falls back to process.cwd() only if no rootDir is provided.
 */
export function resolvePaths(rootDir) {
    const root = rootDir ?? process.cwd();
    return {
        rootDir: root,
        mdDbPath: join(root, "md_db"),
        dbPath: join(root, ".obsidi-claw", "runs.db"),
        graphDbPath: join(root, ".obsidi-claw", "graph.db"),
    };
}
//# sourceMappingURL=config.js.map