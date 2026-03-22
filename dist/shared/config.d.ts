/**
 * Shared configuration for ObsidiClaw.
 *
 * Centralises Ollama provider settings and path resolution so that
 * orchestrator, extensions, and detached workers all share one source of truth.
 */
export interface OllamaConfig {
    baseUrl: string;
    model: string;
    contextWindow: number;
    maxTokens: number;
}
export declare function getOllamaConfig(overrides?: Partial<OllamaConfig>): OllamaConfig;
export interface ObsidiClawPaths {
    /** Project root directory. */
    rootDir: string;
    /** Knowledge graph markdown directory. */
    mdDbPath: string;
    /** SQLite runs.db path (run/trace logging). */
    dbPath: string;
    /** SQLite graph.db path (knowledge graph store). */
    graphDbPath: string;
}
/**
 * Resolve all ObsidiClaw paths from a root directory.
 * Falls back to process.cwd() only if no rootDir is provided.
 */
export declare function resolvePaths(rootDir?: string): ObsidiClawPaths;
//# sourceMappingURL=config.d.ts.map