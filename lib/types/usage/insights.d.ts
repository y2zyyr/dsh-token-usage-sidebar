import type { LedgerState } from './ledger.js';
export type InsightRange = 'today' | 'yesterday' | '7d' | 'all';
export interface UsageMetrics {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    callCount: number;
}
export interface DailyUsage extends UsageMetrics {
    date: string;
    /** Total with a known date but no recoverable bucket breakdown. */
    unknownTokens: number;
}
export interface ModelUsage extends UsageMetrics {
    provider: string;
    model: string;
}
export interface UsageInsights {
    range: InsightRange;
    rangeStartDate?: string;
    rangeEndDate?: string;
    /** All authoritative tokens in the selected range, including legacy gaps. */
    totalTokens: number;
    /** Exact categories only for records whose five buckets were recovered. */
    categories: UsageMetrics;
    /** Explicit gap instead of assigning old unclassified data to a model/day. */
    unknownTokens: number;
    unknownCallCount: number;
    daily: DailyUsage[];
    models: ModelUsage[];
}
export declare function lastSevenLocalDates(now?: number): string[];
/** Build all selected aggregations without exposing ledger entries. */
export declare function buildUsageInsights(ledger: LedgerState, range: InsightRange, now?: number): UsageInsights;
