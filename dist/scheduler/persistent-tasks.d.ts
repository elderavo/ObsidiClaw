export interface PersistentTaskSpec {
    name: string;
    description: string;
    prompt: string;
    plan: string;
    successCriteria: string;
    personality?: string;
    intervalMinutes: number;
    rootDir: string;
    createdAt: number;
    context?: string;
}
export declare function getSpecDir(rootDir: string): string;
export declare function getSpecPath(rootDir: string, name: string): string;
export declare function writeTaskSpec(rootDir: string, spec: PersistentTaskSpec): string;
export declare function listTaskSpecs(rootDir: string): PersistentTaskSpec[];
//# sourceMappingURL=persistent-tasks.d.ts.map