import type { UsageAggregate, UsageRecord, UsageSourceType, RecoveryMetadata } from './types.js';
export type { UsageAggregate, UsageRecord, UsageSourceType, RecoveryMetadata } from './types.js';
/** Exact per-invocation data used by the insights API; never includes content. */
export interface UsageDetail {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    provider?: string;
    model?: string;
}
/**
 * Mutable, durable-ready accounting state. Kept small and JSON-serializable so
 * a plugin can persist it atomically. byId maps dedup id -> totalTokens.
 *
 * v0.2 adds per-id provenance (`src`) and the historical/live split so the
 * plugin can distinguish `historicalRecoveredTotal` (recovered from durable
 * session logs / stores) from `liveRecordedTotal` (recorded live after install).
 * `lifetimeTotal = liveRecordedTotal + historicalRecoveredTotal` with no overlap:
 * every id is attributed to exactly one source at first discovery (precedence:
 * live committed > durable session log > other), so the split is additive.
 */
export interface LedgerState {
    lifetimeTotal: number;
    todayTotal: number;
    todayDate: string;
    /** dedup id -> totalTokens for every distinct invocation ever recorded. */
    byId: Record<string, number>;
    /** Total distinct invocations. */
    recordCount: number;
    /** v0.2: dedup id -> provenance source (first discovery). Absent for legacy rows. */
    src?: Record<string, UsageSourceType>;
    /** v0.2: tokens attributed to live (post-install) records. */
    liveRecordedTotal?: number;
    /** v0.2: tokens attributed to historically recovered records. */
    historicalRecoveredTotal?: number;
    /** v0.2: how many distinct records were historically recovered (not live-overlap). */
    historicalRecoveredRecordCount?: number;
    /** v0.2: recovery/migration tracking metadata. */
    recovery?: RecoveryMetadata;
    /** v0.2: schema/format version (0/1 = v0.1, 2 = v0.2). */
    schemaVersion?: number;
    /** v0.2: dedup id -> local calendar day, for per-day aggregation and coverage. */
    dayBy?: Record<string, string>;
    /** Highest committed session-event sequence observed for each invocation. */
    seqBy?: Record<string, number>;
    /** v1.0 exact buckets and source identity keyed by the stable invocation id. */
    detailBy?: Record<string, UsageDetail>;
}
export declare const LEDGER_SCHEMA_VERSION = 4;
export declare function emptyLedger(now?: number, todayDate?: string): LedgerState;
export declare function localDate(now: number): string;
/**
 * Record one invocation. Rolls over todayTotal on local-day boundary. Returns
 * a NEW ledger reference (immutable update) so carriers can diff safely.
 */
export declare function recordUsage(prev: LedgerState, rec: UsageRecord): LedgerState;
/** Project the ledger to the (immutable) rendered aggregate. */
export declare function aggregateOf(ledger: LedgerState): UsageAggregate;
/** Sum of byId totals whose recorded local day equals `date` (YYYY-MM-DD). */
export declare function totalForDay(ledger: LedgerState, date: string): number;
/** Compute `days`-old day's total (0 = today, 1 = yesterday, ...). */
export declare function totalForOffset(ledger: LedgerState, offsetDays: number): {
    date: string;
    total: number;
};
/**
 * Make the cached Today projection match `now` without assigning dates to
 * undated legacy records.  Once dayBy exists, derive the visible bucket from
 * it; an old v0.1 ledger rolls to zero at a new day until a reliable mapping
 * is recovered from its durable session log.
 */
export declare function synchronizeToday(ledger: LedgerState, now?: number): LedgerState;
/** v0.2 diagnostic view: provenance split + recovery metadata. */
export declare function provenanceOf(ledger: LedgerState): {
    liveRecordedTotal: number;
    historicalRecoveredTotal: number;
    historicalRecoveredRecordCount: number;
    schemaVersion: number;
    recovery: RecoveryMetadata | undefined;
};
/**
 * Fold a batch of usage records (startup replay, re-delivery). Order-
 * independent and idempotent: each distinct id is counted at its final total
 * (higher-seq record wins). Pass emptyLedger() to rebuild from scratch.
 */
export declare function foldRecords(base: LedgerState, records: readonly UsageRecord[]): LedgerState;
export declare function hasRecord(ledger: LedgerState, id: string): boolean;
/**
 * v1.0.1 invariant (§17): recompute the live/historical source split directly
 * from byId + src, so the additive identity
 *   lifetimeTotal === liveRecordedTotal + historicalRecoveredTotal
 * always holds even if a prior migration left the cached split fields stale.
 * byId/src are the authoritative source of truth for attribution.
 */
export declare function recomputeSourceSplit(ledger: LedgerState): LedgerState;
export declare function rebuild(records: readonly UsageRecord[], now?: number): LedgerState;
