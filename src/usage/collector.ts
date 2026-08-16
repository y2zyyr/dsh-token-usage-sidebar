// src/usage/collector.ts
// Translate durable session-log events into authoritative UsageRecords.
//
// Source of truth (DSH):
//   assistant/message.data.usage   -- final committed TokenUsage for (turn, step)
//   assistant/chunk (chunk.type='usage').usage -- early stream sample for (turn, step)
// Both carry disjoint buckets; reasoning is an OUTPUT subdivision and is never
// added again. total = input + cacheRead + cacheWrite + output.
import type { UsageRecord, UsageBuckets, UsageSourceType } from './types.ts';
import { totalOf } from './types.ts';

export interface SessionEventLike {
  readonly type: string;
  readonly seq: number;
  /** Durable session-event wall-clock time, preserved by readFrom(). */
  readonly time?: number;
  readonly data?: Record<string, unknown>;
}

export interface FoldInput {
  sessionId: string;
  events: readonly SessionEventLike[];
  now?: number;
  provider?: string;
  model?: string;
  /** v0.2 provenance: recorder of these events. */
  sourceType?: UsageSourceType;
  sourcePath?: string;
  migrationVersion?: number;
}

export function bucketsOf(data: Record<string, unknown> | undefined): UsageBuckets | undefined {
  if (!data) return undefined;
  const usage = data.usage as Partial<UsageBuckets> | undefined;
  if (!usage || typeof usage !== 'object') return undefined;
  const inputTokens = Number(usage.inputTokens);
  const outputTokens = Number(usage.outputTokens);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) || inputTokens < 0 || outputTokens < 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: Number.isFinite(Number(usage.cacheReadTokens)) ? Number(usage.cacheReadTokens) : undefined,
    cacheWriteTokens: Number.isFinite(Number(usage.cacheWriteTokens)) ? Number(usage.cacheWriteTokens) : undefined,
    reasoningTokens: Number.isFinite(Number(usage.reasoningTokens)) ? Number(usage.reasoningTokens) : undefined,
  };
}

/** Extract the source selected by DSH for a final assistant message. */
export function modelSourceOf(data: Record<string, unknown> | undefined): { provider?: string; model?: string } {
  const source = data?.message && typeof data.message === 'object'
    ? (data.message as Record<string, unknown>).source
    : undefined;
  if (!source || typeof source !== 'object') return {};
  const record = source as Record<string, unknown>;
  const provider = typeof record.provider === 'string' && record.provider.length > 0 ? record.provider : undefined;
  const model = typeof record.model === 'string' && record.model.length > 0 ? record.model : undefined;
  return { provider, model };
}

/**
 * Collect every authoritative usage event from a session log into UsageRecords.
 * Emits one record per distinct (turn, step) usage sample; for a given id the
 * later (higher-seq) record supersedes the earlier, so folding the collector's
 * output into the ledger is exactly-once.
 */
export function collectSessionUsage(input: FoldInput): readonly UsageRecord[] {
  const recs: UsageRecord[] = [];
  const now = input.now ?? Date.now();
  const day = new Date(now);
  const y = day.getFullYear();
  const m = String(day.getMonth() + 1).padStart(2, '0');
  const dd = String(day.getDate()).padStart(2, '0');
  const localDate = y + '-' + m + '-' + dd;
  const local = (ts: number) => {
    const d = new Date(ts);
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd2 = String(d.getDate()).padStart(2, '0');
    return yy + '-' + mm + '-' + dd2;
  };
  for (const event of input.events) {
    let usage: UsageBuckets | undefined;
    let turn = 0;
    let step = 0;
    let source: 'assistant/message' | 'assistant/chunk';
    let provider = input.provider;
    let model = input.model;
    let ts = now;
    // DSH durable events carry the wall-clock at event top level as `time`.
    const eventTime = Number((event as unknown as { time?: number }).time) || 0;
    if (event.type === 'assistant/message') {
      const data = event.data ?? {};
      usage = bucketsOf(data);
      if (usage === undefined) continue;
      turn = Number(data.turn ?? 0);
      step = Number(data.step ?? 0);
      source = 'assistant/message';
      const messageSource = modelSourceOf(data);
      provider = messageSource.provider ?? provider;
      model = messageSource.model ?? model;
      ts = Number(data.timestamp) || Number(data.createdAt) || eventTime || now;
    } else if (event.type === 'assistant/chunk') {
      const data = event.data ?? {};
      const chunk = data.chunk as { type?: string; usage?: Partial<UsageBuckets> } | undefined;
      if (!chunk || chunk.type !== 'usage' || !chunk.usage) continue;
      usage = {
        inputTokens: Number(chunk.usage.inputTokens) || 0,
        outputTokens: Number(chunk.usage.outputTokens) || 0,
        cacheReadTokens: Number(chunk.usage.cacheReadTokens) || undefined,
        cacheWriteTokens: Number(chunk.usage.cacheWriteTokens) || undefined,
        reasoningTokens: Number(chunk.usage.reasoningTokens) || undefined,
      };
      if (totalOf(usage) === 0) continue;
      turn = Number(data.turn ?? 0);
      step = Number(data.step ?? 0);
      source = 'assistant/chunk';
      ts = Number(data.timestamp) || eventTime || now;
    } else {
      continue;
    }
    const total = totalOf(usage);
    recs.push({
      id: input.sessionId + ':' + turn + ':' + step,
      source,
      sessionId: input.sessionId,
      turn,
      step,
      seq: event.seq,
      timestamp: ts,
      localDate: local(ts),
      provider,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
      totalTokens: total,
      accounting: 'exact' as const,
      sourceType: input.sourceType,
      sourcePath: input.sourcePath,
      migrationVersion: input.migrationVersion,
    });
  }
  // Keep the highest-seq record per id (final authoritative per (turn,step)).
  const best = new Map<string, UsageRecord>();
  for (const r of recs) {
    const prev = best.get(r.id);
    if (prev === undefined || r.seq > prev.seq) best.set(r.id, r);
  }
  return [...best.values()].sort((a, b) => a.seq - b.seq);
}
