/**
 * Codebase Indexer Extension for Pi
 * 
 * Indexes the entire parent directory (excluding node_modules, .git, etc.)
 * into the same SQLite graph used by the context engine. This allows
 * retrieve_context to search both curated knowledge AND raw codebase.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readdir, readFile } from "fs/promises";
import { join, relative, extname, basename } from "path";
import { SqliteGraphStore } from "../../context_engine/store/sqlite_graph.js";
import type { ParsedNote } from "../../context_engine/ingest/models.js";
import { Document } from "llamaindex";

interface CodeFile {
  path: string;
  content: string;
  language: string;
  size: number;
}

// File extensions to index and their languages
const SUPPORTED_EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript',
  '.js': 'javascript', 
  '.tsx': 'typescript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.java': 'java',
  '.cpp': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.hpp': 'cpp',
  '.rs': 'rust',
  '.go': 'go',
  '.php': 'php',
  '.rb': 'ruby',
  '.cs': 'csharp',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.scala': 'scala',
  '.sql': 'sql',
  '.sh': 'bash',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.xml': 'xml',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.md': 'markdown'
};

// Directories and files to exclude
const EXCLUDE_PATTERNS = [
  '.git', 
  '.svn',
  '.hg',
  'dist',
  'build',
  'target',
  'out',
  'bin',
  '.next',
  '.nuxt',
  '.vscode',
  '.idea',
  'coverage',
  '.nyc_output',
  '__pycache__',
  '.pytest_cache',
  'vendor',
  '.obsidi-claw'  // Don't index our own database
];

const EXCLUDE_FILES = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.DS_Store',
  'Thumbs.db',
  '*.log',
  '*.tmp'
];

// Max file size to index (1MB)
const MAX_FILE_SIZE = 1024 * 1024;

export default function codebaseIndexerExtension(pi: ExtensionAPI) {
  
  pi.registerTool({
    name: "index_codebase",
    label: "Index Codebase", 
    description: "Index all code files in the current directory for semantic search. " +
      "This allows retrieve_context to search both knowledge base AND codebase.",
    promptSnippet: "index_codebase() — index current directory for semantic search",
    promptGuidelines: [
      "Run this once per session to enable codebase search via retrieve_context",
      "Automatically excludes node_modules, .git, build outputs, etc.",
      "Large files (>1MB) are skipped to avoid embedding issues"
    ],
    parameters: Type.Object({
      max_files: Type.Optional(Type.Number({
        description: "Maximum number of files to index (default: 500)",
        minimum: 1,
        maximum: 2000
      })),
      include_large_files: Type.Optional(Type.Boolean({
        description: "Include files larger than 1MB (default: false)"
      }))
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const maxFiles = params.max_files || 500;
        const includeLarge = params.include_large_files || false;
        
        ctx?.ui?.setWorkingMessage?.("Scanning codebase for indexable files...");
        
        const startTime = Date.now();
        const rootDir = process.cwd();
        
        // Collect all eligible files
        const codeFiles = await collectCodeFiles(rootDir, includeLarge);
        
        if (codeFiles.length === 0) {
          return {
            content: [{ 
              type: "text" as const, 
              text: "No indexable code files found in current directory." 
            }],
            details: { filesScanned: 0, filesIndexed: 0 }
          };
        }

        // Limit file count if needed
        const filesToIndex = codeFiles.slice(0, maxFiles);
        if (codeFiles.length > maxFiles) {
          ctx?.ui?.notify?.(`Limited to ${maxFiles} files out of ${codeFiles.length} found`, "info");
        }

        ctx?.ui?.setWorkingMessage?.(`Indexing ${filesToIndex.length} code files...`);

        // Convert to Documents for LlamaIndex
        const documents: Document[] = [];
        for (const file of filesToIndex) {
          const doc = new Document({
            text: file.content,
            metadata: {
              file_path: file.path,
              note_type: "codebase",
              language: file.language,
              file_size: file.size,
              indexed_at: new Date().toISOString()
            }
          });
          documents.push(doc);
        }

        // Add files directly to the context engine's SQLite graph
        const dbPath = join(process.cwd(), ".obsidi-claw", "graph.db");
        const graphStore = new SqliteGraphStore(dbPath);
        
        let addedCount = 0;
        for (const file of filesToIndex) {
          try {
            const note: ParsedNote = {
              noteId: file.path,
              path: file.path,
              title: basename(file.path),
              noteType: "codebase",
              body: file.content,
              frontmatter: {
                language: file.language,
                file_size: file.size,
                indexed_at: new Date().toISOString()
              },
              linksOut: [], // Code files don't have wikilinks
              toolId: undefined,
              timeCreated: undefined,
              lastEdited: undefined
            };
            
            graphStore.upsertNote(note);
            addedCount++;
          } catch (err) {
            console.warn(`Failed to index ${file.path}:`, err);
          }
        }
        
        graphStore.close();
        const indexTime = Date.now() - startTime;
        
        ctx?.ui?.setWorkingMessage?.();
        
        const summary = `## Codebase Indexing Complete

**Files found:** ${codeFiles.length}
**Files indexed:** ${addedCount} / ${filesToIndex.length} processed  
**Time taken:** ${indexTime}ms
**Languages detected:** ${[...new Set(filesToIndex.map(f => f.language))].join(', ')}
**Total size:** ${Math.round(filesToIndex.reduce((sum, f) => sum + f.size, 0) / 1024)}KB

The codebase is now indexed and searchable via \`retrieve_context\`. You can search for:
- Function names and implementations
- Code patterns and architectures  
- File contents and structures
- Cross-file dependencies

Example: \`retrieve_context("authentication middleware implementation")\`

**Note:** Vector index will rebuild automatically on next \`retrieve_context\` call.
`;

        return {
          content: [{ type: "text" as const, text: summary }],
          details: { 
            filesScanned: codeFiles.length,
            filesProcessed: filesToIndex.length,
            filesIndexed: addedCount,
            indexTimeMs: indexTime,
            languages: [...new Set(filesToIndex.map(f => f.language))]
          }
        };
        
      } catch (error) {
        ctx?.ui?.setWorkingMessage?.();
        
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ 
            type: "text" as const, 
            text: `Error indexing codebase: ${errorMessage}` 
          }],
          details: { 
            error: errorMessage
          }
        };
      }
    }
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify("Codebase indexer available. Run index_codebase() to enable code search.", "info");
  });
}

// Helper functions

async function collectCodeFiles(rootDir: string, includeLarge: boolean): Promise<CodeFile[]> {
  const files: CodeFile[] = [];
  
  async function scanDirectory(dirPath: string): Promise<void> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);
        const relativePath = relative(rootDir, fullPath).replace(/\\/g, '/');
        
        if (entry.isDirectory()) {
          // Skip excluded directories
          if (EXCLUDE_PATTERNS.some(pattern => 
            entry.name === pattern || 
            relativePath.includes(`/${pattern}/`) ||
            relativePath.startsWith(`${pattern}/`)
          )) {
            continue;
          }
          
          await scanDirectory(fullPath);
        } else if (entry.isFile()) {
          // Check if file should be indexed
          const ext = extname(entry.name).toLowerCase();
          const language = SUPPORTED_EXTENSIONS[ext];
          
          if (!language) continue;
          
          // Skip excluded files  
          if (EXCLUDE_FILES.some(pattern => 
            entry.name === pattern || 
            entry.name.match(pattern.replace('*', '.*'))
          )) {
            continue;
          }
          
          try {
            const content = await readFile(fullPath, 'utf-8');
            const size = Buffer.byteLength(content, 'utf-8');
            
            // Skip large files unless explicitly requested
            if (!includeLarge && size > MAX_FILE_SIZE) {
              continue;
            }
            
            files.push({
              path: relativePath,
              content,
              language,
              size
            });
          } catch (err) {
            // Skip files that can't be read (permissions, binary files, etc.)
            continue;
          }
        }
      }
    } catch (err) {
      // Skip directories that can't be read
      return;
    }
  }
  
  await scanDirectory(rootDir);
  return files;
}