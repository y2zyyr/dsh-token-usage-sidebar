// Provider-reported usage only. Reasoning is a subdivision of output.
import type { UsageRecord, UsageBuckets, UsageSourceType } from './types.ts';
import { currentLocalDate, totalOf } from './types.ts';
import { isTokenCount, isLocalDate } from './validation.ts';

export const ACCOUNTING_VERSION = 2;
export interface SessionEventLike {
  readonly type: string;
  readonly seq: number;
  readonly time?: number;
  readonly data?: Record<string, unknown>;
}
export interface FoldInput {
  sessionId: string;
  events: readonly SessionEventLike[];
  now?: number;
  provider?: string;
  model?: string;
  sourceType?: UsageSourceType;
  sourcePath?: string;
  migrationVersion?: number;
  inheritedEventCount?: number;
  onInvalidUsage?: () => void;
}

export function bucketsOf(data: Record<string, unknown> | undefined): UsageBuckets | undefined {
  const usage = data?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const fields = usage as Record<string, unknown>;
  if (!isTokenCount(fields.inputTokens) || !isTokenCount(fields.outputTokens)) return undefined;
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (fields[key] !== undefined && !isTokenCount(fields[key])) return undefined;
  }
  const buckets: UsageBuckets = {
    inputTokens: fields.inputTokens, outputTokens: fields.outputTokens,
    cacheReadTokens: fields.cacheReadTokens as number | undefined,
    cacheWriteTokens: fields.cacheWriteTokens as number | undefined,
    reasoningTokens: fields.reasoningTokens as number | undefined,
  };
  return isTokenCount(totalOf(buckets)) ? buckets : undefined;
}

export function modelSourceOf(data: Record<string, unknown> | undefined): { provider?: string; model?: string } {
  const message = data?.message;
  const source = message && typeof message === 'object' ? (message as Record<string, unknown>).source : undefined;
  if (!source || typeof source !== 'object') return {};
  const value = source as Record<string, unknown>;
  return {
    provider: typeof value.provider === 'string' && value.provider.length > 0 ? value.provider : undefined,
    model: typeof value.model === 'string' && value.model.length > 0 ? value.model : undefined,
  };
}

function streamUsage(data: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(data.stream)) return undefined;
  for (let i = data.stream.length - 1; i >= 0; i -= 1) {
    const record = data.stream[i];
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk;
  }
  return undefined;
}

export interface CollectorCheckpoint {
  lastSeq: number;
  /** Only the active step can be retried in an append-only DSH log. */
  activeStep?: { turn: number; step: number; retrySeq?: number };
}

/** Stateful live collector: explicit retry boundaries survive single-event delivery. */
export class SessionUsageCollector {
  private retrySlots = new Map<string, number>();
  private lastSeq = -1;
  private activeStep: CollectorCheckpoint['activeStep'];
  private input: Omit<FoldInput, 'events'>;
  constructor(input: Omit<FoldInput, 'events'>, checkpoint?: CollectorCheckpoint) {
    this.input = input;
    if (checkpoint) {
      this.lastSeq = checkpoint.lastSeq;
      this.activeStep = checkpoint.activeStep;
      if (checkpoint.activeStep?.retrySeq !== undefined) {
        this.retrySlots.set(checkpoint.activeStep.turn + ':' + checkpoint.activeStep.step, checkpoint.activeStep.retrySeq);
      }
    }
  }
  checkpoint(): CollectorCheckpoint { return { lastSeq: this.lastSeq, activeStep: this.activeStep }; }
  collect(events: readonly SessionEventLike[], sourceType = this.input.sourceType): UsageRecord[] {
    const best = new Map<string, UsageRecord>();
    for (const event of events) {
      if (!isTokenCount(event.seq) || event.seq <= this.lastSeq) continue;
      this.lastSeq = event.seq;
      if (event.seq < (this.input.inheritedEventCount ?? 0)) continue;
      const data = event.data ?? {};
      if (event.type === 'llm/retry-started') {
        if (isTokenCount(data.turn) && isTokenCount(data.step)) {
          const slot = data.turn + ':' + data.step;
          this.retrySlots.set(slot, event.seq);
          this.activeStep = { turn: data.turn, step: data.step, retrySeq: event.seq };
        }
        continue;
      }
      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt' && event.type !== 'assistant/chunk') continue;
      const sample = event.type === 'assistant/chunk'
        ? (data.chunk as Record<string, unknown> | undefined)
        : data.usage !== undefined ? data : streamUsage(data);
      if (event.type === 'assistant/chunk' && sample?.type !== 'usage') continue;
      // No provider accounting is a legitimate event, not a zero-token call.
      if (!sample || sample.usage === undefined) continue;
      const usage = bucketsOf(sample);
      const ts = data.timestamp ?? data.createdAt ?? event.time ?? this.input.now ?? Date.now();
      if (!usage || !isTokenCount(data.turn) || !isTokenCount(data.step) || !isTokenCount(ts)
        || !isLocalDate(currentLocalDate(ts)) || !this.input.sessionId) {
        this.input.onInvalidUsage?.();
        continue;
      }
      const { turn, step } = data;
      const slot = turn + ':' + step;
      const retrySeq = this.retrySlots.get(slot);
      this.activeStep = { turn, step, ...(retrySeq === undefined ? {} : { retrySeq }) };
      const source = modelSourceOf(data);
      const id = this.input.sessionId + ':' + slot + (retrySeq === undefined ? '' : ':retry:' + retrySeq);
      best.set(id, {
        id, sessionId: this.input.sessionId, turn, step, seq: event.seq, timestamp: ts,
        localDate: currentLocalDate(ts), source: event.type,
        provider: source.provider ?? this.input.provider, model: source.model ?? this.input.model,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens ?? 0, cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        reasoningTokens: usage.reasoningTokens ?? 0, totalTokens: totalOf(usage), accounting: 'exact',
        sourceType, sourcePath: this.input.sourcePath, migrationVersion: this.input.migrationVersion,
        accountingVersion: ACCOUNTING_VERSION,
      });
    }
    return [...best.values()];
  }
}

export function collectSessionUsage(input: FoldInput): readonly UsageRecord[] {
  const collector = new SessionUsageCollector(input);
  return collector.collect([...input.events].sort((a, b) => a.seq - b.seq));
}
