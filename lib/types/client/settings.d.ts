import { type JSX } from 'react';
import type { ProviderScope, UsageFacets, UsageFilters } from '../usage/providerAliases.js';
import type { UsageHealth } from '../usage/health.js';
export type DetailRange = 'today' | 'yesterday' | '7d' | 'all';
interface Metrics {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    callCount: number;
}
interface Daily extends Metrics {
    date: string;
    unknownTokens: number;
}
interface ProviderBreakdown extends Metrics {
    provider: string;
}
interface Model extends Metrics {
    provider: string;
    model: string;
    providerScope?: ProviderScope;
    rawProviders?: ProviderBreakdown[];
}
export interface Details {
    health?: UsageHealth;
    range: DetailRange;
    rangeStartDate?: string;
    rangeEndDate?: string;
    totalTokens: number;
    categories: Metrics;
    unknownTokens: number;
    unknownCallCount: number;
    daily: Daily[];
    models: Model[];
    filters?: UsageFilters;
    facets?: UsageFacets;
    excludedUnclassified?: {
        tokens: number;
        calls: number;
    };
}
type Translate = (key: string) => string;
export declare function fetchDetails(range: DetailRange, signal?: AbortSignal): Promise<Details | undefined>;
export declare function fetchDetails(range: DetailRange, filters?: UsageFilters, signal?: AbortSignal): Promise<Details | undefined>;
export declare function TokenUsageSettings({ t }: {
    t: Translate;
}): JSX.Element;
export {};
