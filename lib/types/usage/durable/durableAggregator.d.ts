import type { UsageRecord } from '../types.js';
import { DurableStore } from './durableStore.js';
import type { ExcludedUnclassified, ProviderScope, UsageFacets, UsageFilters } from '../providerAliases.js';
import type { InsightRange } from '../insights.js';
export interface SummaryValue {
    todayTotal: number;
    todayDate: string;
    yesterdayTotal: number;
    yesterdayDate: string;
    lifetimeTotal: number;
    recordCount: number;
    serverNow: string;
}
export interface Metrics {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    callCount: number;
}
export interface DailyDetails extends Metrics {
    date: string;
    unknownTokens: number;
}
export interface ProviderBreakdown extends Metrics {
    provider: string;
}
export interface ModelDetails extends Metrics {
    provider: string;
    model: string;
    providerScope?: ProviderScope;
    rawProviders?: ProviderBreakdown[];
}
export interface DetailsValue {
    range: InsightRange;
    rangeStartDate?: string;
    rangeEndDate?: string;
    totalTokens: number;
    categories: Metrics;
    unknownTokens: number;
    unknownCallCount: number;
    daily: DailyDetails[];
    models: ModelDetails[];
    filters: UsageFilters;
    facets: UsageFacets;
    excludedUnclassified: ExcludedUnclassified;
}
export declare class DurableAggregator {
    private store;
    private now;
    private listeners;
    private closed;
    constructor(store: DurableStore, opts?: {
        now?: () => number;
    });
    summary(): SummaryValue;
    insights(range: InsightRange, inputFilters?: UsageFilters): DetailsValue;
    apply(records: readonly UsageRecord[]): number;
    get ready(): boolean;
    rebuildAggregates(): void;
    verifyAggregates(): {
        ok: boolean;
        recordTotal: number;
        globalTotal: number;
        details: string[];
        invalidRecords: number;
    };
    subscribe(l: (s: SummaryValue) => void): () => void;
    private notify;
    diagnostics(): Record<string, unknown>;
    close(): void;
}
