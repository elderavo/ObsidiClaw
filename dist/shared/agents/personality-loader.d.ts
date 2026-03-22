/**
 * Personality loader — reads personality markdown files from disk.
 *
 * Personality files live in shared/agents/personalities/ (outside md_db)
 * so they are NOT indexed by the context engine and don't pollute
 * retrieval results.
 *
 * File format:
 * ```markdown
 * ---
 * type: personality
 * title: Deep Researcher
 * provider:
 *   model: llama3
 *   baseUrl: http://10.0.132.100/v1
 * ---
 * # Deep Researcher
 * You are a deep researcher...
 * ```
 */
import type { PersonalityConfig } from "./types.js";
/**
 * Load a personality by name from the given directory.
 * Returns null if the file doesn't exist.
 */
export declare function loadPersonality(name: string, personalitiesDir: string): PersonalityConfig | null;
/**
 * List all available personality names in the given directory.
 * Returns names without the .md extension.
 */
export declare function listPersonalities(personalitiesDir: string): string[];
//# sourceMappingURL=personality-loader.d.ts.map