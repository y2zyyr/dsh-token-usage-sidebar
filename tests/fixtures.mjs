import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableStore } from '../src/usage/durable/durableStore.ts';

export const NOW = new Date(2026, 9, 1, 12).getTime();
export const DAY = '2026-10-01';
export const tick = () => new Promise((resolve) => setImmediate(resolve));
export function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dtsu-regression-'));
  const path = join(dir, 'usage.sqlite');
  return { dir, path, store: new DurableStore({ path, now: () => NOW }) };
}
export function record(id, totalTokens, extra = {}) {
  const match = /^(.*):(\d+):(\d+)(?::retry:\d+)?$/.exec(id);
  return { id, sessionId: match?.[1] ?? id, turn: Number(match?.[2] ?? 1), step: Number(match?.[3] ?? 0),
    source: 'assistant/message', seq: 1, timestamp: NOW, localDate: DAY, provider: 'synthetic', model: 'model',
    inputTokens: totalTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    totalTokens, accounting: 'exact', sourceType: 'live_event', ...extra };
}
export function usageEvent(seq, tokens, extra = {}) {
  return { type: 'assistant/message', seq, time: NOW, data: { turn: 1, step: 0,
    message: { source: { provider: 'synthetic', model: 'model' } }, usage: { inputTokens: tokens, outputTokens: 0 }, ...extra } };
}
export function attempt(seq, tokens) {
  return { type: 'assistant/attempt', seq, time: NOW, data: { turn: 1, step: 0,
    stream: [{ type: 'chunk', time: NOW, chunk: { type: 'usage', usage: { inputTokens: tokens, outputTokens: 0 } } }] } };
}
export const retry = (seq) => ({ type: 'llm/retry-started', seq, time: NOW, data: { turn: 1, step: 0 } });
export function v1(records) {
  const byId = {}, detailBy = {}, dayBy = {}, seqBy = {}, src = {};
  for (const value of records) {
    byId[value.id] = value.totalTokens; dayBy[value.id] = value.localDate; seqBy[value.id] = value.seq; src[value.id] = value.sourceType;
    detailBy[value.id] = { inputTokens: value.inputTokens, outputTokens: value.outputTokens, cacheReadTokens: value.cacheReadTokens,
      cacheWriteTokens: value.cacheWriteTokens, reasoningTokens: value.reasoningTokens, provider: value.provider, model: value.model };
  }
  return { lifetimeTotal: records.reduce((sum, value) => sum + value.totalTokens, 0), recordCount: records.length, byId, detailBy, dayBy, seqBy, src };
}
export function persistenceV2(sessions, options = {}) {
  const reads = [], closed = [], opened = [];
  return {
    name: options.name,
    reads, closed, opened,
    async list() { if (options.listError) throw new Error('synthetic private read error'); return sessions.map((session) => ({ header: session.header ?? { id: session.id }, eventCount: session.events.length, revision: session.revision, sizeBytes: session.sizeBytes })); },
    async open(id, access) {
      if (access !== 'read') throw new Error('unexpected write ownership');
      const session = sessions.find((item) => item.id === id);
      if (!session) throw new Error('synthetic missing session');
      opened.push(id);
      return {
        header: session.header ?? { id }, inheritedEventCount: session.inheritedEventCount ?? 0,
        async read(offset = 0, length = session.events.length) {
          reads.push({ id, offset, length });
          if (options.readError === id) throw new Error('private prompt text must not reach diagnostics');
          if (options.beforeRead) await options.beforeRead(id, offset);
          return { events: session.events.slice(offset, offset + length) };
        },
        async close() { closed.push(id); },
      };
    },
  };
}
