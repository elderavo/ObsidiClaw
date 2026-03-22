#!/usr/bin/env npx tsx
/**
 * mirror-codebase-py.ts
 *
 * Python variant of mirror-codebase.ts — generates a "code mirror" markdown
 * note for every Python (.py) file found under the scan directory.
 *
 * Extracts from each .py file (line-based scanner, no external dependency):
 *   - Imports: `import X` and `from X import Y, Z`
 *   - Classes: plain and @dataclass-decorated
 *   - Functions/methods: def / async def with full signatures
 *     - @staticmethod: self/cls not stripped
 *     - @classmethod / regular methods: cls/self stripped from params
 *     - Multiline signatures supported
 *   - In-repo calls: name-based matching against exported symbols
 *   - Call-ins: inverse of above
 *
 * Call graph analysis is NAME-BASED.
 * TODO: name-based matching can produce false positives if two different in-repo
 * files export a function with the same name. A future version could use
 * Python's ast module (via subprocess) to resolve call targets unambiguously.
 *
 * All structural info is placed in the NOTE BODY, not frontmatter, because
 * ObsidianReader strips frontmatter from embedded text — agents only see body
 * during RAG retrieval. Wikilinks in the body become graph edges.
 *
 * Usage:
 *   npx tsx scripts/mirror-codebase-py.ts [options]
 *
 * Options:
 *   --scan-dir <path>    Root directory to scan (default: cwd)
 *   --mirror-dir <path>  Output directory (default: <cwd>/md_db/code)
 *   --omit <glob,...>    Comma-separated patterns to exclude
 *                        (default: __pycache__,*.pyi,.venv,env,venv,dist)
 *   --force              Regenerate all files even if mirror is up-to-date
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Types (same shape as mirror-codebase.ts for consistency)
// ---------------------------------------------------------------------------

interface CliArgs {
  scanDir: string;
  mirrorDir: string;
  omitPatterns: string[];
  force: boolean;
}

interface ImportInfo {
  specifier: string;       // e.g. ".models" or "llama_index.core"
  isInternal: boolean;     // true if starts with '.'
  bindings: string[];      // named imports
}

interface ExportInfo {
  name: string;
  kind: "function" | "class" | "const" | "type" | "interface" | "enum" | "reexport";
  signature?: string;
}

interface FunctionInfo {
  name: string;
  signature: string;       // e.g. "ClassName.method(param: T) -> R"
  isExported: boolean;     // true for top-level non-underscore defs
  isAsync: boolean;
  isMethod: boolean;
  className?: string;
  bodyStart: number;       // char offset — used for per-function call attribution
  bodyEnd: number;
}

interface ParsedFunction extends FunctionInfo {
  indent: number;          // indentation level of the def line (for bodyEnd refinement)
}

interface CallSite {
  name: string;
  position: number;
}

interface InRepoCall {
  calleeName: string;
  sourceFile: string;
  position: number;
}

interface CallIn {
  callerFile: string;
  calledName: string;
}

interface FileData {
  absolutePath: string;
  relativePath: string;
  mirrorPath: string;
  imports: ImportInfo[];
  exports: ExportInfo[];
  functions: FunctionInfo[];
  callSites: CallSite[];
  inRepoCalls: InRepoCall[];
  callIns: CallIn[];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const cwd = process.cwd();
  let scanDir = cwd;
  let mirrorDir = path.join(cwd, "md_db", "code");
  let omitPatterns = ["__pycache__", "*.pyi", ".venv", "env", "venv", "dist"];
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--scan-dir" && args[i + 1]) {
      scanDir = path.resolve(args[++i]);
    } else if (arg === "--mirror-dir" && args[i + 1]) {
      mirrorDir = path.resolve(args[++i]);
    } else if (arg === "--omit" && args[i + 1]) {
      omitPatterns = args[++i].split(",").map((s) => s.trim());
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npx tsx scripts/mirror-codebase-py.ts [options]

Options:
  --scan-dir <path>    Root directory to scan (default: cwd)
  --mirror-dir <path>  Output directory (default: md_db/code)
  --omit <globs>       Comma-separated patterns to exclude
                       (default: __pycache__,*.pyi,.venv,env,venv,dist)
  --force              Regenerate all files even if mirror is up-to-date
  --help               Show this help`);
      process.exit(0);
    }
  }

  return { scanDir, mirrorDir, omitPatterns, force };
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Derive the mirror file stem for a source path.
 * For `__init__.py` files the stem would collide across directories, so we use
 * `{parentDirName}-init` instead (e.g. `knowledge_graph/__init__.py` → stem
 * `knowledge_graph-init`). Same treatment for `index.py` → `{parent}-index`.
 */
function mirrorStem(relPath: string): string {
  const stem = path.posix.basename(relPath).replace(/\.py$/, "");
  if (stem === "__init__" || stem === "index") {
    const parentDir = path.posix.dirname(relPath);
    const parent = parentDir === "." ? "" : path.posix.basename(parentDir);
    const suffix = stem === "__init__" ? "init" : "index";
    return parent ? `${parent}-${suffix}` : `root-${suffix}`;
  }
  return stem;
}

function shouldOmit(relPath: string, patterns: string[]): boolean {
  const parts = relPath.split("/");
  for (const pattern of patterns) {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      if (relPath.endsWith(suffix)) return true;
    } else {
      if (parts.some((p) => p === pattern)) return true;
    }
  }
  return false;
}

function collectFiles(
  scanDir: string,
  mirrorDir: string,
  omitPatterns: string[]
): { absolutePath: string; relativePath: string; mirrorPath: string }[] {
  const results: { absolutePath: string; relativePath: string; mirrorPath: string }[] = [];

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relPath = path.relative(scanDir, absPath).replace(/\\/g, "/");
      if (shouldOmit(relPath, omitPatterns)) continue;

      if (entry.isDirectory()) {
        walk(absPath);
      } else if (entry.isFile() && entry.name.endsWith(".py")) {
        const mirrorRel = path.posix.join(path.posix.dirname(relPath), mirrorStem(relPath) + ".md");
        const mirrorPath = path.join(mirrorDir, mirrorRel);
        results.push({ absolutePath: absPath, relativePath: relPath, mirrorPath });
      }
    }
  }

  walk(scanDir);
  return results;
}

// ---------------------------------------------------------------------------
// Python keywords + builtins — excluded from call-site extraction
// ---------------------------------------------------------------------------

const PY_KEYWORDS = new Set([
  // Language keywords
  "False", "None", "True", "and", "as", "assert", "async", "await",
  "break", "class", "continue", "def", "del", "elif", "else", "except",
  "finally", "for", "from", "global", "if", "import", "in", "is",
  "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
  "while", "with", "yield",
  // Common builtins
  "print", "len", "range", "list", "dict", "set", "tuple", "str", "int",
  "float", "bool", "bytes", "type", "isinstance", "issubclass", "hasattr",
  "getattr", "setattr", "delattr", "callable", "iter", "next", "enumerate",
  "zip", "map", "filter", "sorted", "reversed", "sum", "min", "max", "abs",
  "round", "open", "input", "repr", "hash", "id", "dir", "vars", "locals",
  "globals", "super", "object", "property", "staticmethod", "classmethod",
  "dataclass", "field", "asdict", "Optional", "Any", "List", "Dict", "Set",
  "Tuple", "Union", "Literal", "Callable", "Type", "ClassVar",
]);

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

function extractImports(source: string): ImportInfo[] {
  const imports: ImportInfo[] = [];

  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // import X  or  import X as Y  or  import X.Y
    const importMatch = trimmed.match(/^import\s+(\S+?)(?:\s+as\s+\w+)?\s*(?:#.*)?$/);
    if (importMatch) {
      imports.push({ specifier: importMatch[1], isInternal: false, bindings: [] });
      continue;
    }

    // from X import A, B  or  from X import (A, B)  or  from X import *
    const fromMatch = trimmed.match(/^from\s+(\S+)\s+import\s+(.+)/);
    if (fromMatch) {
      const specifier = fromMatch[1];
      const isInternal = specifier.startsWith(".");
      const raw = fromMatch[2].replace(/[()\\]/g, "").replace(/#.*$/, "").trim();
      const bindings =
        raw === "*"
          ? ["*"]
          : raw
              .split(",")
              .map((b) => {
                // "A as alias" → use alias
                const parts = b.trim().split(/\s+as\s+/);
                return parts[parts.length - 1].trim();
              })
              .filter(Boolean);
      imports.push({ specifier, isInternal, bindings });
    }
  }

  return imports;
}

// ---------------------------------------------------------------------------
// Class / function / method extraction
// ---------------------------------------------------------------------------

function extractDefinitions(source: string): {
  exports: ExportInfo[];
  functions: FunctionInfo[];
} {
  const lines = source.split("\n");
  const functions: ParsedFunction[] = [];
  const exports: ExportInfo[] = [];

  // Explicit __all__ restricts which names are considered exported
  const allMatch = source.match(/__all__\s*=\s*\[([^\]]*)\]/s);
  const explicitExports: Set<string> | null = allMatch
    ? new Set(
        allMatch[1]
          .split(",")
          .map((s) => s.trim().replace(/['"]/g, ""))
          .filter(Boolean)
      )
    : null;

  // Pending decorator names (e.g. "staticmethod", "dataclass") collected from @ lines
  let pendingDecorators: string[] = [];

  // Current class context — single-level tracking
  let currentClass: { name: string; indent: number } | null = null;

  let charOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLen = line.length;
    const trimmed = line.trimStart();
    const indent = lineLen - trimmed.length;

    if (!trimmed || trimmed.startsWith("#")) {
      charOffset += lineLen + 1;
      continue;
    }

    // Clear class context when we encounter a statement at the same or lower
    // indent, unless it's a decorator, def, class, or comment
    if (
      currentClass !== null &&
      indent <= currentClass.indent &&
      !trimmed.startsWith("@") &&
      !trimmed.startsWith("def ") &&
      !trimmed.startsWith("async def ") &&
      !trimmed.startsWith("class ")
    ) {
      currentClass = null;
    }

    // Decorator line — capture the bare name (no args, no @)
    if (trimmed.startsWith("@")) {
      const decoratorName = trimmed.slice(1).split("(")[0].trim();
      pendingDecorators.push(decoratorName);
      charOffset += lineLen + 1;
      continue;
    }

    // Class definition
    const classMatch = trimmed.match(/^class\s+(\w+)(?:\s*\(([^)]*)\))?\s*:/);
    if (classMatch) {
      const name = classMatch[1];
      if (indent === 0) {
        currentClass = { name, indent: 0 };
        if (!explicitExports || explicitExports.has(name)) {
          exports.push({ name, kind: "class" });
        }
      }
      pendingDecorators = [];
      charOffset += lineLen + 1;
      continue;
    }

    // Function / method definition
    const defMatch = trimmed.match(/^(async\s+)?def\s+(\w+)\s*\(/);
    if (defMatch) {
      const isAsync = !!(defMatch[1]?.trim());
      const name = defMatch[2];
      const isStatic = pendingDecorators.includes("staticmethod");
      pendingDecorators = [];

      // Collect full signature — may span multiple lines if params are multiline
      // Count unbalanced open parens to know when signature ends
      let sigLines = [line];
      let openParens =
        (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
      let j = i + 1;
      while (openParens > 0 && j < lines.length) {
        const next = lines[j];
        sigLines.push(next);
        openParens +=
          (next.match(/\(/g) || []).length - (next.match(/\)/g) || []).length;
        j++;
      }

      // Parse the flattened signature
      const flatSig = sigLines.map((l) => l.trim()).join(" ");
      const sigMatch = flatSig.match(
        /^(?:async\s+)?def\s+\w+\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*(?:->\s*([^:]+?))?\s*:/
      );

      let paramStr = sigMatch ? sigMatch[1].trim() : "...";
      const returnType = sigMatch ? sigMatch[2]?.trim() : undefined;

      // Strip leading self/cls from method params (unless @staticmethod)
      const isMethod = indent > 0 && currentClass !== null;
      if (isMethod && !isStatic) {
        paramStr = paramStr.replace(/^(?:self|cls)\s*,?\s*/, "").trim();
      }

      const displayName =
        isMethod && currentClass ? `${currentClass.name}.${name}` : name;
      const sig = `${displayName}(${paramStr})${returnType ? ` -> ${returnType}` : ""}`;
      const isExported = indent === 0 && !name.startsWith("_");

      // Account for any multiline continuation lines consumed above
      let defLineStart = charOffset;
      if (j > i + 1) {
        for (let k = i + 1; k < j; k++) {
          charOffset += lines[k].length + 1;
        }
        i = j - 1; // outer for-loop will i++ to j
      }
      charOffset += lineLen + 1;

      functions.push({
        name,
        signature: sig,
        isExported,
        isAsync,
        isMethod,
        className: isMethod ? currentClass?.name : undefined,
        bodyStart: defLineStart,
        bodyEnd: defLineStart + lineLen, // refined after the loop
        indent,
      });

      if (isExported) {
        if (!explicitExports || explicitExports.has(name)) {
          exports.push({ name, kind: "function", signature: sig });
        }
      }

      continue;
    }

    pendingDecorators = [];
    charOffset += lineLen + 1;
  }

  // Refine bodyEnd: each function body ends where the next function/class
  // at same or shallower indent begins (or end of file for the last one)
  for (let i = 0; i < functions.length; i++) {
    let end = source.length;
    for (let j = i + 1; j < functions.length; j++) {
      if (functions[j].indent <= functions[i].indent) {
        end = functions[j].bodyStart;
        break;
      }
    }
    functions[i].bodyEnd = end;
  }

  return { exports, functions };
}

// ---------------------------------------------------------------------------
// Call-site extraction
// ---------------------------------------------------------------------------

function extractCallSites(source: string): CallSite[] {
  const sites: CallSite[] = [];
  const callRe = /\b([a-zA-Z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source)) !== null) {
    if (!PY_KEYWORDS.has(m[1])) {
      sites.push({ name: m[1], position: m.index });
    }
  }
  return sites;
}

// ---------------------------------------------------------------------------
// Pass 1: per-file extraction
// ---------------------------------------------------------------------------

function extractFileData(
  absolutePath: string,
  relativePath: string,
  mirrorPath: string
): FileData {
  const source = fs.readFileSync(absolutePath, "utf8");
  const { exports, functions } = extractDefinitions(source);
  return {
    absolutePath,
    relativePath,
    mirrorPath,
    imports: extractImports(source),
    exports,
    functions,
    callSites: extractCallSites(source),
    inRepoCalls: [],
    callIns: [],
  };
}

// ---------------------------------------------------------------------------
// Pass 2: cross-file call graph (name-based)
// ---------------------------------------------------------------------------

function buildCallGraph(files: FileData[]): void {
  // Build symbol map: exported name → files that export it.
  // TODO: name-based matching can produce false positives if two different
  // in-repo files export a function with the same name. A future version could
  // use Python's ast module (via subprocess) for unambiguous resolution.
  const symbolMap = new Map<string, FileData[]>();
  for (const file of files) {
    for (const exp of file.exports) {
      if (!symbolMap.has(exp.name)) symbolMap.set(exp.name, []);
      symbolMap.get(exp.name)!.push(file);
    }
  }

  for (const file of files) {
    for (const site of file.callSites) {
      const sources = symbolMap.get(site.name);
      if (!sources) continue;
      for (const src of sources) {
        if (src.relativePath === file.relativePath) continue;

        if (
          !file.inRepoCalls.some(
            (c) => c.calleeName === site.name && c.sourceFile === src.relativePath
          )
        ) {
          file.inRepoCalls.push({
            calleeName: site.name,
            sourceFile: src.relativePath,
            position: site.position,
          });
        }

        if (
          !src.callIns.some(
            (c) => c.callerFile === file.relativePath && c.calledName === site.name
          )
        ) {
          src.callIns.push({ callerFile: file.relativePath, calledName: site.name });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------

const MIRROR_PREFIX = "code";

/**
 * Convert a .py relative path to a wikilink target.
 * Uses mirrorStem() so __init__ and index files map to their renamed stems:
 *   "knowledge_graph/engine.py"    → "code/knowledge_graph/engine"
 *   "knowledge_graph/__init__.py"  → "code/knowledge_graph/knowledge_graph-init"
 */
function toWikiLink(relPath: string): string {
  const dir = path.posix.dirname(relPath);
  const stem = mirrorStem(relPath);
  return dir === "." ? `${MIRROR_PREFIX}/${stem}` : `${MIRROR_PREFIX}/${dir}/${stem}`;
}

/**
 * Resolve a Python relative import specifier to the matching FileData.
 * e.g. from "knowledge_graph/retriever.py", specifier ".models"
 *   → "knowledge_graph/models.py"
 */
function resolveInternal(
  fromRelPath: string,
  specifier: string,
  files: FileData[]
): FileData | null {
  if (!specifier.startsWith(".")) return null;

  const dotMatch = specifier.match(/^(\.+)/);
  const dots = dotMatch ? dotMatch[1].length : 1;
  const moduleName = specifier.slice(dots); // e.g. "models" from ".models"

  let baseDir = path.posix.dirname(fromRelPath);
  for (let i = 1; i < dots; i++) {
    baseDir = path.posix.dirname(baseDir);
  }

  if (!moduleName) {
    // "from . import X" — the package __init__
    const candidate = path.posix.join(baseDir, "__init__.py");
    return files.find((f) => f.relativePath === candidate) ?? null;
  }

  // e.g. ".models" → baseDir/models.py
  // e.g. ".sub.module" → baseDir/sub/module.py
  const modPath = moduleName.replace(/\./g, "/");
  const candidate = path.posix.join(baseDir, modPath) + ".py";
  const match = files.find((f) => f.relativePath === candidate);
  if (match) return match;

  // Also try as a package: baseDir/modPath/__init__.py
  const initCandidate = path.posix.join(baseDir, modPath, "__init__.py");
  return files.find((f) => f.relativePath === initCandidate) ?? null;
}

function generateMarkdown(file: FileData, allFiles: FileData[], today: string): string {
  const lines: string[] = [];
  const filename = path.basename(file.relativePath);

  // ── Frontmatter ───────────────────────────────────────────────────────────
  lines.push(
    "---",
    "note_type: codeUnit",
    "type: codeUnit",
    `path: ${file.relativePath}`,
    "language: py",
    "generated: true",
    `last_verified: ${today}`,
    "tags:",
    "  - codeUnit",
    "---",
    ""
  );

  // ── Title ─────────────────────────────────────────────────────────────────
  // For __init__ and index files the filename alone is meaningless — use the full path
  const title = (filename === "__init__.py" || filename === "index.py")
    ? file.relativePath
    : filename;
  lines.push(`# ${title}`, "");
  lines.push(`> \`${file.relativePath}\``, "");

  // ── Exports ───────────────────────────────────────────────────────────────
  if (file.exports.length) {
    lines.push("## Exports", "");
    for (const exp of file.exports) {
      const display = exp.signature ? `\`${exp.signature}\`` : `\`${exp.name}\``;
      lines.push(`- ${display} *(${exp.kind})*`);
    }
    lines.push("");
  }

  // ── Imports ───────────────────────────────────────────────────────────────
  const internalImports = file.imports.filter((i) => i.isInternal);
  const externalImports = file.imports.filter((i) => !i.isInternal);

  if (internalImports.length || externalImports.length) {
    lines.push("## Imports", "");

    if (internalImports.length) {
      lines.push("### Internal", "");
      for (const imp of internalImports) {
        const resolved = resolveInternal(file.relativePath, imp.specifier, allFiles);
        const linkTarget = resolved
          ? `[[${toWikiLink(resolved.relativePath)}]]`
          : `\`${imp.specifier}\``;
        const bindingStr = imp.bindings.length
          ? ` — \`${imp.bindings.join("`, `")}\``
          : "";
        lines.push(`- ${linkTarget}${bindingStr}`);
      }
      lines.push("");
    }

    if (externalImports.length) {
      lines.push("### External", "");
      for (const imp of externalImports) {
        const bindingStr = imp.bindings.length
          ? ` — \`${imp.bindings.join("`, `")}\``
          : "";
        lines.push(`- \`${imp.specifier}\`${bindingStr}`);
      }
      lines.push("");
    }
  }

  // ── Functions ─────────────────────────────────────────────────────────────
  if (file.functions.length) {
    lines.push("## Functions", "");
    for (const fn of file.functions) {
      const flags: string[] = [];
      if (fn.isAsync) flags.push("async");
      if (fn.isExported) flags.push("exported");
      if (fn.isMethod && fn.className) flags.push(`method of \`${fn.className}\``);
      const flagStr = flags.length ? ` *(${flags.join(", ")})*` : "";

      // Per-function in-repo calls by position range
      const ownCalls = file.inRepoCalls.filter(
        (c) => c.position >= fn.bodyStart && c.position <= fn.bodyEnd
      );

      lines.push(`### \`${fn.signature}\`${flagStr}`);
      if (ownCalls.length) {
        const bySource = new Map<string, string[]>();
        for (const c of ownCalls) {
          if (!bySource.has(c.sourceFile)) bySource.set(c.sourceFile, []);
          bySource.get(c.sourceFile)!.push(c.calleeName);
        }
        const callParts: string[] = [];
        for (const [srcFile, names] of bySource) {
          callParts.push(`[[${toWikiLink(srcFile)}]] (\`${names.join("`, `")}\`)`);
        }
        lines.push(`*Calls into: ${callParts.join(", ")}*`);
      }
      lines.push("");
    }
  }

  // ── In-Repo Calls (file-level summary) ────────────────────────────────────
  if (file.inRepoCalls.length) {
    lines.push("## In-Repo Calls", "");
    lines.push("Functions this file calls that are defined in other in-repo files:", "");
    const bySource = new Map<string, Set<string>>();
    for (const c of file.inRepoCalls) {
      if (!bySource.has(c.sourceFile)) bySource.set(c.sourceFile, new Set());
      bySource.get(c.sourceFile)!.add(c.calleeName);
    }
    for (const [srcFile, names] of bySource) {
      lines.push(`- [[${toWikiLink(srcFile)}]] — \`${[...names].join("`, `")}\``);
    }
    lines.push("");
  }

  // ── Call-Ins ──────────────────────────────────────────────────────────────
  if (file.callIns.length) {
    lines.push("## Call-Ins", "");
    lines.push("Other in-repo files that call exports from this file:", "");
    const byCaller = new Map<string, Set<string>>();
    for (const c of file.callIns) {
      if (!byCaller.has(c.callerFile)) byCaller.set(c.callerFile, new Set());
      byCaller.get(c.callerFile)!.add(c.calledName);
    }
    for (const [callerFile, names] of byCaller) {
      lines.push(`- [[${toWikiLink(callerFile)}]] — calls \`${[...names].join("`, `")}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API (used by mirror-watcher and CLI)
// ---------------------------------------------------------------------------

export interface MirrorPyOptions {
  scanDir: string;
  mirrorDir: string;
  omitPatterns: string[];
  force: boolean;
}

export async function runMirrorPy(
  opts: MirrorPyOptions,
): Promise<{ written: number; skipped: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const discovered = collectFiles(opts.scanDir, opts.mirrorDir, opts.omitPatterns);

  const files: FileData[] = [];
  let parseErrors = 0;
  for (const { absolutePath, relativePath, mirrorPath } of discovered) {
    try {
      files.push(extractFileData(absolutePath, relativePath, mirrorPath));
    } catch (err) {
      console.warn(`[mirror-py] WARN: failed to parse ${relativePath}: ${err}`);
      parseErrors++;
    }
  }

  buildCallGraph(files);

  let written = 0;
  let skipped = 0;
  for (const file of files) {
    if (!opts.force) {
      try {
        const srcStat = fs.statSync(file.absolutePath);
        const mirrorStat = fs.statSync(file.mirrorPath);
        if (mirrorStat.mtimeMs >= srcStat.mtimeMs) { skipped++; continue; }
      } catch { /* mirror doesn't exist yet — proceed */ }
    }
    const markdown = generateMarkdown(file, files, today);
    fs.mkdirSync(path.dirname(file.mirrorPath), { recursive: true });
    fs.writeFileSync(file.mirrorPath, markdown, "utf8");
    written++;
  }

  if (parseErrors > 0) console.warn(`[mirror-py] ${parseErrors} files failed to parse`);
  return { written, skipped };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  console.log(`Scan dir  : ${args.scanDir}`);
  console.log(`Mirror dir: ${args.mirrorDir}`);
  console.log(`Omitting  : ${args.omitPatterns.join(", ")}`);
  console.log(`Force     : ${args.force}\n`);
  const { written, skipped } = await runMirrorPy(args);
  console.log(`Done. Written: ${written}, Skipped (up-to-date): ${skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
