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
import { runHistoricalMigration, type HistoricalReader } from './historical.ts';
import { totalForOffset } from './ledger.ts';

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

  constructor(opts: AggregatorOptions) {
    this.store = opts.store;
    this.now = opts.now ?? (() => Date.now());
    this.persistDebounceMs = opts.persistDebounceMs ?? 250;
    this.sessionsDir = opts.sessionsDir;
    this.historicalReader = opts.historicalReader;
    this.ledger = emptyLedger(this.now());
  }

  /** Load persisted state. Call once before first read. */
  async start(): Promise<void> {
    const persisted = await this.store.load();
    if (persisted) this.ledger = this.normalizeDay(persisted);
    else this.ledger = emptyLedger(this.now());
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
      todayTotal: this.ledger.todayTotal,
      todayDate: todayYmd,
      yesterdayTotal: yesterday.total,
      yesterdayDate: yesterday.date,
      lifetimeTotal: this.ledger.lifetimeTotal,
      recordCount: this.ledger.recordCount,
      liveRecordedTotal: this.ledger.liveRecordedTotal ?? 0,
      historicalRecoveredTotal: this.ledger.historicalRecoveredTotal ?? 0,
      historicalRecoveredRecordCount: this.ledger.historicalRecoveredRecordCount ?? 0,
      schemaVersion: this.ledger.schemaVersion ?? 0,
      earliestRecoveredAt: this.ledger.recovery?.earliestRecoveredAt ?? undefined,
      latestRecoveredAt: this.ledger.recovery?.latestRecoveredAt ?? undefined,
      recoveryVersion: this.ledger.recovery?.recoveryVersion ?? undefined,
      recoveryCompletedAt: this.ledger.recovery?.recoveryCompletedAt ?? undefined,
      recoverySources: this.ledger.recovery?.recoverySources ?? undefined,
      recoveryStatus: this.ledger.recovery?.recoveryStatus ?? undefined,
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
    this.dirty = true;
    if (this.persistTimer !== undefined) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.flush();
    }, this.persistDebounceMs);
  }

  /** Flush the debounced persistence (also callable on dispose). */
  async flush(): Promise<void> {
    if (this.persistTimer !== undefined) { clearTimeout(this.persistTimer); this.persistTimer = undefined; }
    if (!this.dirty || this.closed) return;
    this.dirty = false;
    try { await this.store.save(this.ledger); }
    catch (e) { console.error('[dsh-token-usage-sidebar] persist failed', e); this.dirty = true; }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    this.listeners.clear();
    if (this.store.close) await this.store.close();
  }
}
