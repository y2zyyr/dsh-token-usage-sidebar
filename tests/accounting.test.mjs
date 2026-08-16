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
// ── v1.0.1 shutdown persistence (P0) ────────────────────────────────────────
// BUG-REGRESSION: close() previously set closed=true BEFORE flush(), so a
// dirty ledger pending in the debounce window was never persisted. This test
// proves that applying usage and closing immediately (no manual flush) still
// persists the record across an aggregator restart.
test('shutdown: apply then immediate close() persists the dirty record', async () => {
  const store = new MemoryUsageStore();
  const agg = new UsageAggregator({ store, now: () => Date.parse('2026-08-16T12:00:00') });
  await agg.start();
  agg.apply([rec('shutdown:sess:1:0', 14174, DAY('2026-08-16'))]);
  // NO manual flush() — close must flush the pending debounce write.
  await agg.close();
  assert.equal(store.writes, 1, 'close must have flushed exactly once');
  const agg2 = new UsageAggregator({ store, now: () => Date.parse('2026-08-16T12:01:00') });
  await agg2.start();
  assert.equal(agg2.aggregate.lifetimeTotal, 14174, 'record survived shutdown');
  assert.equal(agg2.aggregate.recordCount, 1);
  await agg2.close();
});

test('shutdown: multiple close() calls are safe (no error, no double save drop)', async () => {
  const store = new MemoryUsageStore();
  const agg = new UsageAggregator({ store });
  await agg.start();
  agg.apply([rec('m:sess:1:0', 999, DAY('2026-08-16'))]);
  await agg.close();
  await agg.close(); // second close is a no-op
  assert.ok(true, 'no throw on repeated close');
  const agg2 = new UsageAggregator({ store });
  await agg2.start();
  assert.equal(agg2.aggregate.lifetimeTotal, 999);
  await agg2.close();
});

test('shutdown: concurrent flush + close do not race or double-save-drop', async () => {
  const store = new MemoryUsageStore();
  const agg = new UsageAggregator({ store });
  await agg.start();
  agg.apply([rec('c:sess:1:0', 5000, DAY('2026-08-16'))]);
  // Fire flush and close concurrently; whichever runs, the dirty write must land.
  await Promise.all([agg.flush(), agg.close()]);
  const agg2 = new UsageAggregator({ store });
  await agg2.start();
  assert.equal(agg2.aggregate.lifetimeTotal, 5000);
  await agg2.close();
});

test('shutdown: persist failure keeps dirty recoverable for a later flush', async () => {
  let failNext = true;
  const store = {
    writes: 0,
    async load() { return undefined; },
    async save() { if (failNext) { failNext = false; throw new Error('disk full'); } this.writes += 1; },
  };
  const agg = new UsageAggregator({ store });
  await agg.start();
  agg.apply([rec('f:sess:1:0', 2024, DAY('2026-08-16'))]);
  await agg.flush(); // save throws; dirty must remain set
  assert.equal(store.writes, 0, 'failed save did not count');
  await agg.flush(); // second flush retries and succeeds
  assert.equal(store.writes, 1, 'recoverable after transient failure');
  await agg.close();
});

test('shutdown: close() after a failed debounce flush does not lose data on retry', async () => {
  let value;
  let failNext = true;
  const store = {
    writes: 0,
    async load() { return value; },
    async save(l) { if (failNext) { failNext = false; throw new Error('temporary'); } value = l; this.writes += 1; },
  };
  const agg = new UsageAggregator({ store });
  await agg.start();
  agg.apply([rec('f2:sess:1:0', 31415, DAY('2026-08-16'))]);
  await agg.flush(); // transient failure: dirty restored
  assert.equal(store.writes, 0, 'failed save did not persist');
  await agg.close(); // flush-before-close retries and must persist
  assert.equal(store.writes, 1, 'close retried and wrote the recovered snapshot');
  const agg2 = new UsageAggregator({ store });
  await agg2.start();
  assert.equal(agg2.aggregate.lifetimeTotal, 31415, 'record survived failed-flush then close');
  await agg2.close();
});
// ── v1.0.1 ledger consistency invariants (§17) ─────────────────────────────
function assertLedgerInvariants(ledger, label) {
  const byIds = Object.keys(ledger.byId ?? {});
  assert.equal(ledger.recordCount, byIds.length, label + ': recordCount === byId.size');
  const sum = byIds.reduce((a, id) => a + ledger.byId[id], 0);
  assert.equal(ledger.lifetimeTotal, sum, label + ': lifetimeTotal === sum(byId)');
  assert.equal(ledger.lifetimeTotal, (ledger.liveRecordedTotal ?? 0) + (ledger.historicalRecoveredTotal ?? 0),
    label + ': lifetimeTotal === liveRecordedTotal + historicalRecoveredTotal');
  for (const map of [ledger.dayBy, ledger.seqBy, ledger.detailBy, ledger.src]) {
    for (const k of Object.keys(map ?? {})) {
      assert.ok(Object.prototype.hasOwnProperty.call(ledger.byId, k), label + ': ' + (map === ledger.src ? 'src' : 'map') + ' id ⊆ byId');
    }
  }
}

test('ledger invariants hold after sequential recording and replacement', () => {
  let l = emptyLedger();
  l = recordUsage(l, rec('s1:1:0', 1000, DAY('2026-08-16'), 1, { sourceType: 'live_event' }));
  l = recordUsage(l, rec('s1:1:1', 2000, DAY('2026-08-16'), 1, { sourceType: 'session_log' }));
  l = recordUsage(l, rec('s1:1:1', 2500, DAY('2026-08-16'), 9, { sourceType: 'session_log' })); // replace
  assertLedgerInvariants(l, 'after replacement');
});

test('foldRecords preserves the source-split invariant across enrichments', () => {
  const mk = (id, total, seq, st) => ({ ...rec(id, total, DAY('2026-08-16'), seq), sourceType: st });
  let l = foldRecords(emptyLedger(), [mk('s:1:0', 100, 5, 'session_log')]);
  l = foldRecords(l, [mk('s:1:0', 180, 9, 'session_log')]); // higher-seq enrichment
  assertLedgerInvariants(l, 'after session_log enrichment');
  assert.equal(l.liveRecordedTotal, 0);
  assert.equal(l.historicalRecoveredTotal, 180);
});

test('recomputeSourceSplit heals a stale cached split field', async () => {
  const { recomputeSourceSplit } = await import('../src/usage/ledger.ts');
  // Simulate drift: byId says 300 historical, but the cached field says 100.
  const l = {
    lifetimeTotal: 300,
    todayTotal: 300,
    todayDate: DAY('2026-08-16'),
    byId: { a: 100, b: 200 },
    recordCount: 2,
    src: { a: 'live_event', b: 'session_log' },
    liveRecordedTotal: 100,
    historicalRecoveredTotal: 100, // stale: should be 200
    historicalRecoveredRecordCount: 0, // stale: should be 1
    schemaVersion: 4,
  };
  const healed = recomputeSourceSplit(l);
  assert.equal(healed.liveRecordedTotal, 100);
  assert.equal(healed.historicalRecoveredTotal, 200);
  assert.equal(healed.historicalRecoveredRecordCount, 1);
  assertLedgerInvariants(healed, 'healed');
});
// ── v1.0.1 invalid-store / no-silent-reset (§18, §41) ──────────────────────
test('invalid persisted ledger reports invalid instead of silently resetting to 0', async () => {
  const rawCorrupt = { lifetimeTotal: 999999, todayTotal: 'not-a-number', byId: 42, recordCount: 7 };
  const store = {
    writes: 0,
    savedLedger: undefined,
    async load() { return { status: 'invalid' }; }, // store found a corrupt row
    async save(l) { this.savedLedger = l; this.writes += 1; },
  };
  const agg = new UsageAggregator({ store });
  await agg.start();
  // Must NOT present the corrupt totals; must surface invalid state.
  assert.equal(agg.diagnostics().loadStatus, 'invalid');
  assert.equal(agg.aggregate.lifetimeTotal, 0, 'in-memory totals start empty rather than echoing corrupt data');
  assert.equal(store.writes, 0, 'corrupt source is never overwritten by a silent reset');
  await agg.close();
});

test('absent ledger (none) starts fresh and is not mislabeled invalid', async () => {
  const store = {
    async load() { return undefined; }, // legacy shorthand: nothing persisted
    async save() {},
  };
  const agg = new UsageAggregator({ store });
  await agg.start();
  assert.equal(agg.diagnostics().loadStatus, 'none');
  assert.equal(agg.aggregate.lifetimeTotal, 0);
  await agg.close();
});

test('ok ledger loads normally with validate-outcome store', async () => {
  const ledger = { lifetimeTotal: 500, todayTotal: 500, todayDate: DAY('2026-08-16'), byId: { a: 500 }, recordCount: 1, schemaVersion: 4 };
  const store = {
    async load() { return { status: 'ok', ledger }; },
    async save() {},
  };
  const agg = new UsageAggregator({ store });
  await agg.start();
  assert.equal(agg.diagnostics().loadStatus, 'ok');
  assert.equal(agg.aggregate.lifetimeTotal, 500);
  await agg.close();
});
