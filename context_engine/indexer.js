"use strict";
/**
 * Indexer — syncs md_db to the SQLite graph store and builds a LlamaIndex
 * VectorStoreIndex from the stored notes.
 *
 * Two-pass sync (required for foreign-key safe edge insertion):
 *   Pass 1 — parse + upsert all notes into the notes table
 *   Pass 2 — resolve [[wikilinks]] and insert edges
 *
 * buildVectorIndexFromGraph reads notes directly from SQLite so the vector
 * index is always consistent with the graph.
 *
 * TODO: Phase 5 — persist index to disk to avoid re-embedding every startup
 * TODO: Phase 5 — watch md_db for changes and incrementally update
 * TODO: Phase 8 — re-index after insight_engine writes new notes
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncMdDbToGraph = syncMdDbToGraph;
exports.buildVectorIndexFromGraph = buildVectorIndexFromGraph;
var promises_1 = require("fs/promises");
var path_1 = require("path");
var llamaindex_1 = require("llamaindex");
var parser_js_1 = require("./ingest/parser.js");
// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------
function collectMarkdownFiles(dir) {
    return __awaiter(this, void 0, void 0, function () {
        var entries, paths, _i, entries_1, entry, fullPath, _a, _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0: return [4 /*yield*/, (0, promises_1.readdir)(dir, { withFileTypes: true })];
                case 1:
                    entries = _d.sent();
                    paths = [];
                    _i = 0, entries_1 = entries;
                    _d.label = 2;
                case 2:
                    if (!(_i < entries_1.length)) return [3 /*break*/, 6];
                    entry = entries_1[_i];
                    fullPath = (0, path_1.join)(dir, entry.name);
                    if (!entry.isDirectory()) return [3 /*break*/, 4];
                    _b = (_a = paths.push).apply;
                    _c = [paths];
                    return [4 /*yield*/, collectMarkdownFiles(fullPath)];
                case 3:
                    _b.apply(_a, _c.concat([(_d.sent())]));
                    return [3 /*break*/, 5];
                case 4:
                    if (entry.isFile() && (0, path_1.extname)(entry.name) === ".md") {
                        paths.push(fullPath);
                    }
                    _d.label = 5;
                case 5:
                    _i++;
                    return [3 /*break*/, 2];
                case 6: return [2 /*return*/, paths];
            }
        });
    });
}
// ---------------------------------------------------------------------------
// Two-pass graph sync
// ---------------------------------------------------------------------------
/**
 * Parse all .md files from mdDbPath and sync them into the graph store.
 *
 * Pass 1: upsert every note (notes table must be complete before edges).
 * Pass 2: resolve [[wikilinks]] and replace edges for each note.
 *
 * Unresolved links (notes not in the db) are silently dropped —
 * SqliteGraphStore.replaceEdges filters them out.
 */
function syncMdDbToGraph(mdDbPath, graphStore) {
    return __awaiter(this, void 0, void 0, function () {
        var filePaths, parsedNotes, _i, parsedNotes_1, note, _a, parsedNotes_2, note, resolvedIds, _b, _c, linkText, dstId, totalLinks;
        var _this = this;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0: return [4 /*yield*/, collectMarkdownFiles(mdDbPath)];
                case 1:
                    filePaths = _d.sent();
                    if (filePaths.length === 0) {
                        console.warn("[indexer] No .md files found in ".concat(mdDbPath));
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, Promise.all(filePaths.map(function (fullPath) { return __awaiter(_this, void 0, void 0, function () {
                            var content, relativePath;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0: return [4 /*yield*/, (0, promises_1.readFile)(fullPath, "utf-8")];
                                    case 1:
                                        content = _a.sent();
                                        relativePath = (0, path_1.relative)(mdDbPath, fullPath).replace(/\\/g, "/");
                                        return [2 /*return*/, (0, parser_js_1.parseMarkdownFile)(content, relativePath)];
                                }
                            });
                        }); }))];
                case 2:
                    parsedNotes = _d.sent();
                    for (_i = 0, parsedNotes_1 = parsedNotes; _i < parsedNotes_1.length; _i++) {
                        note = parsedNotes_1[_i];
                        graphStore.upsertNote(note);
                    }
                    console.log("[indexer] Upserted ".concat(parsedNotes.length, " notes into graph"));
                    // Pass 2 — resolve wikilinks + insert edges
                    for (_a = 0, parsedNotes_2 = parsedNotes; _a < parsedNotes_2.length; _a++) {
                        note = parsedNotes_2[_a];
                        resolvedIds = [];
                        for (_b = 0, _c = note.linksOut; _b < _c.length; _b++) {
                            linkText = _c[_b];
                            dstId = graphStore.resolveLink(linkText);
                            if (dstId !== null) {
                                resolvedIds.push(dstId);
                            }
                        }
                        graphStore.replaceEdges(note.noteId, resolvedIds);
                    }
                    totalLinks = parsedNotes.reduce(function (sum, n) { return sum + n.linksOut.length; }, 0);
                    console.log("[indexer] Resolved edges (".concat(totalLinks, " raw links \u2192 graph)"));
                    return [2 /*return*/];
            }
        });
    });
}
// ---------------------------------------------------------------------------
// Vector index from graph
// ---------------------------------------------------------------------------
/**
 * Build a LlamaIndex VectorStoreIndex from notes already in the graph store.
 * Requires Settings.embedModel to be configured before calling.
 *
 * Uses the stored body (frontmatter stripped) as document text.
 * Metadata includes file_path (= noteId) and note_type for downstream filtering.
 */
function buildVectorIndexFromGraph(graphStore) {
    return __awaiter(this, void 0, void 0, function () {
        var notes, docs;
        return __generator(this, function (_a) {
            notes = graphStore.listAllNotes();
            docs = notes.length === 0
                ? [
                    new llamaindex_1.Document({
                        text: "(empty knowledge base)",
                        metadata: { file_path: "index.md", note_type: "index" },
                    }),
                ]
                : notes.map(function (n) {
                    var _a;
                    return new llamaindex_1.Document({
                        text: n.body,
                        metadata: {
                            file_path: n.path,
                            note_type: n.note_type,
                            tool_id: (_a = n.tool_id) !== null && _a !== void 0 ? _a : "",
                        },
                    });
                });
            console.log("[indexer] Building vector index over ".concat(docs.length, " notes"));
            return [2 /*return*/, llamaindex_1.VectorStoreIndex.fromDocuments(docs)];
        });
    });
}
