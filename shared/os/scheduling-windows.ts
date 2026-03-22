import { spawn, spawnSync } from "child_process";
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

    await execSchtasksAsync([
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
    await execSchtasksAsync(["/Delete", "/TN", jobName, "/F"]);
  }

  async list(): Promise<ScheduledJob[]> {
    // CSV is easier to parse; /V provides Status + schedule detail.
    // list() is only called during reconciliation, so sync is acceptable.
    const { stdout } = execSchtasksSync(["/Query", "/FO", "CSV", "/V"], true);
    return parseSchtasksCsv(stdout)
      .filter((row) => row["TaskName"]?.startsWith("\\ObsidiClaw\\"))
      .map((row) => {
        const jobName = row["TaskName"].replace(/^\\/, "");
        const status = row["Status"] ?? "";
        const scheduledState = (row["Scheduled Task State"] ?? "").toLowerCase();
        const enabled = scheduledState !== "disabled" && status.toLowerCase() !== "disabled";

        const repeatEvery = row["Repeat: Every"] ?? "";
        const { intervalMs, description } = parseRepeatEvery(repeatEvery, row["Schedule Type"] ?? "");

        const rawResult = row["Last Result"] ?? "";
        const lastResult = rawResult ? formatResultCode(rawResult) : undefined;

        return {
          jobName,
          intervalMs,
          command: row["Task To Run"] ?? "",
          args: [],
          enabled,
          status,
          lastRunTime: row["Last Run Time"] || undefined,
          lastResult,
          scheduleDescription: description,
        } satisfies ScheduledJob;
      });
  }

  async setEnabled(jobName: string, enabled: boolean): Promise<void> {
    await execSchtasksAsync(["/Change", "/TN", jobName, enabled ? "/ENABLE" : "/DISABLE"]);
  }

  async run(jobName: string): Promise<void> {
    await execSchtasksAsync(["/Run", "/TN", jobName]);
  }
}

// ---------------------------------------------------------------------------
// schtasks execution
// ---------------------------------------------------------------------------

/** Async schtasks — returns a Promise that resolves when the process exits. */
function execSchtasksAsync(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("schtasks", args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `schtasks exited with code ${code}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/** Sync schtasks — used only by list() where we need the result inline. */
function execSchtasksSync(args: string[], allowErrorOutput = false): { stdout: string; stderr: string } {
  const result = spawnSync("schtasks", args, {
    encoding: "utf8",
    windowsHide: true,
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

/**
 * Parse the "Repeat: Every" column from schtasks CSV.
 * Format: "N Hour(s), M Minute(s)" or "Disabled" or "N/A".
 * Falls back to scheduleType column (e.g. "Daily") when no repeat info.
 */
function parseRepeatEvery(raw: string, scheduleType: string): { intervalMs: number; description: string } {
  const hourMatch = raw.match(/(\d+)\s*Hour/i);
  const minMatch = raw.match(/(\d+)\s*Minute/i);
  const hours = hourMatch ? parseInt(hourMatch[1], 10) : 0;
  const minutes = minMatch ? parseInt(minMatch[1], 10) : 0;
  const intervalMs = hours * 3_600_000 + minutes * 60_000;

  if (intervalMs > 0) {
    const parts: string[] = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    return { intervalMs, description: `Every ${parts.join(" ")}` };
  }

  // No repeat — fall back to schedule type
  const st = scheduleType.trim();
  return { intervalMs: 0, description: st || "unknown" };
}

/**
 * Format a schtasks result code for display.
 * "0" → "0x0", "2147946720" → "0x800710E0"
 */
function formatResultCode(raw: string): string {
  const num = parseInt(raw, 10);
  if (isNaN(num)) return raw;
  return "0x" + (num >>> 0).toString(16).toUpperCase();
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
