import { join } from "path";
import { ensureDir, listDir, readText, writeText } from "../shared/os/fs.js";

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

export function getSpecDir(rootDir: string): string {
  return join(rootDir, ".obsidi-claw", "scheduled");
}

export function getSpecPath(rootDir: string, name: string): string {
  return join(getSpecDir(rootDir), `${name}.json`);
}

export function writeTaskSpec(rootDir: string, spec: PersistentTaskSpec): string {
  const dir = getSpecDir(rootDir);
  ensureDir(dir);
  const path = getSpecPath(rootDir, spec.name);
  writeText(path, JSON.stringify(spec, null, 2));
  return path;
}

export function listTaskSpecs(rootDir: string): PersistentTaskSpec[] {
  const dir = getSpecDir(rootDir);
  try {
    const files = listDir(dir).filter((f) => f.endsWith(".json"));
    return files.map((f) => JSON.parse(readText(join(dir, f))) as PersistentTaskSpec);
  } catch {
    return [];
  }
}
