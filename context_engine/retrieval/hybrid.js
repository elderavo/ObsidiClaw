"use strict";
/**
 * Hybrid retrieval — combines LlamaIndex vector seeds with SQLite graph expansion.
 *
 * Pipeline:
 *   1. Vector retrieval: top-K notes by embedding similarity (LlamaIndex)
 *   2. Graph expansion: BFS depth-1 neighbors of seed notes (SqliteGraphStore)
 *   3. Neighbor scores: parentSeedScore × GRAPH_SCORE_DECAY
 *
 * Seed notes always take precedence; duplicate noteIds are not returned twice.
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
exports.hybridRetrieve = hybridRetrieve;
var llamaindex_1 = require("llamaindex");
var GRAPH_SCORE_DECAY = 0.7;
/**
 * Run hybrid retrieval for a query string.
 *
 * @param query       The user prompt / retrieval query.
 * @param vectorIndex LlamaIndex VectorStoreIndex (owns embeddings).
 * @param graphStore  SqliteGraphStore (owns wikilink graph).
 * @param topK        Number of vector seed notes to retrieve.
 */
function hybridRetrieve(query, vectorIndex, graphStore, topK) {
    return __awaiter(this, void 0, void 0, function () {
        var retriever, rawResults, seedNotes, seedScoreByNoteId, _i, rawResults_1, r, path, score, stored, seedIds, neighbors, storedNeighbors, storedByNoteId, expandedNotes, _a, neighbors_1, neighbor, stored, parentScore, score;
        var _b, _c, _d, _e, _f, _g;
        return __generator(this, function (_h) {
            switch (_h.label) {
                case 0:
                    retriever = vectorIndex.asRetriever({ similarityTopK: topK });
                    return [4 /*yield*/, retriever.retrieve(query)];
                case 1:
                    rawResults = _h.sent();
                    seedNotes = [];
                    seedScoreByNoteId = new Map();
                    for (_i = 0, rawResults_1 = rawResults; _i < rawResults_1.length; _i++) {
                        r = rawResults_1[_i];
                        path = String((_b = r.node.metadata["file_path"]) !== null && _b !== void 0 ? _b : "");
                        if (!path)
                            continue;
                        score = (_c = r.score) !== null && _c !== void 0 ? _c : 0;
                        stored = graphStore.getNoteByPath(path);
                        seedNotes.push({
                            noteId: path,
                            path: path,
                            content: r.node.getContent(llamaindex_1.MetadataMode.NONE),
                            score: score,
                            type: ((_d = stored === null || stored === void 0 ? void 0 : stored.note_type) !== null && _d !== void 0 ? _d : inferNoteType(path)),
                            toolId: (_e = stored === null || stored === void 0 ? void 0 : stored.tool_id) !== null && _e !== void 0 ? _e : undefined,
                            retrievalSource: "vector",
                            depth: 0,
                        });
                        seedScoreByNoteId.set(path, score);
                    }
                    seedIds = seedNotes.map(function (n) { return n.noteId; });
                    neighbors = graphStore.getNeighbors(seedIds, 1);
                    if (neighbors.length === 0) {
                        return [2 /*return*/, { seedNotes: seedNotes, expandedNotes: [] }];
                    }
                    storedNeighbors = graphStore.getNotesByIds(neighbors.map(function (n) { return n.noteId; }));
                    storedByNoteId = new Map(storedNeighbors.map(function (s) { return [s.note_id, s]; }));
                    expandedNotes = [];
                    for (_a = 0, neighbors_1 = neighbors; _a < neighbors_1.length; _a++) {
                        neighbor = neighbors_1[_a];
                        stored = storedByNoteId.get(neighbor.noteId);
                        if (!stored)
                            continue;
                        parentScore = (_f = seedScoreByNoteId.get(neighbor.linkedFrom)) !== null && _f !== void 0 ? _f : 0;
                        score = parentScore * GRAPH_SCORE_DECAY;
                        expandedNotes.push({
                            noteId: neighbor.noteId,
                            path: stored.path,
                            content: stored.body,
                            score: score,
                            type: stored.note_type,
                            toolId: (_g = stored.tool_id) !== null && _g !== void 0 ? _g : undefined,
                            retrievalSource: "graph",
                            depth: neighbor.depth,
                            linkedFrom: [neighbor.linkedFrom],
                        });
                    }
                    return [2 /*return*/, { seedNotes: seedNotes, expandedNotes: expandedNotes }];
            }
        });
    });
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function inferNoteType(relativePath) {
    if (relativePath.startsWith("tools/"))
        return "tool";
    if (relativePath.startsWith("concepts/"))
        return "concept";
    return "index";
}
