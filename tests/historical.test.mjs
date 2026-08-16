// tests/historical.test.mjs
// v0.2 historical-recovery and migration-safety tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { collectSessionUsage } from '../src/usage/collector.ts';
import { emptyLedger, recordUsage, hasRecord } from '../src/usage/ledger.ts';
import { runHistoricalMigration } from '../src/usage/historical.ts';
import { UsageAggregator } from '../src/usage/aggregator.ts';
import { MemoryUsageStore } from '../src/usage/store.ts';
import { currentLocalDate } from '../src/usage/types.ts';

function writeSessionDir(sessionsRoot, sessionId, events) {
  const dir = join(sessionsRoot, 'ws_' + sessionId, sessionId);
  mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: 'session', version: 0, id: sessionId })];
  for (const ev of events) lines.push(JSON.stringify(ev));
  writeFileSync(join(dir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')));
}
function msg(sessionId, turn, step, seq, usage) {
  return { type: 'assistant/message', seq, time: Date.now(), data: { turn, step, usage } };
}

test('same invocation in session log AND already-live ledger is counted once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dts-'));
  const sid = 'sess1';
  let ledger = emptyLedger();
  ledger = recordUsage(ledger, { id: sid + ':1:0', source: 'assistant/message', sessionId: sid, turn: 1, step: 0, seq: 9, timestamp: Date.now(), localDate: currentLocalDate(), inputTokens: 10000, outputTokens: 5000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 15000, accounting: 'exact', sourceType: 'live_event' });
  assert.equal(ledger.lifetimeTotal, 15000);
  assert.equal(ledger.liveRecordedTotal, 15000);
  writeSessionDir(root, sid, [ msg(sid, 1, 0, 9, { inputTokens: 10000, outputTokens: 5000, cacheReadTokens: 0 }) ]);
  const res = await runHistoricalMigration(ledger, { sessionsDir: root });
  assert.equal(res.ledger.lifetimeTotal, 15000, 'no double count');
  assert.equal(res.ledger.recordCount, 1);
  assert.equal(res.ledger.liveRecordedTotal, 15000);
  assert.equal(res.ledger.historicalRecoveredTotal, 0, 'overlapped record stays live');
  rmSync(root, { recursive: true, force: true });
});

test('distinct session-log invocations are recovered and counted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dts-'));
  writeSessionDir(root, 'sessA', [ msg('sessA', 1, 0, 1, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100 }) ]);
  writeSessionDir(root, 'sessB', [ msg('sessB', 2, 0, 3, { inputTokens: 2000, outputTokens: 700, cacheReadTokens: 0 }) ]);
  const res = await runHistoricalMigration(emptyLedger(), { sessionsDir: root });
  assert.equal(res.ledger.lifetimeTotal, 4300);
  assert.equal(res.ledger.recordCount, 2);
  assert.equal(res.ledger.historicalRecoveredTotal, 4300);
  assert.equal(res.ledger.liveRecordedTotal, 0);
  assert.equal(res.summary.migrated, true);
  rmSync(root, { recursive: true, force: true });
});

test('historical migration is restart-safe (3 runs, same lifetime total)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dts-'));
  writeSessionDir(root, 'sessA', [ msg('sessA', 1, 0, 1, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100 }) ]);
  writeSessionDir(root, 'sessB', [ msg('sessB', 2, 0, 3, { inputTokens: 2000, outputTokens: 700, cacheReadTokens: 0 }) ]);
  let ledger = emptyLedger();
  for (let i = 0; i < 3; i++) {
    const res = await runHistoricalMigration(ledger, { sessionsDir: root });
    ledger = res.ledger;
    assert.equal(ledger.lifetimeTotal, 4300, 'run ' + (i + 1) + ' must stay 4300');
  }
  rmSync(root, { recursive: true, force: true });
});

test('v0.1 ledger upgrade retains existing records and adds new history (no reset)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dts-'));
  const v01 = { lifetimeTotal: 10000, todayTotal: 10000, todayDate: currentLocalDate(), byId: { 'old:1:0': 10000 }, recordCount: 1 };
  writeSessionDir(root, 'sessNew', [ msg('sessNew', 1, 0, 2, { inputTokens: 3000, outputTokens: 1000, cacheReadTokens: 0 }) ]);
  const res = await runHistoricalMigration(v01, { sessionsDir: root });
  assert.equal(res.ledger.recordCount, 2, 'existing 1 + new 1');
  assert.equal(res.ledger.lifetimeTotal, 14000, '10000 + 4000');
  assert.ok(hasRecord(res.ledger, 'old:1:0'), 'existing record preserved');
  assert.ok(hasRecord(res.ledger, 'sessNew:1:0'), 'new history added');
  assert.equal(res.ledger.schemaVersion, 3);
  rmSync(root, { recursive: true, force: true });
});

test('compaction summary does not cause double-count (usage events win)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dts-'));
  const sid = 'sessC';
  writeSessionDir(root, sid, [
    msg(sid, 1, 0, 1, { inputTokens: 5000, outputTokens: 2000, cacheReadTokens: 1000 }),
    { type: 'compaction/start', seq: 10, data: { compactionId: 'c1', turn: 1 } },
    { type: 'compaction/summary', seq: 11, data: { compactionId: 'c1', summary: [{ type: 'text', text: 'summary' }] } },
    { type: 'compaction/end', seq: 12, data: { compactionId: 'c1', turn: 1 } },
  ]);
  const res = await runHistoricalMigration(emptyLedger(), { sessionsDir: root });
  assert.equal(res.ledger.lifetimeTotal, 8000, 'compaction summary adds nothing');
  assert.equal(res.ledger.recordCount, 1);
  rmSync(root, { recursive: true, force: true });
});

test('aggregator.migrateHistorical persists and is idempotent across reload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dts-'));
  writeSessionDir(root, 'sessA', [ msg('sessA', 1, 0, 1, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100 }) ]);
  const store = new MemoryUsageStore();
  const agg = new UsageAggregator({ store, sessionsDir: root });
  await agg.start();
  await agg.migrateHistorical();
  await agg.flush();
  assert.equal(agg.aggregate.lifetimeTotal, 1600);
  const agg2 = new UsageAggregator({ store, sessionsDir: root });
  await agg2.start();
  await agg2.migrateHistorical();
  assert.equal(agg2.aggregate.lifetimeTotal, 1600);
  await agg2.close();
  rmSync(root, { recursive: true, force: true });
});

test('historical timestamps are retained for diagnostics and daily buckets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dts-'));
  const first = Date.parse('2026-08-14T23:30:00');
  const last = Date.parse('2026-08-15T00:30:00');
  writeSessionDir(root, 'early', [{ type: 'assistant/message', seq: 1, time: first, data: { turn: 1, step: 0, usage: { inputTokens: 100, outputTokens: 20 } } }]);
  writeSessionDir(root, 'late', [{ type: 'assistant/message', seq: 1, time: last, data: { turn: 1, step: 0, usage: { inputTokens: 200, outputTokens: 30 } } }]);
  const res = await runHistoricalMigration(emptyLedger(), { sessionsDir: root, now: Date.parse('2026-08-16T12:00:00') });
  assert.equal(res.summary.earliestRecoveredAt, first);
  assert.equal(res.summary.latestRecoveredAt, last);
  assert.equal(res.ledger.dayBy['early:1:0'], '2026-08-14');
  assert.equal(res.ledger.dayBy['late:1:0'], '2026-08-15');
  rmSync(root, { recursive: true, force: true });
});

test('v0.2 rows are enriched by the v3 replay without lifetime inflation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dts-'));
  const timestamp = Date.parse('2026-08-14T12:00:00');
  writeSessionDir(root, 'known', [{ type: 'assistant/message', seq: 5, time: timestamp, data: { turn: 1, step: 0, usage: { inputTokens: 100, outputTokens: 20 } } }]);
  const v02 = { lifetimeTotal: 120, todayTotal: 120, todayDate: '2026-08-16', byId: { 'known:1:0': 120 }, recordCount: 1, schemaVersion: 2, recovery: { recoveryStatus: 'complete' } };
  const res = await runHistoricalMigration(v02, { sessionsDir: root, now: Date.parse('2026-08-16T12:00:00') });
  assert.equal(res.ledger.lifetimeTotal, 120);
  assert.equal(res.ledger.recordCount, 1);
  assert.equal(res.ledger.dayBy['known:1:0'], '2026-08-14');
  rmSync(root, { recursive: true, force: true });
});
