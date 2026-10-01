import { type LedgerState } from './ledger.js';
import { type UsageAggregate } from './ledger.js';
import { type UsageRecord } from './types.js';
import type { UsageStore } from './store.js';
import { type HistoricalReader } from './historical.js';
import { type InsightRange, type UsageInsights } from './insights.js';
export interface AggregatorOptions {
    store: UsageStore;
    /** Debounce window for persistence, ms. */
    persistDebounceMs?: number;
    now?: () => number;
    /** Explicit sessions root for historical recovery (defaults to DSH home). */
    sessionsDir?: string;
    /** Optional custom historical reader (e.g. backed by ctx.sessionPersistence). */
    historicalReader?: HistoricalReader;
}
export type AggregatorListener = (agg: UsageAggregate) => void;
export declare class UsageAggregator {
    private store;
    private ledger;
    private now;
    private persistDebounceMs;
    private sessionsDir?;
    private historicalReader?;
    private listeners;
    private persistTimer;
    private dirty;
    private closed;
    private loading;
    /** Serial save chain: guarantees saves are ordered and never concurrent. */
    private saveChain;
    /** True while a flush's store.save is in flight (coalesces concurrent flushes). */
    private flushing;
    /** v1.0.1: result of loading the persisted ledger (none | ok | invalid). */
    private loadOutcome;
    constructor(opts: AggregatorOptions);
    /**
     * Load persisted state. Call once before first read.
     * v1.0.1 (§18, §41): a corrupt/invalid persisted ledger must NEVER silently
     * reset the totals to zero. We distinguish:
     *   - 'none'    -> nothing persisted yet -> start fresh (correct).
     *   - 'ok'      -> validated ledger loaded.
     *   - 'invalid' -> a row exists but failed validation -> warn loudly, keep an
     *                  empty in-memory ledger for live use, and NEVER overwrite
     *                  the corrupt on-disk source in place of a silent reset.
     * The driver calls log() whenever a legacy store.load() returned undefined
     * solely because nothing existed; corruption is surfaced through diagnostics().
     */
    start(): Promise<void>;
    /** Roll today's bucket forward when the local day changed while unloaded. */
    private normalizeDay;
    /**
     * Ingest authoritative usage records exactly once. Records whose id is
     * already known are ignored (returns false). Returns count of new records.
     */
    apply(records: readonly UsageRecord[]): number;
    /**
     * v0.2 historical recovery migration (idempotent). Scans durable session logs
     * on disk and merges every authoritative historical record without resetting
     * or dropping existing live records; attribute sources and update metadata.
     */
    migrateHistorical(): Promise<{
        migrated: boolean;
        summary: unknown;
    }>;
    /** v0.2 diagnostic view (no conversation content / credentials). */
    diagnostics(): Record<string, unknown>;
    /** Rebuild the ledger from a full record list (startup reconciliation). */
    replaceFrom(records: readonly UsageRecord[]): void;
    get aggregate(): UsageAggregate;
    /** Aggregate-only detail view for the settings page. */
    insights(range: InsightRange): UsageInsights;
    /** Read-only snapshot of the underlying ledger (for per-day aggregation). */
    ledgerSnapshot(): LedgerState;
    get ready(): boolean;
    subscribe(l: AggregatorListener): () => void;
    private notify;
    private schedulePersist;
    /**
     * Flush the debounced persistence. Serializes saves on a single chain so two
     * saves never run concurrently and an older ledger snapshot never lands after
     * a newer one. On failure the ledger stays dirty so a later flush/close
     * retries; a transient failure therefore never loses a write.
     */
    flush(): Promise<void>;
    /**
     * Shutdown. P0 invariant: DIRTY_DATA_MUST_BE_FLUSHED_BEFORE_STORE_CLOSE.
     * We flush while still open (so the dirty check passes), then mark closed,
     * drain the serial save chain, detach listeners, and only then close the
     * underlying store. Idempotent: repeated close() is a no-op.
     */
    close(): Promise<void>;
}
