import { ContextEngine } from "../context_engine/index.js";
export type ReviewTrigger = "session_end" | "pre_compaction";
interface ReviewRunner {
    runReview: (userMessage: string) => Promise<string>;
    dispose: () => void;
}
export interface SessionReviewOptions {
    trigger: ReviewTrigger;
    sessionId: string;
    messages: unknown[];
    contextEngine?: ContextEngine;
    compactionMeta?: unknown;
    now?: () => number;
    rootDir?: string;
    createChildSession: (systemPrompt: string) => Promise<ReviewRunner>;
}
export declare function runSessionReview(opts: SessionReviewOptions): Promise<void>;
export {};
//# sourceMappingURL=session_review.d.ts.map