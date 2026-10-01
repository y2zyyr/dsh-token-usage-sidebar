import type { UsageRecord, UsageBuckets, UsageSourceType } from './types.js';
export declare const ACCOUNTING_VERSION = 2;
export interface SessionEventLike {
    readonly type: string;
    readonly seq: number;
    readonly time?: number;
    readonly data?: Record<string, unknown>;
}
export interface FoldInput {
    sessionId: string;
    events: readonly SessionEventLike[];
    now?: number;
    provider?: string;
    model?: string;
    sourceType?: UsageSourceType;
    sourcePath?: string;
    migrationVersion?: number;
    inheritedEventCount?: number;
    onInvalidUsage?: () => void;
}
export declare function bucketsOf(data: Record<string, unknown> | undefined): UsageBuckets | undefined;
export declare function modelSourceOf(data: Record<string, unknown> | undefined): {
    provider?: string;
    model?: string;
};
export interface CollectorCheckpoint {
    lastSeq: number;
    /** Only the active step can be retried in an append-only DSH log. */
    activeStep?: {
        turn: number;
        step: number;
        retrySeq?: number;
    };
}
/** Stateful live collector: explicit retry boundaries survive single-event delivery. */
export declare class SessionUsageCollector {
    private retrySlots;
    private lastSeq;
    private activeStep;
    private input;
    constructor(input: Omit<FoldInput, 'events'>, checkpoint?: CollectorCheckpoint);
    checkpoint(): CollectorCheckpoint;
    collect(events: readonly SessionEventLike[], sourceType?: UsageSourceType | undefined): UsageRecord[];
}
export declare function collectSessionUsage(input: FoldInput): readonly UsageRecord[];
