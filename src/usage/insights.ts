// Privacy-preserving aggregate views for the Token Usage settings page.
// Only aggregated data crosses the local browser API boundary.
import type { LedgerState, UsageDetail } from './ledger.ts';
import { localDate } from './ledger.ts';

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

function emptyMetrics(): UsageMetrics {
  return { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, callCount: 0 };
}

function addDetail(metrics: UsageMetrics, detail: UsageDetail): void {
  metrics.inputTokens += detail.inputTokens;
  metrics.outputTokens += detail.outputTokens;
  metrics.cacheReadTokens += detail.cacheReadTokens;
  metrics.cacheWriteTokens += detail.cacheWriteTokens;
  metrics.reasoningTokens += detail.reasoningTokens;
  metrics.totalTokens += detail.inputTokens + detail.outputTokens + detail.cacheReadTokens + detail.cacheWriteTokens;
  metrics.callCount += 1;
}

function datesEnding(now: number, days: number): string[] {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const cursor = new Date(d);
    cursor.setDate(cursor.getDate() - i);
    dates.push(localDate(cursor.getTime()));
  }
  return dates;
}

export function lastSevenLocalDates(now = Date.now()): string[] { return datesEnding(now, 7); }

function datesForRange(range: InsightRange, now: number): string[] | undefined {
  if (range === 'all') return undefined;
  if (range === 'today') return datesEnding(now, 1);
  if (range === 'yesterday') {
    const yesterday = new Date(now);
    yesterday.setHours(12, 0, 0, 0);
    yesterday.setDate(yesterday.getDate() - 1);
    return [localDate(yesterday.getTime())];
  }
  return datesEnding(now, 7);
}

/** Build all selected aggregations without exposing ledger entries. */
export function buildUsageInsights(ledger: LedgerState, range: InsightRange, now = Date.now()): UsageInsights {
  const selectedDates = datesForRange(range, now);
  const selected = selectedDates ? new Set(selectedDates) : undefined;
  const daily = new Map<string, DailyUsage>();
  for (const date of lastSevenLocalDates(now)) daily.set(date, { date, ...emptyMetrics(), unknownTokens: 0 });
  const categories = emptyMetrics();
  const modelMap = new Map<string, ModelUsage>();
  let totalTokens = 0;
  let unknownTokens = 0;
  let unknownCallCount = 0;
  const dayBy = ledger.dayBy ?? {};
  const detailBy = ledger.detailBy ?? {};

  for (const [id, authoritativeTotal] of Object.entries(ledger.byId)) {
    const date = dayBy[id];
    // Undated legacy entries are valid for All time only; do not fabricate a day.
    if (selected && (date === undefined || !selected.has(date))) continue;
    totalTokens += authoritativeTotal;
    const detail = detailBy[id];
    const recoveredTotal = detail
      ? detail.inputTokens + detail.outputTokens + detail.cacheReadTokens + detail.cacheWriteTokens
      : -1;
    const isExact = detail !== undefined && recoveredTotal === authoritativeTotal;
    const day = date ? daily.get(date) : undefined;
    if (!isExact) {
      unknownTokens += authoritativeTotal;
      unknownCallCount += 1;
      if (day) day.unknownTokens += authoritativeTotal;
      continue;
    }
    addDetail(categories, detail);
    if (day) addDetail(day, detail);
    const provider = detail.provider ?? 'Unknown provider';
    const model = detail.model ?? 'Unknown model';
    const key = provider + '\u0000' + model;
    let modelUsage = modelMap.get(key);
    if (!modelUsage) {
      modelUsage = { provider, model, ...emptyMetrics() };
      modelMap.set(key, modelUsage);
    }
    addDetail(modelUsage, detail);
  }

  return {
    range,
    ...(selectedDates ? { rangeStartDate: selectedDates[0], rangeEndDate: selectedDates[selectedDates.length - 1] } : {}),
    totalTokens,
    categories,
    unknownTokens,
    unknownCallCount,
    daily: [...daily.values()],
    models: [...modelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)),
  };
}
