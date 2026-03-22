import { join } from "path";
import { ensureDir, listDir, readText, writeText } from "../shared/os/fs.js";
export function getSpecDir(rootDir) {
    return join(rootDir, ".obsidi-claw", "scheduled");
}
export function getSpecPath(rootDir, name) {
    return join(getSpecDir(rootDir), `${name}.json`);
}
export function writeTaskSpec(rootDir, spec) {
    const dir = getSpecDir(rootDir);
    ensureDir(dir);
    const path = getSpecPath(rootDir, spec.name);
    writeText(path, JSON.stringify(spec, null, 2));
    return path;
}
export function listTaskSpecs(rootDir) {
    const dir = getSpecDir(rootDir);
    try {
        const files = listDir(dir).filter((f) => f.endsWith(".json"));
        return files.map((f) => JSON.parse(readText(join(dir, f))));
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=persistent-tasks.js.map