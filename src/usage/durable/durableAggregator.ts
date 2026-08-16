// src/usage/durable/durableAggregator.ts — v1.1 aggregate-driven accounting service
// Reads aggregate rows/indexes from SQLite; no full-history scan for summary/settings.
// Wire shapes byte-compatible with v1.0.1 (client unchanged).

import type { UsageRecord } from '../types.ts';
import { DurableStore, type DailyAggRow, type GlobalAggRow, type ModelAggRow } from './durableStore.ts';
import type { InsightRange } from '../insights.ts';
import { localDate } from '../ledger.ts';

export interface SummaryValue { todayTotal: number; todayDate: string; yesterdayTotal: number; yesterdayDate: string; lifetimeTotal: number; recordCount: number; serverNow: string; }
export interface Metrics { totalTokens: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; callCount: number; }
export interface DailyDetails extends Metrics { date: string; unknownTokens: number; }
export interface ModelDetails extends Metrics { provider: string; model: string; }
export interface DetailsValue { range: InsightRange; rangeStartDate?: string; rangeEndDate?: string; totalTokens: number; categories: Metrics; unknownTokens: number; unknownCallCount: number; daily: DailyDetails[]; models: ModelDetails[]; }

function emptyMetrics(): Metrics { return { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, callCount: 0 }; }
function datesEnding(now: number, days: number): string[] { const d = new Date(now); d.setHours(12, 0, 0, 0); const dates: string[] = []; for (let i = days - 1; i >= 0; i -= 1) { const cursor = new Date(d); cursor.setDate(cursor.getDate() - i); dates.push(localDate(cursor.getTime())); } return dates; }

export class DurableAggregator {
  private store: DurableStore; private now: () => number; private listeners = new Set<(s: SummaryValue) => void>(); private closed = false;
  constructor(store: DurableStore, opts: { now?: () => number } = {}) { this.store = store; this.now = opts.now ?? (() => Date.now()); }
  summary(): SummaryValue {
    const now = this.now(); const global = this.store.globalAggregate(); const todayDate = localDate(now); const yesterdayDate = datesEnding(now, 2)[0];
    const today = this.store.daily(todayDate); const yesterday = this.store.daily(yesterdayDate);
    return { todayTotal: today?.total_tokens ?? 0, todayDate, yesterdayTotal: yesterday?.total_tokens ?? 0, yesterdayDate, lifetimeTotal: global?.total_tokens ?? 0, recordCount: this.store.recordCount(), serverNow: todayDate };
  }
  insights(range: InsightRange): DetailsValue {
    const now = this.now();
    if (range === 'all') { const global = this.store.globalAggregate() ?? ({} as GlobalAggRow); return { range, totalTokens: global.total_tokens ?? 0, categories: metricsOf(global), unknownTokens: global.unknown_tokens ?? 0, unknownCallCount: global.unknown_calls ?? 0, daily: dailyToDetails(this.store.dailyTotals()), models: modelsToDetails(this.store.modelTotals()) }; }
    if (range === '7d') {
      const dates = datesEnding(now, 7); const allDaily = this.store.dailyTotals();
      const selectedDaily = allDaily.filter((d) => dates.includes(d.local_date)).sort((a, b) => a.local_date < b.local_date ? -1 : 1);
      const dayModels = this.store.dayModelTotals().filter((m) => dates.includes(m.local_date));
      return { range, rangeStartDate: dates[0], rangeEndDate: dates[dates.length - 1], totalTokens: selectedDaily.reduce((a, d) => a + d.total_tokens, 0), categories: sumCategories(selectedDaily), unknownTokens: selectedDaily.reduce((a, d) => a + (d.unknown_tokens ?? 0), 0), unknownCallCount: selectedDaily.reduce((a, d) => a + (d.unknown_calls ?? 0), 0), daily: dailyToDetails(selectedDaily), models: mergeDayModels(dayModels) };
    }
    const target = range === 'today' ? localDate(now) : datesEnding(now, 2)[0];
    const day = this.store.daily(target) ?? ({} as DailyAggRow); const dayModels = this.store.dayModelTotals(target);
    return { range, ...(range === 'yesterday' ? { rangeStartDate: target, rangeEndDate: target } : {}), totalTokens: day.total_tokens ?? 0, categories: { totalTokens: day.total_tokens ?? 0, inputTokens: day.input_tokens ?? 0, outputTokens: day.output_tokens ?? 0, cacheReadTokens: day.cache_read_tokens ?? 0, cacheWriteTokens: day.cache_write_tokens ?? 0, reasoningTokens: day.reasoning_tokens ?? 0, callCount: day.calls ?? 0 }, unknownTokens: day.unknown_tokens ?? 0, unknownCallCount: day.unknown_calls ?? 0, daily: dailyToDetails(this.store.dailyTotals()), models: modelsToDetails(dayModels) };
  }
  apply(records: readonly UsageRecord[]): number { if (this.closed) return 0; const o = this.store.apply(records); if (o.added + o.replaced > 0) this.notify(); return o.added + o.replaced; }
  get ready(): boolean { return !this.closed; }
  rebuildAggregates(): void { this.store.rebuildAggregates(); }
  verifyAggregates() { return this.store.verifyAggregates(); }
  subscribe(l: (s: SummaryValue) => void): () => void { this.listeners.add(l); try { l(this.summary()); } catch {} return () => { this.listeners.delete(l); }; }
  private notify(): void { const s = this.summary(); for (const l of [...this.listeners]) { try { l(s); } catch {} } }
  diagnostics(): Record<string, unknown> { const meta = this.store.readMeta(); const global = this.store.globalAggregate(); const split = this.store.provenanceSplit(); return { storageBackend: 'sqlite', storageSchemaVersion: meta?.storageSchemaVersion, migrationVersion: meta?.migrationVersion, migrationStatus: meta?.migrationStatus, recordGeneration: meta?.recordGeneration, aggregateGeneration: meta?.aggregateGeneration, lastAggregateRebuild: meta?.lastAggregateRebuild ?? undefined, recordCount: this.store.recordCount(), aggregateStatus: this.store.verifyAggregates().ok ? 'consistent' : 'stale', lifetimeTotal: global?.total_tokens ?? 0, liveRecordedTotal: split.live, historicalRecoveredTotal: split.historical, historicalRecoveredRecordCount: split.historicalCount, earliestRecordAt: this.store.earliestRecordAt() ?? undefined, latestRecordAt: this.store.latestRecordAt() ?? undefined }; }
  close(): void { if (this.closed) return; this.closed = true; this.listeners.clear(); this.store.close(); }
}
function metricsOf(g: Partial<GlobalAggRow>): Metrics { return { totalTokens: g.total_tokens ?? 0, inputTokens: g.input_tokens ?? 0, outputTokens: g.output_tokens ?? 0, cacheReadTokens: g.cache_read_tokens ?? 0, cacheWriteTokens: g.cache_write_tokens ?? 0, reasoningTokens: g.reasoning_tokens ?? 0, callCount: g.calls ?? 0 }; }
function sumCategories(rows: DailyAggRow[]): Metrics { return rows.reduce<Metrics>((acc, d) => ({ totalTokens: acc.totalTokens + d.total_tokens, inputTokens: acc.inputTokens + d.input_tokens, outputTokens: acc.outputTokens + d.output_tokens, cacheReadTokens: acc.cacheReadTokens + d.cache_read_tokens, cacheWriteTokens: acc.cacheWriteTokens + d.cache_write_tokens, reasoningTokens: acc.reasoningTokens + d.reasoning_tokens, callCount: acc.callCount + d.calls }), emptyMetrics()); }
function dailyToDetails(rows: DailyAggRow[]): DailyDetails[] { return rows.map((d) => ({ date: d.local_date, totalTokens: d.total_tokens, inputTokens: d.input_tokens, outputTokens: d.output_tokens, cacheReadTokens: d.cache_read_tokens, cacheWriteTokens: d.cache_write_tokens, reasoningTokens: d.reasoning_tokens, callCount: d.calls, unknownTokens: d.unknown_tokens ?? 0 })); }
interface ModelLike { provider: string; model: string; total_tokens: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; reasoning_tokens: number; calls: number; }
function modelsToDetails(rows: ModelLike[]): ModelDetails[] { return rows.map((m) => ({ totalTokens: m.total_tokens, inputTokens: m.input_tokens, outputTokens: m.output_tokens, cacheReadTokens: m.cache_read_tokens, cacheWriteTokens: m.cache_write_tokens, reasoningTokens: m.reasoning_tokens, callCount: m.calls, provider: m.provider, model: m.model })).sort((a, b) => b.totalTokens - a.totalTokens); }
function mergeDayModels(rows: { local_date: string; provider: string; model: string; total_tokens: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; reasoning_tokens: number; calls: number }[]): ModelDetails[] {
  const map = new Map<string, ModelDetails>();
  for (const r of rows) { const key = r.provider + '\u0000' + r.model; const cur = map.get(key) ?? { provider: r.provider, model: r.model, ...emptyMetrics() }; cur.totalTokens += r.total_tokens; cur.inputTokens += r.input_tokens; cur.outputTokens += r.output_tokens; cur.cacheReadTokens += r.cache_read_tokens; cur.cacheWriteTokens += r.cache_write_tokens; cur.reasoningTokens += r.reasoning_tokens; cur.callCount += r.calls; map.set(key, cur); }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}
