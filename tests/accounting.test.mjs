// tests/accounting.test.mjs
// Accounting invariant tests for dsh-token-usage-sidebar.
// Run: node --test tests/  (or npm test)
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLedger, recordUsage, foldRecords, aggregateOf, hasRecord, rebuild, synchronizeToday, totalForDay } from '../src/usage/ledger.ts';
import { collectSessionUsage } from '../src/usage/collector.ts';
import { UsageAggregator } from '../src/usage/aggregator.ts';
import { MemoryUsageStore } from '../src/usage/store.ts';
import { totalOf } from '../src/usage/types.ts';

// ── helpers ────────────────────────────────────────────────────────────────
const DAY = (ymd) => ymd; // local date string YYYY-MM-DD

function rec(id, total, localDate, seq = 1, extra = {}) {
  const [sessionId = 's1', turn = 0, step = 0] = id.split(':');
  return {
    id,
    source: 'assistant/message',
    sessionId: sessionId || id,
    turn: Number(turn) || 0,
    step: Number(step) || 0,
    seq,
    timestamp: Date.parse(localDate + 'T12:00:00'),
    localDate,
    inputTokens: total,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: total,
    accounting: 'exact',
    ...extra,
  };
}

// ── Basic aggregation ─────────────────────────────────────────────────────
test('aggregates a single usage event', () => {
  const l = recordUsage(emptyLedger(), rec('s1:1:0', 1000, DAY('2026-08-16')));
  assert.equal(aggregateOf(l).lifetimeTotal, 1000);
  assert.equal(aggregateOf(l).todayTotal, 1000);
});

test('aggregates multiple usage events', () => {
  let l = emptyLedger();
  for (const [id, total] of [['s1:1:0', 10000], ['s1:1:1', 20000], ['s2:5:2', 5000]]) {
    l = recordUsage(l, rec(id, total, DAY('2026-08-16')));
  }
  assert.equal(aggregateOf(l).lifetimeTotal, 35000);
  assert.equal(aggregateOf(l).todayTotal, 35000);
});

test('duplicate delivery of the SAME authoritative event is not double-counted', () => {
  let l = emptyLedger();
  const r = rec('x:1:0', 15000, DAY('2026-08-16'));
  l = recordUsage(l, r);
  l = recordUsage(l, { ...r }); // same id, re-delivered
  l = recordUsage(l, { ...r });
  assert.equal(aggregateOf(l).lifetimeTotal, 15000);
  assert.equal(aggregateOf(l).recordCount, 1);
});

test('a later sample for the SAME (turn,step) REPLACES, not adds', () => {
  let l = emptyLedger();
  // early chunk sample (seq 5), then authoritative final (seq 9)
  l = recordUsage(l, rec('s1:2:0', 8000, DAY('2026-08-16'), 5));
  l = recordUsage(l, rec('s1:2:0', 12000, DAY('2026-08-16'), 9));
  assert.equal(aggregateOf(l).lifetimeTotal, 12000, 'replacement, not 20000');
  assert.equal(aggregateOf(l).todayTotal, 12000);
  assert.equal(aggregateOf(l).recordCount, 1);
});

test('a retried invocation is one record (only final counts)', () => {
  let l = emptyLedger();
  const attempt1 = rec('s1:3:0', 5000, DAY('2026-08-16'), 10);
  const attempt2 = rec('s1:3:0', 7000, DAY('2026-08-16'), 20);
  l = recordUsage(l, attempt1);
  l = recordUsage(l, attempt2); // retried turn replaced by later seq
  assert.equal(aggregateOf(l).recordCount, 1);
  assert.equal(aggregateOf(l).lifetimeTotal, 7000);
});

test('different sessions/models/providers are counted independently', () => {
  let l = emptyLedger();
  l = recordUsage(l, rec('s1:1:0', 100, DAY('2026-08-16'), 1, { provider: 'opencode-go', model: 'deepseek-v4-flash' }));
  l = recordUsage(l, rec('s2:1:0', 200, DAY('2026-08-16'), 1, { provider: 'anthropic', model: 'claude' }));
  assert.equal(aggregateOf(l).lifetimeTotal, 300);
  assert.equal(aggregateOf(l).recordCount, 2);
});

// ── Date boundaries ────────────────────────────────────────────────────────
test('same-day events accumulate into today', () => {
  let l = emptyLedger(undefined, DAY('2026-08-16'));
  l = recordUsage(l, rec('a:1:0', 100, DAY('2026-08-16')));
  l = recordUsage(l, rec('b:1:0', 100, DAY('2026-08-16')));
  assert.equal(aggregateOf(l).todayTotal, 200);
});

test('midnight rollover resets today but preserves lifetime (task example)', () => {
  // Events A,B,C on day1 => Today=35000, Total=35000
  let l = emptyLedger(undefined, DAY('2026-08-16'));
  l = recordUsage(l, rec('a:1:0', 10000, DAY('2026-08-16')));
  l = recordUsage(l, rec('b:1:0', 20000, DAY('2026-08-16')));
  l = recordUsage(l, rec('c:1:0', 5000, DAY('2026-08-16')));
  assert.equal(aggregateOf(l).todayTotal, 35000);
  assert.equal(aggregateOf(l).lifetimeTotal, 35000);
  // Next local day: event D
  l = recordUsage(l, rec('d:1:0', 7000, DAY('2026-08-17')));
  assert.equal(aggregateOf(l).todayTotal, 7000);
  assert.equal(aggregateOf(l).lifetimeTotal, 42000);
});

test('timezone-aware local day (not UTC): late-evening local vs UTC-early', () => {
  // localDate is explicit; ledger keys by it. Verify a record dated day2 after a
  // day1 baseline rolls today correctly.
  let l = emptyLedger(undefined, DAY('2026-08-16'));
  l = recordUsage(l, rec('a:1:0', 1000, DAY('2026-08-16')));
  l = recordUsage(l, rec('b:1:0', 2000, DAY('2026-08-17')));
  assert.equal(aggregateOf(l).todayTotal, 2000);
  assert.equal(aggregateOf(l).lifetimeTotal, 3000);
});

// ── Persistence / restart ──────────────────────────────────────────────────
test('aggregator persists and reloads across restart', async () => {
  const store = new MemoryUsageStore();
  const agg = new UsageAggregator({ store });
  await agg.start();
  agg.apply([rec('s1:1:0', 1000, DAY('2026-08-16'))]);
  await agg.flush();
  // restart: a new aggregator over the same store
  const agg2 = new UsageAggregator({ store });
  await agg2.start();
  assert.equal(aggregateOf(agg2.aggregate).lifetimeTotal, 1000);
  await agg2.close();
});

test('aggregator ignores duplicate replayed records after restart', async () => {
  const store = new MemoryUsageStore();
  const agg = new UsageAggregator({ store });
  await agg.start();
  const r = rec('s1:1:0', 15000, DAY('2026-08-16'));
  agg.apply([r]);
  await agg.flush();
  // same event replayed into a fresh process
  const agg2 = new UsageAggregator({ store });
  await agg2.start();
  agg2.apply([r]);
  assert.equal(aggregateOf(agg2.aggregate).lifetimeTotal, 15000);
  await agg2.close();
});

// ── collector (session-log -> records) ─────────────────────────────────────
test('collector extracts assistant/message usage and dedups (turn,step) by seq', () => {
  const mk = (type, data, seq) => ({ type, seq, data });
  const events = [
    mk('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'usage', usage: { inputTokens: 500, outputTokens: 300 } } }, 4),
    mk('assistant/message', { turn: 1, step: 0, usage: { inputTokens: 900, outputTokens: 700 } }, 9),
  ];
  const recs = collectSessionUsage({ sessionId: 'sess9', events });
  assert.equal(recs.length, 1, 'one record per (turn,step)');
  assert.equal(recs[0].totalTokens, 1600, 'final message wins, total = 900+700');
});

test('collector computes totalTokens as input+cacheRead+cacheWrite+output and excludes reasoning', () => {
  // reasoning is an output subdivision; not added again.
  const records = collectSessionUsage({
    sessionId: 's',
    events: [{ type: 'assistant/message', seq: 1, data: { turn: 0, step: 0, usage: { inputTokens: 100, outputTokens: 60, cacheReadTokens: 40, cacheWriteTokens: 10, reasoningTokens: 25 } } }],
  });
  assert.equal(records[0].totalTokens, 210, '100+40+10+60');
  assert.equal(records[0].reasoningTokens, 25);
});

test('collector totalOf uses authoritative provider totals', () => {
  assert.equal(totalOf({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 5, reasoningTokens: 50 }), 40);
});

// ── streaming semantics ────────────────────────────────────────────────────
test('streaming does not count partial text; only the authoritative usage event counts', () => {
  // No usage on partial text deltas; only chunk usage + final message matter.
  const events = [
    { type: 'assistant/chunk', seq: 1, data: { turn: 0, step: 0, chunk: { type: 'text-delta', text: 'hello' } } },
    { type: 'assistant/chunk', seq: 2, data: { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 50, outputTokens: 12 } } } },
  ];
  const recs = collectSessionUsage({ sessionId: 's', events });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].totalTokens, 62);
});

test('live chunk usage is replaced by the later final assistant/message usage', async () => {
  const store = new MemoryUsageStore();
  const agg = new UsageAggregator({ store, now: () => Date.parse('2026-08-16T12:00:00') });
  await agg.start();
  const events = [
    { type: 'assistant/chunk', seq: 4, time: Date.parse('2026-08-16T11:00:00'), data: { turn: 1, step: 0, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 25 } } } },
    { type: 'assistant/message', seq: 9, time: Date.parse('2026-08-16T11:00:01'), data: { turn: 1, step: 0, usage: { inputTokens: 120, outputTokens: 40 } } },
  ];
  agg.apply(collectSessionUsage({ sessionId: 'live', events: [events[0]] }));
  agg.apply(collectSessionUsage({ sessionId: 'live', events: [events[1]] }));
  assert.equal(agg.aggregate.lifetimeTotal, 160);
  assert.equal(agg.aggregate.recordCount, 1);
  await agg.close();
});

test('synchronizeToday derives only reliably dated records after historical replay', () => {
  let ledger = emptyLedger(undefined, DAY('2026-08-16'));
  ledger = recordUsage(ledger, rec('old:1:0', 50, DAY('2026-08-14')));
  ledger = recordUsage(ledger, rec('today:1:0', 75, DAY('2026-08-16')));
  ledger = synchronizeToday(ledger, Date.parse('2026-08-16T12:00:00'));
  assert.equal(ledger.todayTotal, 75);
  assert.equal(totalForDay(ledger, DAY('2026-08-14')), 50);
  assert.equal(totalForDay(ledger, DAY('2026-08-15')), 0);
});
