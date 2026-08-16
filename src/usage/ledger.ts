// src/usage/ledger.ts
// Pure, exactly-once accounting over model-invocation usage.
//
// Invariant: ONE_MODEL_INVOCATION_ONE_USAGE_RECORD. The dedup identity is
// (sessionId, turn, step). An early assistant/chunk usage sample and the final
// assistant/message usage for the SAME (turn, step) are the SAME invocation:
// the ledger REPLACES the earlier sample's total with the later authoritative
// one instead of adding it. Lifetime/Total move exactly once per invocation
// regardless of duplicate delivery, retries, or replays.

import type { UsageAggregate, UsageRecord, UsageSourceType, RecoveryMetadata } from './types.ts';

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
}

export const LEDGER_SCHEMA_VERSION = 3;

export function emptyLedger(now = Date.now(), todayDate = localDateOf(now)): LedgerState {
  return {
    lifetimeTotal: 0, todayTotal: 0, todayDate, byId: {},
    recordCount: 0,
    src: {}, liveRecordedTotal: 0, historicalRecoveredTotal: 0,
    historicalRecoveredRecordCount: 0,
    // schemaVersion intentionally NOT pre-set: a fresh (or v0.1) ledger is
    // "not migrated" (treated as 0) so v0.2 historical recovery runs once.
  };
}

function localDateOf(now: number): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

export function localDate(now: number): string { return localDateOf(now); }

/**
 * Record one invocation. Rolls over todayTotal on local-day boundary. Returns
 * a NEW ledger reference (immutable update) so carriers can diff safely.
 */
export function recordUsage(prev: LedgerState, rec: UsageRecord): LedgerState {
  const dayChanged = prev.todayDate !== rec.localDate;
  const baseToday = dayChanged ? 0 : prev.todayTotal;
  const existing = Object.prototype.hasOwnProperty.call(prev.byId, rec.id) ? prev.byId[rec.id] : undefined;
  const isNew = existing === undefined;
  const delta = rec.totalTokens - (isNew ? 0 : existing);
  const todayDelta = rec.localDate === (dayChanged ? rec.localDate : prev.todayDate) ? delta : 0;

  // Provenance attribution: an id keeps its first-seen source. A NEW record's
  // source is decided here; an existing id keeps whatever it already had.
  const src = prev.src ?? {};
  const newSource = (rec as { sourceType?: UsageSourceType }).sourceType ?? 'live_event';
  const priorSrc = src[rec.id];
  const srcNext = { ...src };
  if (priorSrc === undefined) srcNext[rec.id] = newSource;

  // Live/historical split: only a brand-new id advances the bucket of its source.
  let liveRecordedTotal = prev.liveRecordedTotal ?? 0;
  let historicalRecoveredTotal = prev.historicalRecoveredTotal ?? 0;
  let historicalRecoveredRecordCount = prev.historicalRecoveredRecordCount ?? 0;
  if (isNew) {
    const attr = priorSrc ?? newSource;
    if (attr === 'live_event' || attr === 'other') liveRecordedTotal += rec.totalTokens;
    else { historicalRecoveredTotal += rec.totalTokens; historicalRecoveredRecordCount += 1; }
  }

  const dayBy = { ...(prev.dayBy ?? {}) };
  // A replay of an existing v0.2 row is allowed to enrich its previously
  // missing date.  This changes no token totals and never invents a date.
  if (isNew || dayBy[rec.id] === undefined || rec.seq >= (prev.seqBy?.[rec.id] ?? -1)) dayBy[rec.id] = rec.localDate;
  const seqBy = { ...(prev.seqBy ?? {}) };
  if (isNew || rec.seq >= (seqBy[rec.id] ?? -1)) seqBy[rec.id] = rec.seq;

  // A replacement (stream usage followed by final assistant/message usage)
  // belongs to the source that first introduced the invocation.  Keep the
  // source totals additive with lifetimeTotal when its final usage changes.
  if (!isNew && delta !== 0) {
    if ((priorSrc ?? newSource) === 'live_event' || (priorSrc ?? newSource) === 'other') liveRecordedTotal += delta;
    else historicalRecoveredTotal += delta;
  }

  return {
    lifetimeTotal: prev.lifetimeTotal + delta,
    todayTotal: baseToday + todayDelta,
    todayDate: dayChanged ? rec.localDate : prev.todayDate,
    byId: { ...prev.byId, [rec.id]: rec.totalTokens },
    recordCount: prev.recordCount + (isNew ? 1 : 0),
    src: srcNext,
    liveRecordedTotal,
    historicalRecoveredTotal,
    historicalRecoveredRecordCount,
    schemaVersion: prev.schemaVersion ?? LEDGER_SCHEMA_VERSION,
    ...(Object.keys(dayBy).length > 0 ? { dayBy } : {}),
    ...(Object.keys(seqBy).length > 0 ? { seqBy } : {}),
    ...(prev.recovery ? { recovery: prev.recovery } : {}),
  };
}

/** Project the ledger to the (immutable) rendered aggregate. */
export function aggregateOf(ledger: LedgerState): UsageAggregate {
  return {
    lifetimeTotal: ledger.lifetimeTotal,
    todayTotal: ledger.todayTotal,
    todayDate: ledger.todayDate,
    recordCount: ledger.recordCount,
  };
}

/** Sum of byId totals whose recorded local day equals `date` (YYYY-MM-DD). */
export function totalForDay(ledger: LedgerState, date: string): number {
  const dayBy = ledger.dayBy ?? {};
  let total = 0;
  for (const id of Object.keys(ledger.byId)) {
    if (dayBy[id] === date) total += ledger.byId[id];
  }
  return total;
}

/** Compute `days`-old day's total (0 = today, 1 = yesterday, ...). */
export function totalForOffset(ledger: LedgerState, offsetDays: number): { date: string; total: number } {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const dd = String(d.getDate()).padStart(2, '0');
  const date = y + '-' + m + '-' + dd;
  return { date, total: totalForDay(ledger, date) };
}

/**
 * Make the cached Today projection match `now` without assigning dates to
 * undated legacy records.  Once dayBy exists, derive the visible bucket from
 * it; an old v0.1 ledger rolls to zero at a new day until a reliable mapping
 * is recovered from its durable session log.
 */
export function synchronizeToday(ledger: LedgerState, now = Date.now()): LedgerState {
  const todayDate = localDateOf(now);
  const todayTotal = totalForDay(ledger, todayDate);
  if (ledger.todayDate === todayDate && ledger.todayTotal === todayTotal) return ledger;
  return { ...ledger, todayDate, todayTotal };
}

/** v0.2 diagnostic view: provenance split + recovery metadata. */
export function provenanceOf(ledger: LedgerState) {
  return {
    liveRecordedTotal: ledger.liveRecordedTotal ?? 0,
    historicalRecoveredTotal: ledger.historicalRecoveredTotal ?? 0,
    historicalRecoveredRecordCount: ledger.historicalRecoveredRecordCount ?? 0,
    schemaVersion: ledger.schemaVersion ?? 0,
    recovery: ledger.recovery,
  };
}

/**
 * Fold a batch of usage records (startup replay, re-delivery). Order-
 * independent and idempotent: each distinct id is counted at its final total
 * (higher-seq record wins). Pass emptyLedger() to rebuild from scratch.
 */
export function foldRecords(base: LedgerState, records: readonly UsageRecord[]): LedgerState {
  const sorted = [...records].sort((a, b) => (a.id === b.id ? a.seq - b.seq : 0));
  let acc = base;
  for (const r of sorted) acc = recordUsage(acc, r);
  return acc;
}

export function hasRecord(ledger: LedgerState, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(ledger.byId, id);
}

export function rebuild(records: readonly UsageRecord[], now = Date.now()): LedgerState {
  return foldRecords(emptyLedger(now), records);
}
