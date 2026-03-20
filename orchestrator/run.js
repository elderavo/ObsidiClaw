"use strict";
/**
 * Interactive entry point — launches a pi agent session with context injection.
 *
 * Flow:
 *   1. Context engine indexes md_db (LlamaIndex + Ollama embeddings)
 *   2. User types first prompt → context engine runs RAG → pi session created
 *      with retrieved context injected as system context
 *   3. User continues chatting — context engine does NOT re-run; pi session
 *      maintains full conversation history
 *
 * Usage:
 *   npx tsx orchestrator/run.ts
 *
 * Environment variables:
 *   OLLAMA_BASE_URL    — LLM endpoint   (default: http://10.0.132.100/v1)
 *   OLLAMA_MODEL       — LLM model      (default: llama3)
 *   OLLAMA_HOST        — embeddings host (default: 10.0.132.100)
 *   OLLAMA_EMBED_MODEL — embeddings model (default: nomic-embed-text:v1.5)
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
var readline_1 = require("readline");
var path_1 = require("path");
var url_1 = require("url");
var orchestrator_js_1 = require("./orchestrator.js");
var index_js_1 = require("../logger/index.js");
var index_js_2 = require("../context_engine/index.js");
var __dirname = (0, url_1.fileURLToPath)(new URL(".", import.meta.url));
var mdDbPath = (0, path_1.resolve)(__dirname, "../md_db");
// ── Boot ──────────────────────────────────────────────────────────────────
console.log("[obsidi-claw] Initializing context engine...");
var contextEngine = new index_js_2.ContextEngine({ mdDbPath: mdDbPath });
await contextEngine.initialize();
console.log("[obsidi-claw] Context engine ready.\n");
var logger = new index_js_1.RunLogger();
var orchestrator = new orchestrator_js_1.Orchestrator(logger, contextEngine);
// ── Start session ─────────────────────────────────────────────────────────
var session = orchestrator.createSession({
    onOutput: function (delta) { return process.stdout.write(delta); },
});
console.log("[obsidi-claw] Session started. Type your prompt and press Enter.");
console.log("[obsidi-claw] First prompt → context injection + pi session creation.");
console.log("[obsidi-claw] Ctrl+C or Ctrl+D to exit.\n");
// ── Readline loop ─────────────────────────────────────────────────────────
var rl = (0, readline_1.createInterface)({
    input: process.stdin,
    output: process.stdout,
    prompt: "you> ",
    terminal: true,
});
var activePrompt = null;
rl.prompt();
rl.on("line", function (line) { return __awaiter(void 0, void 0, void 0, function () {
    var text;
    return __generator(this, function (_a) {
        text = line.trim();
        if (!text) {
            rl.prompt();
            return [2 /*return*/];
        }
        rl.pause();
        process.stdout.write("\nagent> ");
        activePrompt = session.prompt(text).then(function () { process.stdout.write("\n"); }, function (err) { console.error("\n[error]", err instanceof Error ? err.message : String(err)); }).finally(function () {
            activePrompt = null;
            rl.resume();
            rl.prompt();
        });
        return [2 /*return*/];
    });
}); });
rl.on("close", function () { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                if (!activePrompt) return [3 /*break*/, 2];
                return [4 /*yield*/, activePrompt];
            case 1:
                _a.sent();
                _a.label = 2;
            case 2:
                session.dispose();
                console.log("\n[obsidi-claw] Session ended.");
                process.exit(0);
                return [2 /*return*/];
        }
    });
}); });
