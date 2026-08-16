// src/usage/aggregator.ts
// Process-global, exactly-once token accounting service.
//   - Owns the durable LedgerState (lifetime/today/byId).
//   - apply(records) ingests authoritative invocation records exactly once;
//     duplicate or re-delivered ids are ignored (byId dedup).
//   - Persists the ledger to a UsageStore, debounced + on dispose.
//   - Exposes a live snapshot + subscribe() so the client refetches on change.
import { emptyLedger, foldRecords, synchronizeToday, type LedgerState } from './ledger.ts';
import { aggregateOf, type UsageAggregate } from './ledger.ts';
import { currentLocalDate, type UsageRecord } from './types.ts';
import type { UsageStore } from './store.ts';
import { normalizeLoad } from './store.ts';
import { runHistoricalMigration, type HistoricalReader } from './historical.ts';
import { totalForOffset } from './ledger.ts';
import { buildUsageInsights, type InsightRange, type UsageInsights } from './insights.ts';

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

export class UsageAggregator {
  private store: UsageStore;
  private ledger: LedgerState;
  private now: () => number;
  private persistDebounceMs: number;
  private sessionsDir?: string;
  private historicalReader?: HistoricalReader;
  private listeners = new Set<AggregatorListener>();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private closed = false;
  private loading = true;
  /** Serial save chain: guarantees saves are ordered and never concurrent. */
  private saveChain: Promise<void> | undefined;
  /** True while a flush's store.save is in flight (coalesces concurrent flushes). */
  private flushing = false;
  /** v1.0.1: result of loading the persisted ledger (none | ok | invalid). */
  private loadOutcome: 'none' | 'ok' | 'invalid' = 'none';

  constructor(opts: AggregatorOptions) {
    this.store = opts.store;
    this.now = opts.now ?? (() => Date.now());
    this.persistDebounceMs = opts.persistDebounceMs ?? 250;
    this.sessionsDir = opts.sessionsDir;
    this.historicalReader = opts.historicalReader;
    this.ledger = emptyLedger(this.now());
  }

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
  async start(): Promise<void> {
    const outcome = normalizeLoad(await this.store.load());
    if (outcome.status === 'ok') {
      this.loadOutcome = 'ok';
      this.ledger = this.normalizeDay(outcome.ledger);
    } else if (outcome.status === 'invalid') {
      this.loadOutcome = 'invalid';
      console.warn('[dsh-token-usage-sidebar] persisted ledger failed validation; '
        + 'refusing to reset totals to zero. Prior history is unavailable until the '
        + 'store is recovered.');
    } else {
      this.loadOutcome = 'none';
      this.ledger = emptyLedger(this.now());
    }
    this.loading = false;
    this.notify();
  }

  /** Roll today's bucket forward when the local day changed while unloaded. */
  private normalizeDay(l: LedgerState): LedgerState {
    return synchronizeToday(l, this.now());
  }

  /**
   * Ingest authoritative usage records exactly once. Records whose id is
   * already known are ignored (returns false). Returns count of new records.
   */
  apply(records: readonly UsageRecord[]): number {
    if (records.length === 0) return 0;
    let added = 0;
    let next = this.ledger;
    for (const rec of records) {
      // A final assistant/message event supersedes an earlier chunk event for
      // the same invocation.  Only an older/equal replay is ignored.
      const knownSeq = next.seqBy?.[rec.id];
      if (knownSeq !== undefined && rec.seq <= knownSeq) continue;
      // Live path defaults to live_event provenance.
      const r = (rec as any).sourceType === undefined
        ? { ...rec, sourceType: ('live_event' as const) }
        : rec;
      next = foldRecords(next, [r]);
      added += 1;
    }
    if (added === 0) return 0;
    this.ledger = this.normalizeDay(next);
    this.schedulePersist();
    this.notify();
    return added;
  }

  /**
   * v0.2 historical recovery migration (idempotent). Scans durable session logs
   * on disk and merges every authoritative historical record without resetting
   * or dropping existing live records; attribute sources and update metadata.
   */
  async migrateHistorical(): Promise<{ migrated: boolean; summary: unknown }> {
    if (this.closed) return { migrated: false, summary: null };
    const res = await runHistoricalMigration(this.ledger, {
      sessionsDir: this.sessionsDir,
      reader: this.historicalReader,
      now: this.now(),
    });
    if (res.migrated) {
      this.ledger = this.normalizeDay(res.ledger);
      this.schedulePersist();
      this.notify();
    }
    return { migrated: res.migrated, summary: res.summary };
  }

  /** v0.2 diagnostic view (no conversation content / credentials). */
  diagnostics(): Record<string, unknown> {
    const todayYmd = this.ledger.todayDate;
    const yesterday = totalForOffset(this.ledger, 1);
    return {
      loadStatus: this.loadOutcome,
      todayTotal: this.ledger.todayTotal,
      todayDate: todayYmd,
      yesterdayTotal: yesterday.total,
      yesterdayDate: yesterday.date,
      lifetimeTotal: this.ledger.lifetimeTotal,
      recordCount: this.ledger.recordCount,
      detailRecordCount: Object.keys(this.ledger.detailBy ?? {}).length,
      liveRecordedTotal: this.ledger.liveRecordedTotal ?? 0,
      historicalRecoveredTotal: this.ledger.historicalRecoveredTotal ?? 0,
      historicalRecoveredRecordCount: this.ledger.historicalRecoveredRecordCount ?? 0,
      schemaVersion: this.ledger.schemaVersion ?? 0,
      earliestRecoveredAt: this.ledger.recovery?.earliestRecoveredAt ?? undefined,
      latestRecoveredAt: this.ledger.recovery?.latestRecoveredAt ?? undefined,
      recoveryVersion: this.ledger.recovery?.recoveryVersion ?? undefined,
      recoveryCompletedAt: this.ledger.recovery?.recoveryCompletedAt ?? undefined,
      recoverySources: this.ledger.recovery?.recoverySources ?? undefined,
      sourceScanStatus: this.ledger.recovery?.sourceScanStatus ?? undefined,
      recoveryStatus: this.ledger.recovery?.recoveryStatus ?? undefined,
      sessionsDiscovered: this.ledger.recovery?.sessionsDiscovered ?? undefined,
      sessionsReadSuccessfully: this.ledger.recovery?.sessionsReadSuccessfully ?? undefined,
      sessionsReadFailed: this.ledger.recovery?.sessionsReadFailed ?? undefined,
      trackingStartDate: this.ledger.recovery?.trackingStartDate,
    };
  }

  /** Rebuild the ledger from a full record list (startup reconciliation). */
  replaceFrom(records: readonly UsageRecord[]): void {
    const rebuilt = foldRecords(emptyLedger(this.now()), records);
    this.ledger = rebuilt;
    this.schedulePersist();
    this.notify();
  }

  get aggregate(): UsageAggregate { return aggregateOf(this.ledger); }
  /** Aggregate-only detail view for the settings page. */
  insights(range: InsightRange): UsageInsights { return buildUsageInsights(this.ledger, range, this.now()); }
  /** Read-only snapshot of the underlying ledger (for per-day aggregation). */
  ledgerSnapshot(): LedgerState { return this.ledger; }
  get ready(): boolean { return !this.loading; }

  subscribe(l: AggregatorListener): () => void {
    this.listeners.add(l);
    l(this.aggregate);
    return () => { this.listeners.delete(l); };
  }

  private notify(): void {
    const agg = this.aggregate;
    for (const l of [...this.listeners]) {
      try { l(agg); } catch (e) { console.error('[dsh-token-usage-sidebar] listener error', e); }
    }
  }

  private schedulePersist(): void {
    if (this.closed) return; // never schedule after shutdown
    this.dirty = true;
    if (this.persistTimer !== undefined) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.flush();
    }, this.persistDebounceMs);
  }

  /**
   * Flush the debounced persistence. Serializes saves on a single chain so two
   * saves never run concurrently and an older ledger snapshot never lands after
   * a newer one. On failure the ledger stays dirty so a later flush/close
   * retries; a transient failure therefore never loses a write.
   */
  async flush(): Promise<void> {
    if (this.persistTimer !== undefined) { clearTimeout(this.persistTimer); this.persistTimer = undefined; }
    // Nothing dirty to write (e.g. already flushed, or a concurrent flush won
    // the race and consumed the dirty flag). While flushing, coalesce.
    if (!this.dirty || this.flushing) return;
    const snapshot = this.ledger; // immutable ref; a later apply() swaps in a new one
    this.dirty = false;
    this.flushing = true;
    // Enqueue this snapshot's save onto the chain; the previous task must finish
    // first so save order always matches apply order.
    const run = async (): Promise<void> => {
      try {
        await this.store.save(snapshot);
      } catch (e) {
        console.error('[dsh-token-usage-sidebar] persist failed', e);
        // Restore dirtiness so a later flush (or close) retries the write.
        this.dirty = true;
      }
    };
    const prev = this.saveChain ?? Promise.resolve();
    const next = prev.then(run, run);
    this.saveChain = next;
    try {
      await next;
    } finally {
      this.flushing = false;
      if (this.saveChain === next) this.saveChain = undefined;
    }
  }

  /**
   * Shutdown. P0 invariant: DIRTY_DATA_MUST_BE_FLUSHED_BEFORE_STORE_CLOSE.
   * We flush while still open (so the dirty check passes), then mark closed,
   * drain the serial save chain, detach listeners, and only then close the
   * underlying store. Idempotent: repeated close() is a no-op.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    // Flush BEFORE closed=true so the dirty write is not skipped by the guard.
    await this.flush();
    this.closed = true;
    // Drain any in-flight/queued save so a final store.close() never races it.
    if (this.saveChain) await this.saveChain;
    this.listeners.clear();
    if (this.store.close) await this.store.close();
  }
}
