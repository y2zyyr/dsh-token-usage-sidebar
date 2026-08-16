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
import { runHistoricalMigration, parseSessionLog } from '../src/usage/historical.ts';
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
function msg(sessionId, turn, step, seq, usage, source) {
  return { type: 'assistant/message', seq, time: Date.now(), data: { turn, step, usage, ...(source ? { message: { source } } : {}) } };
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
  writeSessionDir(root, 'sessA', [ msg('sessA', 1, 0, 1, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100 }, { provider: 'deepseek', model: 'v4' }) ]);
  writeSessionDir(root, 'sessB', [ msg('sessB', 2, 0, 3, { inputTokens: 2000, outputTokens: 700, cacheReadTokens: 0 }) ]);
  const res = await runHistoricalMigration(emptyLedger(), { sessionsDir: root });
  assert.equal(res.ledger.lifetimeTotal, 4300);
  assert.equal(res.ledger.recordCount, 2);
  assert.equal(res.ledger.historicalRecoveredTotal, 4300);
  assert.equal(res.ledger.liveRecordedTotal, 0);
  assert.equal(res.ledger.detailBy['sessA:1:0'].provider, 'deepseek');
  assert.equal(res.ledger.detailBy['sessA:1:0'].model, 'v4');
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
  assert.equal(res.ledger.schemaVersion, 4);
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

test('v0.2 rows are enriched by the v1.0 replay without lifetime inflation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dts-'));
  const timestamp = Date.parse('2026-08-14T12:00:00');
  writeSessionDir(root, 'known', [{ type: 'assistant/message', seq: 5, time: timestamp, data: { turn: 1, step: 0, usage: { inputTokens: 100, outputTokens: 20 } } }]);
  const v02 = { lifetimeTotal: 120, todayTotal: 120, todayDate: '2026-08-16', byId: { 'known:1:0': 120 }, recordCount: 1, schemaVersion: 2, recovery: { recoveryStatus: 'complete' } };
  const res = await runHistoricalMigration(v02, { sessionsDir: root, now: Date.parse('2026-08-16T12:00:00') });
  assert.equal(res.ledger.lifetimeTotal, 120);
  assert.equal(res.ledger.recordCount, 1);
  assert.equal(res.ledger.dayBy['known:1:0'], '2026-08-14');
  assert.deepEqual(res.ledger.detailBy['known:1:0'], {
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    provider: undefined, model: undefined,
  });
  rmSync(root, { recursive: true, force: true });
});
// ── v1.0.1 historical scan-status / coverage semantics ─────────────────────
// A sourceScanStatus-derived read failure must NEVER produce 'complete'.

test('partial scan (one of three sessions fails to read) yields sourceScanStatus partial, not complete', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dts-'));
  writeSessionDir(root, 'sessA', [ msg('sessA', 1, 0, 1, { inputTokens: 1000, outputTokens: 500 }) ]);
  writeSessionDir(root, 'sessC', [ msg('sessC', 1, 0, 5, { inputTokens: 3000, outputTokens: 900 }) ]);
  const reader = {
    async list() {
      return [
        { id: 'sessA', path: join(root, 'ws_sessA', 'sessA', 'session.jsonl.zstd') },
        { id: 'sessBAD', path: '/nonexistent/session.jsonl.zstd' },
        { id: 'sessC', path: join(root, 'ws_sessC', 'sessC', 'session.jsonl.zstd') },
      ];
    },
    async readEvents(id) {
      if (id === 'sessBAD') throw new Error('corrupt log');
      const found = join(root, 'ws_' + id, id, 'session.jsonl.zstd');
      const fs = await import('node:fs');
      const zlib = await import('node:zlib');
      const buf = fs.readFileSync(found);
      const json = zlib.zstdDecompressSync(buf).toString('utf8');
      const parsed = parseSessionLog(json);
      return { ...parsed, path: found };
    },
  };
  const res = await runHistoricalMigration(emptyLedger(), { reader, now: Date.parse('2026-08-16T12:00:00') });
  assert.equal(res.summary.sessionsDiscovered, 3);
  assert.equal(res.summary.sessionsReadSuccessfully, 2);
  assert.equal(res.summary.sessionsReadFailed, 1);
  assert.equal(res.summary.sourceScanStatus, 'partial', 'a read failure must downgrade the scan');
  assert.notEqual(res.summary.recoveryStatus, 'complete', 'partial scan must not claim complete coverage');
  assert.equal(res.ledger.recovery?.sourceScanStatus, 'partial');
  assert.equal(res.ledger.recovery?.sessionsReadFailed, 1);
  rmSync(root, { recursive: true, force: true });
});

test('empty source (0 sessions) does not claim complete lifetime history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dts-'));
  const reader = { async list() { return []; }, async readEvents() { return null; } };
  const res = await runHistoricalMigration(emptyLedger(), { reader, now: Date.parse('2026-08-16T12:00:00') });
  assert.equal(res.summary.sessionsDiscovered, 0);
  assert.equal(res.summary.sourceScanStatus, 'complete', 'mechanically every discoverable (empty) source was read');
  assert.equal(res.summary.recoveryStatus, 'unknown', 'no records => cannot claim complete coverage');
  assert.equal(res.migrated, true);
  rmSync(root, { recursive: true, force: true });
});

test('list() failure yields sourceScanStatus failed and not complete coverage', async () => {
  const reader = { async list() { throw new Error('storage unavailable'); }, async readEvents() { return null; } };
  const res = await runHistoricalMigration(emptyLedger(), { reader, now: Date.parse('2026-08-16T12:00:00') });
  assert.equal(res.summary.sourceScanStatus, 'failed');
  assert.notEqual(res.summary.recoveryStatus, 'complete');
});

test('coverage complete only when scan complete AND provenance covers tracking start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dts-'));
  const start = '2026-08-10';
  const earliest = Date.parse('2026-08-10T09:00:00');
  writeSessionDir(root, 'sessA', [{ type: 'assistant/message', seq: 1, time: earliest, data: { turn: 1, step: 0, usage: { inputTokens: 100, outputTokens: 20 } } }]);
  const base = { ...emptyLedger(), recovery: { trackingStartDate: start }, schemaVersion: 2 };
  const res = await runHistoricalMigration(base, { sessionsDir: root, now: Date.parse('2026-08-16T12:00:00') });
  assert.equal(res.summary.sessionsReadFailed, 0);
  assert.equal(res.summary.sourceScanStatus, 'complete');
  assert.equal(res.summary.recoveryStatus, 'complete');
  rmSync(root, { recursive: true, force: true });
});



// ── v1.0.1 §19 legacy semantics ─────────────────────────────────────────────
// A legacy ledger written by v1.0.0 may already carry schemaVersion=4 and
// recovery.recoveryStatus=complete (OLD coarse semantics: "sessions root is
// enumerable") but NO v1.0.1 sourceScanStatus. That must NOT be treated as
// already-verified complete lifetime coverage. It must trigger the idempotent
// scan to build honest v1.0.1 evidence (and heal any stale live/historical
// split), never re-expose the coarse legacy 'complete'.

test('legacy complete without sourceScanStatus is NOT treated as verified complete', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dts-legacy19-'));
  // A real session's usage that a v1.0.1 scan would recover.
  writeSessionDir(root, 'sessK', [
    { type: 'assistant/message', seq: 1, time: Date.parse('2026-08-10T09:00:00'), data: { turn: 1, step: 0, usage: { inputTokens: 1000, outputTokens: 500 } } },
  ]);
  // Simulate a v1.0.0-completed ledger: schemaVersion=4, recoveryStatus=complete,
  // but NO sourceScanStatus (v1.0.1 field), and a stale split.
  const legacy = {
    ...emptyLedger(),
    schemaVersion: 4,
    recovery: { recoveryStatus: 'complete', trackingStartDate: '2020-01-01' },
    lifetimeTotal: 1600, todayTotal: 100, todayDate: new Date().toISOString().slice(0, 10),
    byId: {}, recordCount: 0, liveRecordedTotal: 1600, historicalRecoveredTotal: 0,
  };
  const res = await runHistoricalMigration(legacy, { sessionsDir: root, now: Date.parse('2026-08-16T12:00:00') });
  // Must not short-circuit as "already complete".
  assert.equal(res.migrated, true, 'legacy complete without sourceScanStatus must re-scan');
  // The scan must build honest v1.0.1 evidence.
  assert.equal(res.summary.sourceScanStatus, 'complete', 'scan ran to completion');
  assert.equal(res.ledger.recovery?.sourceScanStatus, 'complete');
  assert.ok(res.ledger.recovery?.recoveryStatus, 'recoveryStatus present after v1.0.1 scan');
  assert.equal(res.ledger.lifetimeTotal, 1600 + 1500, 'recovered 1500 without double counting');
  rmSync(root, { recursive: true, force: true });
});

test('fresh v1.0.1-completed ledger (with sourceScanStatus) short-circuits as already verified', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dts-v101done-'));
  const done = {
    ...emptyLedger(),
    schemaVersion: 4,
    recovery: {
      recoveryStatus: 'complete', sourceScanStatus: 'complete',
      trackingStartDate: '2020-01-01', sessionsDiscovered: 1,
      sessionsReadSuccessfully: 1, sessionsReadFailed: 0,
    },
    lifetimeTotal: 1600, todayTotal: 100,
  };
  const res = await runHistoricalMigration(done, { sessionsDir: root, now: Date.parse('2026-08-16T12:00:00'), force: false });
  assert.equal(res.migrated, false, 'v1.0.1-completed ledger skips re-scan');
  assert.equal(res.summary.recoveryStatus, 'complete');
  assert.equal(res.summary.sourceScanStatus, 'complete');
  rmSync(root, { recursive: true, force: true });
});
