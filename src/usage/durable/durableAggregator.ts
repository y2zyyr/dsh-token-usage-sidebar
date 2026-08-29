// src/usage/durable/durableAggregator.ts — v1.1 aggregate-driven accounting service
// Reads aggregate rows/indexes from SQLite; no full-history scan for summary/settings.
// Provider aliases are a local view layer over the raw provider strings recorded
// by DSH. They never mutate the accounting ledger.

import type { UsageRecord } from '../types.ts';
import { DurableStore, type DailyAggRow, type DayModelAggRow, type GlobalAggRow, type ModelAggRow } from './durableStore.ts';
import type { ExcludedUnclassified, ProviderAliasGroup, ProviderModelPair, ProviderOption, ProviderScope, UsageFacets, UsageFilters } from '../providerAliases.ts';
import type { InsightRange } from '../insights.ts';
import { localDate } from '../ledger.ts';

export interface SummaryValue { todayTotal: number; todayDate: string; yesterdayTotal: number; yesterdayDate: string; lifetimeTotal: number; recordCount: number; serverNow: string; }
export interface Metrics { totalTokens: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; callCount: number; }
export interface DailyDetails extends Metrics { date: string; unknownTokens: number; }
export interface ProviderBreakdown extends Metrics { provider: string; }
export interface ModelDetails extends Metrics { provider: string; model: string; providerScope?: ProviderScope; rawProviders?: ProviderBreakdown[]; }
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

function emptyMetrics(): Metrics { return { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, callCount: 0 }; }
function datesEnding(now: number, days: number): string[] { const d = new Date(now); d.setHours(12, 0, 0, 0); const dates: string[] = []; for (let i = days - 1; i >= 0; i -= 1) { const cursor = new Date(d); cursor.setDate(cursor.getDate() - i); dates.push(localDate(cursor.getTime())); } return dates; }
function datesForRange(range: InsightRange, now: number): string[] | undefined {
  if (range === 'all') return undefined;
  if (range === 'today') return datesEnding(now, 1);
  if (range === 'yesterday') return [datesEnding(now, 2)[0]];
  return datesEnding(now, 7);
}

interface ModelLike { provider: string; model: string; total_tokens: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; reasoning_tokens: number; calls: number; }
interface DayModelLike extends ModelLike { local_date: string; }

function metricsOf(g: Partial<GlobalAggRow>): Metrics { return { totalTokens: g.total_tokens ?? 0, inputTokens: g.input_tokens ?? 0, outputTokens: g.output_tokens ?? 0, cacheReadTokens: g.cache_read_tokens ?? 0, cacheWriteTokens: g.cache_write_tokens ?? 0, reasoningTokens: g.reasoning_tokens ?? 0, callCount: g.calls ?? 0 }; }
function metricsOfModel(row: ModelLike): Metrics { return { totalTokens: row.total_tokens, inputTokens: row.input_tokens, outputTokens: row.output_tokens, cacheReadTokens: row.cache_read_tokens, cacheWriteTokens: row.cache_write_tokens, reasoningTokens: row.reasoning_tokens, callCount: row.calls }; }
function addMetrics(target: Metrics, source: Metrics): void {
  target.totalTokens += source.totalTokens;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.callCount += source.callCount;
}
function sumModelMetrics(rows: readonly ModelLike[]): Metrics {
  const out = emptyMetrics();
  for (const row of rows) addMetrics(out, metricsOfModel(row));
  return out;
}
function sumCategories(rows: readonly DailyAggRow[]): Metrics {
  return rows.reduce<Metrics>((acc, d) => ({ totalTokens: acc.totalTokens + d.total_tokens, inputTokens: acc.inputTokens + d.input_tokens, outputTokens: acc.outputTokens + d.output_tokens, cacheReadTokens: acc.cacheReadTokens + d.cache_read_tokens, cacheWriteTokens: acc.cacheWriteTokens + d.cache_write_tokens, reasoningTokens: acc.reasoningTokens + d.reasoning_tokens, callCount: acc.callCount + d.calls }), emptyMetrics());
}
function dailyToDetails(rows: readonly DailyAggRow[]): DailyDetails[] {
  return rows.map((d) => ({ date: d.local_date, totalTokens: d.total_tokens, inputTokens: d.input_tokens, outputTokens: d.output_tokens, cacheReadTokens: d.cache_read_tokens, cacheWriteTokens: d.cache_write_tokens, reasoningTokens: d.reasoning_tokens, callCount: d.calls, unknownTokens: d.unknown_tokens ?? 0 }));
}
function sortModels(rows: ModelDetails[]): ModelDetails[] {
  return rows.sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

function modelDetailsOf(rows: readonly ModelLike[], scope?: ProviderScope, group?: ProviderAliasGroup): ModelDetails[] {
  const displayProvider = scope?.type === 'group' && group ? group.label : undefined;
  const map = new Map<string, ModelDetails>();
  const breakdowns = new Map<string, Map<string, ProviderBreakdown>>();
  for (const row of rows) {
    const provider = displayProvider ?? row.provider;
    const key = provider + '\u0000' + row.model;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        provider,
        model: row.model,
        ...metricsOfModel(row),
        providerScope: scope ?? { type: 'raw', value: row.provider },
        ...(group ? { rawProviders: [] } : {}),
      });
    } else {
      addMetrics(existing, metricsOfModel(row));
    }
    if (group) {
      let byProvider = breakdowns.get(key);
      if (!byProvider) { byProvider = new Map(); breakdowns.set(key, byProvider); }
      const raw = byProvider.get(row.provider);
      if (raw) addMetrics(raw, metricsOfModel(row));
      else byProvider.set(row.provider, { provider: row.provider, ...metricsOfModel(row) });
    }
  }
  for (const [key, byProvider] of breakdowns) {
    const detail = map.get(key);
    if (detail) detail.rawProviders = [...byProvider.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider));
  }
  return sortModels([...map.values()]);
}

function dailyFromModelRows(rows: readonly DayModelLike[], dates?: readonly string[]): DailyDetails[] {
  const map = new Map<string, Metrics>();
  for (const row of rows) {
    const current = map.get(row.local_date) ?? emptyMetrics();
    addMetrics(current, metricsOfModel(row));
    map.set(row.local_date, current);
  }
  const keys = dates ? [...dates] : [...map.keys()].sort();
  return keys.map((date) => {
    const m = map.get(date) ?? emptyMetrics();
    return { date, ...m, unknownTokens: 0 };
  });
}

function buildFacets(rows: readonly ModelLike[], groups: readonly ProviderAliasGroup[]): UsageFacets {
  const rawProviders = [...new Set(rows.map((row) => row.provider))].sort((a, b) => a.localeCompare(b));
  const models = [...new Set(rows.map((row) => row.model))].sort((a, b) => a.localeCompare(b));
  const pairMap = new Map<string, ProviderModelPair>();
  for (const row of rows) pairMap.set(row.provider + '\u0000' + row.model, { provider: row.provider, model: row.model });
  const groupOptions: ProviderOption[] = groups.map((group) => ({ type: 'group', value: group.id, label: group.label, rawValues: [...group.rawValues] }));
  const rawOptions: ProviderOption[] = rawProviders.map((provider) => ({ type: 'raw', value: provider, label: provider, rawValues: [provider] }));
  return {
    providers: [...groupOptions, ...rawOptions],
    models,
    pairs: [...pairMap.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)),
    groups: groups.map((group) => ({ id: group.id, label: group.label, rawValues: [...group.rawValues] })),
  };
}

function selectedProviderValues(scope: ProviderScope | null, groups: readonly ProviderAliasGroup[]): readonly string[] | undefined {
  if (scope === null) return undefined;
  if (scope.type === 'raw') return [scope.value];
  const group = groups.find((candidate) => candidate.id === scope.id);
  if (!group) throw new Error('provider-alias-not-found');
  return group.rawValues;
}

function normalizedFilters(input: UsageFilters | undefined, groups: readonly ProviderAliasGroup[]): { filters: UsageFilters; providerValues?: readonly string[]; group?: ProviderAliasGroup; active: boolean } {
  const provider = input?.provider ?? null;
  const model = input?.model == null || input.model.length === 0 ? null : input.model;
  const group = provider?.type === 'group' ? groups.find((candidate) => candidate.id === provider.id) : undefined;
  if (provider?.type === 'group' && !group) throw new Error('provider-alias-not-found');
  const filters: UsageFilters = { provider, model };
  return { filters, providerValues: selectedProviderValues(provider, groups), group, active: provider !== null || model !== null };
}

function rangeModelRows(store: DurableStore, range: InsightRange, now: number): ModelLike[] {
  if (range === 'all') return store.modelTotals();
  const dates = datesForRange(range, now)!;
  const selected = new Set(dates);
  if (range === '7d') return store.dayModelTotals().filter((row) => selected.has(row.local_date));
  return store.dayModelTotals(dates[0]);
}

function rangeDayModelRows(store: DurableStore, range: InsightRange, now: number): DayModelLike[] {
  if (range === 'all') return store.dayModelTotals();
  const dates = datesForRange(range, now)!;
  const selected = new Set(dates);
  return store.dayModelTotals().filter((row) => selected.has(row.local_date));
}

function unknownForRange(store: DurableStore, range: InsightRange, now: number): ExcludedUnclassified {
  if (range === 'all') {
    const global = store.globalAggregate();
    return { tokens: global?.unknown_tokens ?? 0, calls: global?.unknown_calls ?? 0 };
  }
  const selected = new Set(datesForRange(range, now));
  return store.dailyTotals().filter((row) => selected.has(row.local_date)).reduce<ExcludedUnclassified>((out, row) => ({ tokens: out.tokens + (row.unknown_tokens ?? 0), calls: out.calls + (row.unknown_calls ?? 0) }), { tokens: 0, calls: 0 });
}

export class DurableAggregator {
  private store: DurableStore; private now: () => number; private listeners = new Set<(s: SummaryValue) => void>(); private closed = false;
  constructor(store: DurableStore, opts: { now?: () => number } = {}) { this.store = store; this.now = opts.now ?? (() => Date.now()); }
  summary(): SummaryValue {
    const now = this.now(); const global = this.store.globalAggregate(); const todayDate = localDate(now); const yesterdayDate = datesEnding(now, 2)[0];
    const today = this.store.daily(todayDate); const yesterday = this.store.daily(yesterdayDate);
    return { todayTotal: today?.total_tokens ?? 0, todayDate, yesterdayTotal: yesterday?.total_tokens ?? 0, yesterdayDate, lifetimeTotal: global?.total_tokens ?? 0, recordCount: this.store.recordCount(), serverNow: todayDate };
  }
  insights(range: InsightRange, inputFilters: UsageFilters = {}): DetailsValue {
    const now = this.now();
    const groups = this.store.listProviderAliasGroups();
    const parsed = normalizedFilters(inputFilters, groups);
    const rangeDates = datesForRange(range, now);
    const rawModels = rangeModelRows(this.store, range, now);
    const facets = buildFacets(rawModels, groups);

    if (parsed.active) {
      const matches = (row: ModelLike) => (parsed.providerValues === undefined || parsed.providerValues.includes(row.provider)) && (parsed.filters.model === null || row.model === parsed.filters.model);
      const selectedModels = rawModels.filter(matches);
      const categories = sumModelMetrics(selectedModels);
      const selectedDaily = rangeDayModelRows(this.store, range, now).filter(matches);
      const excludedUnclassified = unknownForRange(this.store, range, now);
      return {
        range,
        ...(rangeDates ? { rangeStartDate: rangeDates[0], rangeEndDate: rangeDates[rangeDates.length - 1] } : {}),
        totalTokens: categories.totalTokens,
        categories,
        unknownTokens: 0,
        unknownCallCount: 0,
        daily: dailyFromModelRows(selectedDaily, rangeDates),
        models: modelDetailsOf(selectedModels, parsed.filters.provider ?? undefined, parsed.group),
        filters: parsed.filters,
        facets,
        excludedUnclassified,
      };
    }

    if (range === 'all') {
      const global = this.store.globalAggregate() ?? ({} as GlobalAggRow);
      return { range, totalTokens: global.total_tokens ?? 0, categories: metricsOf(global), unknownTokens: global.unknown_tokens ?? 0, unknownCallCount: global.unknown_calls ?? 0, daily: dailyToDetails(this.store.dailyTotals()), models: modelDetailsOf(this.store.modelTotals()), filters: parsed.filters, facets, excludedUnclassified: { tokens: 0, calls: 0 } };
    }
    if (range === '7d') {
      const dates = rangeDates!; const selected = new Set(dates); const allDaily = this.store.dailyTotals();
      const selectedDaily = allDaily.filter((d) => selected.has(d.local_date)).sort((a, b) => a.local_date < b.local_date ? -1 : 1);
      const dayModels = this.store.dayModelTotals().filter((m) => selected.has(m.local_date));
      return { range, rangeStartDate: dates[0], rangeEndDate: dates[dates.length - 1], totalTokens: selectedDaily.reduce((a, d) => a + d.total_tokens, 0), categories: sumCategories(selectedDaily), unknownTokens: selectedDaily.reduce((a, d) => a + (d.unknown_tokens ?? 0), 0), unknownCallCount: selectedDaily.reduce((a, d) => a + (d.unknown_calls ?? 0), 0), daily: dailyToDetails(selectedDaily), models: modelDetailsOf(mergeDayModelRows(dayModels)), filters: parsed.filters, facets, excludedUnclassified: { tokens: 0, calls: 0 } };
    }
    const target = rangeDates![0];
    const day = this.store.daily(target) ?? ({} as DailyAggRow); const dayModels = this.store.dayModelTotals(target);
    return { range, ...(range === 'yesterday' ? { rangeStartDate: target, rangeEndDate: target } : {}), totalTokens: day.total_tokens ?? 0, categories: { totalTokens: day.total_tokens ?? 0, inputTokens: day.input_tokens ?? 0, outputTokens: day.output_tokens ?? 0, cacheReadTokens: day.cache_read_tokens ?? 0, cacheWriteTokens: day.cache_write_tokens ?? 0, reasoningTokens: day.reasoning_tokens ?? 0, callCount: day.calls ?? 0 }, unknownTokens: day.unknown_tokens ?? 0, unknownCallCount: day.unknown_calls ?? 0, daily: dailyToDetails(this.store.dailyTotals()), models: modelDetailsOf(dayModels), filters: parsed.filters, facets, excludedUnclassified: { tokens: 0, calls: 0 } };
  }
  apply(records: readonly UsageRecord[]): number { if (this.closed) return 0; const o = this.store.apply(records); if (o.added + o.replaced > 0) this.notify(); return o.added + o.replaced; }
  get ready(): boolean { return !this.closed; }
  rebuildAggregates(): void { this.store.rebuildAggregates(); }
  verifyAggregates() { return this.store.verifyAggregates(); }
  subscribe(l: (s: SummaryValue) => void): () => void { this.listeners.add(l); try { l(this.summary()); } catch {} return () => { this.listeners.delete(l); }; }
  private notify(): void { const s = this.summary(); for (const l of [...this.listeners]) { try { l(s); } catch {} } }
  diagnostics(): Record<string, unknown> { const meta = this.store.readMeta(); const global = this.store.globalAggregate(); const split = this.store.provenanceSplit(); return { storageBackend: 'sqlite', storageSchemaVersion: meta?.storageSchemaVersion, migrationVersion: meta?.migrationVersion, migrationStatus: meta?.migrationStatus, recordGeneration: meta?.recordGeneration, aggregateGeneration: meta?.aggregateGeneration, lastAggregateRebuild: meta?.lastAggregateRebuild ?? undefined, recordCount: this.store.recordCount(), aggregateStatus: this.store.verifyAggregates().ok ? 'consistent' : 'stale', lifetimeTotal: global?.total_tokens ?? 0, liveRecordedTotal: split.live, historicalRecoveredTotal: split.historical, historicalRecoveredRecordCount: split.historicalCount, providerAliasGroupCount: this.store.listProviderAliasGroups().length, earliestRecordAt: this.store.earliestRecordAt() ?? undefined, latestRecordAt: this.store.latestRecordAt() ?? undefined }; }
  close(): void { if (this.closed) return; this.closed = true; this.listeners.clear(); this.store.close(); }
}

function mergeDayModelRows(rows: readonly DayModelAggRow[]): ModelLike[] {
  const map = new Map<string, ModelLike>();
  for (const row of rows) {
    const key = row.provider + '\u0000' + row.model;
    const current = map.get(key);
    if (!current) map.set(key, { provider: row.provider, model: row.model, total_tokens: row.total_tokens, input_tokens: row.input_tokens, output_tokens: row.output_tokens, cache_read_tokens: row.cache_read_tokens, cache_write_tokens: row.cache_write_tokens, reasoning_tokens: row.reasoning_tokens, calls: row.calls });
    else {
      current.total_tokens += row.total_tokens; current.input_tokens += row.input_tokens; current.output_tokens += row.output_tokens;
      current.cache_read_tokens += row.cache_read_tokens; current.cache_write_tokens += row.cache_write_tokens; current.reasoning_tokens += row.reasoning_tokens; current.calls += row.calls;
    }
  }
  return [...map.values()];
}
