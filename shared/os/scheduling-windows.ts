import { spawnSync } from "child_process";
import type { PersistentScheduleBackend, ScheduledJob } from "./scheduling.js";

/** Windows Task Scheduler backend (schtasks). */
export class WindowsTaskSchedulerBackend implements PersistentScheduleBackend {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  async install(jobName: string, intervalMs: number, command: string, args: string[]): Promise<void> {
    const { scheduleType, modifier } = intervalToSchedule(intervalMs);
    const taskCmd = buildTaskCommand(this.rootDir, command, args);

    this.execSchtasks([
      "/Create",
      "/TN",
      jobName,
      "/TR",
      taskCmd,
      "/SC",
      scheduleType,
      "/MO",
      String(modifier),
      "/F",
    ]);
  }

  async uninstall(jobName: string): Promise<void> {
    this.execSchtasks(["/Delete", "/TN", jobName, "/F"]);
  }

  async list(): Promise<ScheduledJob[]> {
    // CSV is easier to parse; /V provides Status.
    const { stdout } = this.execSchtasks(["/Query", "/FO", "CSV", "/V"], true);
    return parseSchtasksCsv(stdout)
      .filter((row) => row["TaskName"]?.startsWith("\\ObsidiClaw\\"))
      .map((row) => {
        const jobName = row["TaskName"].replace(/^\\/, "");
        const status = row["Status"] ?? "";
        const enabled = (row["Schedule Type"] ?? "").toLowerCase() !== "disabled" && status.toLowerCase() !== "disabled";
        return {
          jobName,
          intervalMs: 0, // unknown from query; not critical for listing
          command: "",
          args: [],
          enabled,
          status,
        } satisfies ScheduledJob;
      });
  }

  async setEnabled(jobName: string, enabled: boolean): Promise<void> {
    this.execSchtasks(["/Change", "/TN", jobName, enabled ? "/ENABLE" : "/DISABLE"]);
  }

  async run(jobName: string): Promise<void> {
    this.execSchtasks(["/Run", "/TN", jobName]);
  }

  // -------------------------------------------------------------------------

  private execSchtasks(args: string[], allowErrorOutput = false): { stdout: string; stderr: string } {
    const result = spawnSync("schtasks", args, {
      encoding: "utf8",
      windowsHide: true, // prevent console window flashes
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0 && !allowErrorOutput) {
      throw new Error(result.stderr || `schtasks exited with code ${result.status}`);
    }
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function intervalToSchedule(intervalMs: number): { scheduleType: "MINUTE" | "HOURLY" | "DAILY"; modifier: number } {
  if (intervalMs < 60_000) {
    throw new Error("Windows Task Scheduler requires intervals >= 1 minute");
  }
  const minutes = Math.ceil(intervalMs / 60_000);
  if (minutes < 60) return { scheduleType: "MINUTE", modifier: minutes };
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return { scheduleType: "HOURLY", modifier: hours };
  const days = Math.ceil(hours / 24);
  return { scheduleType: "DAILY", modifier: days };
}

function buildTaskCommand(rootDir: string, command: string, args: string[]): string {
  const quotedArgs = args.map(quote);
  const cmd = `${quote(command)} ${quotedArgs.join(" ")}`.trim();
  // Use cmd /c to set working directory before execution.
  return `cmd /c "cd /d ${quote(rootDir)} && ${cmd}"`;
}

function quote(value: string): string {
  if (/^\".*\"$/.test(value)) return value; // already quoted
  if (/\s/.test(value) || /"/.test(value)) return `"${value.replace(/"/g, '\\"')}"`;
  return value;
}

function parseSchtasksCsv(csv: string): Array<Record<string, string>> {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = values[i] ?? "";
    });
    return row;
  });
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
