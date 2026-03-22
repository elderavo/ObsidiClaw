import type { PersistentScheduleBackend, ScheduledJob } from "./scheduling.js";
/** Windows Task Scheduler backend (schtasks). */
export declare class WindowsTaskSchedulerBackend implements PersistentScheduleBackend {
    private readonly rootDir;
    constructor(rootDir: string);
    install(jobName: string, intervalMs: number, command: string, args: string[]): Promise<void>;
    uninstall(jobName: string): Promise<void>;
    list(): Promise<ScheduledJob[]>;
    setEnabled(jobName: string, enabled: boolean): Promise<void>;
    run(jobName: string): Promise<void>;
    private execSchtasks;
}
//# sourceMappingURL=scheduling-windows.d.ts.map