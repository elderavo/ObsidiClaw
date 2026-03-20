"use strict";
/**
 * ContextEngine — the retrieval heart of ObsidiClaw.
 *
 * Responsibilities:
 * 1. initialize(): configure Ollama embeddings, open/sync SQLite graph,
 *    build VectorStoreIndex from graph notes
 * 2. build(prompt): hybrid retrieval (vector seeds + graph expansion),
 *    package results into a ContextPackage for pi session injection
 *
 * The orchestrator calls this in the `context_inject` lifecycle stage, before
 * creating the pi agent session. The returned ContextPackage is injected into
 * the session via agentsFilesOverride, becoming part of the agent's system context.
 *
 * TODO: Phase 6 — tool execution: orchestrator runs suggestedTools and their
 *   outputs are appended to formattedContext before the agent sees it
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextEngine = void 0;
var fs_1 = require("fs");
var path_1 = require("path");
var llamaindex_1 = require("llamaindex");
var ollama_1 = require("@llamaindex/ollama");
var indexer_js_1 = require("./indexer.js");
var hybrid_js_1 = require("./retrieval/hybrid.js");
var sqlite_graph_js_1 = require("./store/sqlite_graph.js");
var DEFAULT_OLLAMA_HOST = (_a = process.env["OLLAMA_HOST"]) !== null && _a !== void 0 ? _a : "10.0.132.100";
var DEFAULT_EMBED_MODEL = (_b = process.env["OLLAMA_EMBED_MODEL"]) !== null && _b !== void 0 ? _b : "nomic-embed-text:v1.5";
var DEFAULT_TOP_K = 5;
var ContextEngine = /** @class */ (function () {
    function ContextEngine(config) {
        var _a, _b, _c, _d;
        this.vectorIndex = null;
        this.graphStore = null;
        var mdDbPath = config.mdDbPath;
        var defaultDbPath = (0, path_1.join)((0, path_1.dirname)(mdDbPath), ".obsidi-claw", "graph.db");
        this.config = {
            mdDbPath: mdDbPath,
            dbPath: (_a = config.dbPath) !== null && _a !== void 0 ? _a : defaultDbPath,
            ollamaHost: (_b = config.ollamaHost) !== null && _b !== void 0 ? _b : DEFAULT_OLLAMA_HOST,
            embeddingModel: (_c = config.embeddingModel) !== null && _c !== void 0 ? _c : DEFAULT_EMBED_MODEL,
            topK: (_d = config.topK) !== null && _d !== void 0 ? _d : DEFAULT_TOP_K,
        };
    }
    /**
     * Must be called before build(). Idempotent — safe to call multiple times.
     *
     * 1. Configures LlamaIndex embedding model (Ollama)
     * 2. Opens the SQLite graph store (creates .obsidi-claw/ dir if needed)
     * 3. Syncs md_db markdown files into the graph (two-pass: notes, then edges)
     * 4. Builds in-memory VectorStoreIndex from graph notes
     */
    ContextEngine.prototype.initialize = function () {
        return __awaiter(this, void 0, void 0, function () {
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (this.vectorIndex)
                            return [2 /*return*/];
                        // Ensure .obsidi-claw/ directory exists
                        (0, fs_1.mkdirSync)((0, path_1.dirname)(this.config.dbPath), { recursive: true });
                        // Configure LlamaIndex embeddings
                        llamaindex_1.Settings.embedModel = new ollama_1.OllamaEmbedding({
                            model: this.config.embeddingModel,
                            config: { host: this.config.ollamaHost },
                        });
                        console.log("[context_engine] Initializing \u2014 mdDb: ".concat(this.config.mdDbPath, ", ") +
                            "db: ".concat(this.config.dbPath, ", ") +
                            "embed: ".concat(this.config.embeddingModel, " @ ").concat(this.config.ollamaHost));
                        // Open graph store
                        this.graphStore = new sqlite_graph_js_1.SqliteGraphStore(this.config.dbPath);
                        // Sync md_db → graph (parse + upsert notes, then resolve wikilinks)
                        return [4 /*yield*/, (0, indexer_js_1.syncMdDbToGraph)(this.config.mdDbPath, this.graphStore)];
                    case 1:
                        // Sync md_db → graph (parse + upsert notes, then resolve wikilinks)
                        _b.sent();
                        // Build vector index from graph notes
                        _a = this;
                        return [4 /*yield*/, (0, indexer_js_1.buildVectorIndexFromGraph)(this.graphStore)];
                    case 2:
                        // Build vector index from graph notes
                        _a.vectorIndex = _b.sent();
                        console.log("[context_engine] Ready");
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Build a ContextPackage for the given prompt.
     * Runs hybrid retrieval: vector seeds + graph-expanded neighbors.
     *
     * Throws if initialize() has not been called.
     */
    ContextEngine.prototype.build = function (prompt) {
        return __awaiter(this, void 0, void 0, function () {
            var t0, _a, seedNotes, expandedNotes, allNotes, suggestedTools, formattedContext, retrievalMs;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!this.vectorIndex || !this.graphStore) {
                            throw new Error("ContextEngine not initialized. Call initialize() first.");
                        }
                        t0 = Date.now();
                        return [4 /*yield*/, (0, hybrid_js_1.hybridRetrieve)(prompt, this.vectorIndex, this.graphStore, this.config.topK)];
                    case 1:
                        _a = _b.sent(), seedNotes = _a.seedNotes, expandedNotes = _a.expandedNotes;
                        allNotes = __spreadArray(__spreadArray([], seedNotes, true), expandedNotes, true).sort(function (a, b) { return b.score - a.score; });
                        suggestedTools = allNotes
                            .filter(function (n) { return n.type === "tool" && n.toolId !== undefined; })
                            .map(function (n) { return n.toolId; });
                        formattedContext = formatContext(seedNotes, expandedNotes);
                        retrievalMs = Date.now() - t0;
                        return [2 /*return*/, {
                                query: prompt,
                                retrievedNotes: allNotes,
                                suggestedTools: suggestedTools,
                                formattedContext: formattedContext,
                                retrievalMs: retrievalMs,
                                builtAt: Date.now(),
                                seedNoteIds: seedNotes.map(function (n) { return n.noteId; }),
                                expandedNoteIds: expandedNotes.map(function (n) { return n.noteId; }),
                            }];
                }
            });
        });
    };
    /**
     * Close the underlying SQLite database.
     * Call when the context engine is no longer needed.
     */
    ContextEngine.prototype.close = function () {
        var _a;
        (_a = this.graphStore) === null || _a === void 0 ? void 0 : _a.close();
        this.graphStore = null;
        this.vectorIndex = null;
    };
    return ContextEngine;
}());
exports.ContextEngine = ContextEngine;
// ---------------------------------------------------------------------------
// Context formatting
// ---------------------------------------------------------------------------
/**
 * Format retrieved notes into a markdown block for injection into the pi
 * agent's context via agentsFilesOverride.
 *
 * Structure:
 *   ## Seed Notes        — direct vector matches (depth 0)
 *   ## Linked Notes      — graph-expanded neighbors (depth >= 1)
 *   ## Suggested Tools   — tool nodes from either tier
 */
function formatContext(seedNotes, expandedNotes) {
    var allNotes = __spreadArray(__spreadArray([], seedNotes, true), expandedNotes, true);
    if (allNotes.length === 0) {
        return "<!-- ObsidiClaw: no relevant knowledge base context found for this query -->";
    }
    var lines = [
        "<!-- ObsidiClaw Knowledge Base Context -->",
        "",
        "# Knowledge Base Context",
        "",
    ];
    // Seed notes (non-tool)
    var seedConcepts = seedNotes.filter(function (n) { return n.type !== "tool"; });
    if (seedConcepts.length > 0) {
        lines.push("## Seed Notes");
        lines.push("_Directly relevant notes retrieved by semantic similarity._");
        lines.push("");
        for (var _i = 0, seedConcepts_1 = seedConcepts; _i < seedConcepts_1.length; _i++) {
            var note = seedConcepts_1[_i];
            lines.push("### ".concat(note.path, " (score: ").concat(note.score.toFixed(3), ")"));
            lines.push(note.content.trim());
            lines.push("");
        }
    }
    // Graph-expanded notes (non-tool)
    var expandedConcepts = expandedNotes.filter(function (n) { return n.type !== "tool"; });
    if (expandedConcepts.length > 0) {
        lines.push("## Linked Supporting Notes");
        lines.push("_Notes linked to seed notes via [[wikilinks]]._");
        lines.push("");
        for (var _a = 0, expandedConcepts_1 = expandedConcepts; _a < expandedConcepts_1.length; _a++) {
            var note = expandedConcepts_1[_a];
            var linkedFromPart = note.linkedFrom && note.linkedFrom.length > 0
                ? " | Linked from: ".concat(note.linkedFrom.join(", "))
                : "";
            lines.push("### ".concat(note.path, " (score: ").concat(note.score.toFixed(3)).concat(linkedFromPart, ")"));
            lines.push(note.content.trim());
            lines.push("");
        }
    }
    // Tool nodes (both tiers)
    var toolNotes = allNotes.filter(function (n) { return n.type === "tool"; });
    if (toolNotes.length > 0) {
        lines.push("## Suggested Tools");
        lines.push("_Tool nodes from the knowledge base. Tool outputs will be injected in Phase 6._");
        lines.push("");
        for (var _b = 0, toolNotes_1 = toolNotes; _b < toolNotes_1.length; _b++) {
            var note = toolNotes_1[_b];
            lines.push("### Tool: ".concat(note.toolId, " (").concat(note.path, ")"));
            lines.push(note.content.trim());
            lines.push("");
        }
    }
    lines.push("<!-- End ObsidiClaw Context -->");
    return lines.join("\n");
}
