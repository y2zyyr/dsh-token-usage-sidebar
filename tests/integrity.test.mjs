import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DurableStore } from '../src/usage/durable/durableStore.ts';
import { DurableAggregator } from '../src/usage/durable/durableAggregator.ts';
import { migrateV1Ledger, readV1RootResult } from '../src/usage/durable/migration.ts';
import { collectSessionUsage, SessionUsageCollector } from '../src/usage/collector.ts';
import { recoverPersistedSessions, snapshotLiveSession } from '../src/usage/durable/sessionRecovery.ts';
import { tempStore, record, usageEvent, attempt, retry, v1, persistenceV2, NOW, DAY } from './fixtures.mjs';

test('unknown dated usage has one inclusive daily total before and after rebuild/restart', () => {
  const { store, path } = tempStore();
  store.apply([record('known:1:0', 100), record('unknown:1:0', 77, { inputTokens: 0 })]);
  const aggregator = new DurableAggregator(store, { now: () => NOW });
  const before = aggregator.insights('7d');
  assert.equal(before.totalTokens, 177); assert.equal(before.categories.totalTokens, 100);
  assert.equal(before.daily.at(-1).totalTokens, 177); assert.equal(before.unknownTokens, 77);
  assert.equal(before.daily.length, 7); assert.equal(store.verifyAggregates().ok, true);
  store.rebuildAggregates(); assert.deepEqual(aggregator.insights('7d'), before);
  aggregator.close();
  const reopened = new DurableStore({ path });
  const after = new DurableAggregator(reopened, { now: () => NOW });
  assert.equal(after.summary().todayTotal, 177); assert.equal(after.summary().recordCount, 2); after.close();
});

test('undated legacy usage stays in lifetime and never acquires a fabricated date', () => {
  const { store } = tempStore();
  store.apply([record('unknown:1:0', 77, { inputTokens: 0, localDate: 'unclassified', timestamp: 0 })]);
  const aggregator = new DurableAggregator(store, { now: () => NOW });
  assert.equal(aggregator.insights('all').totalTokens, 77); assert.equal(aggregator.insights('7d').totalTokens, 0);
  store.rebuildAggregates(); assert.equal(store.dailyTotals().length, 0); assert.equal(store.verifyAggregates().ok, true); aggregator.close();
});

test('startup repairs bucket and model drift even when global total is correct', () => {
  const { store, path } = tempStore(); store.apply([record('healthy:1:0', 100)]);
  store.database.exec('UPDATE aggregate_daily SET input_tokens=999; UPDATE aggregate_model SET total_tokens=999');
  assert.equal(store.verifyAggregates().ok, false); store.close();
  const reopened = new DurableStore({ path });
  assert.equal(reopened.repairedOnOpen, true); assert.equal(reopened.daily(DAY).input_tokens, 100);
  assert.equal(reopened.modelTotals()[0].total_tokens, 100); assert.equal(reopened.verifyAggregates().ok, true); reopened.close();
});

test('equal-sequence enrichment adds missing buckets and model without changing total or provenance', () => {
  const { store } = tempStore();
  store.apply([record('same:1:0', 77, { seq: 9, inputTokens: 0, provider: undefined, model: undefined, sourceType: 'session_log' })]);
  store.apply([record('same:1:0', 77, { seq: 9 })]);
  assert.equal(store.globalAggregate().total_tokens, 77); assert.equal(store.globalAggregate().unknown_tokens, 0);
  assert.equal(store.getRecord('same:1:0').provider, 'synthetic'); assert.equal(store.provenanceSplit().historical, 77);
  store.apply([record('same:1:0', 999, { seq: 9 })]); assert.equal(store.globalAggregate().total_tokens, 77);
  assert.equal(store.readMeta().recordGeneration, store.readMeta().aggregateGeneration); store.close();
});

test('invalid token buckets reject the whole batch, including earlier valid records', () => {
  for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const { store } = tempStore();
    assert.throws(() => store.apply([record('good:1:0', 100), record('bad:1:0', 100, { cacheReadTokens: value })]), /invalid-usage-record/);
    assert.equal(store.recordCount(), 0); assert.equal(store.globalAggregate()?.total_tokens ?? 0, 0); store.close();
  }
});

test('unsafe aggregate overflow rolls back the incoming record', () => {
  const { store } = tempStore(); store.apply([record('large:1:0', Number.MAX_SAFE_INTEGER)]);
  assert.throws(() => store.apply([record('extra:1:0', 1)]), /aggregate overflow/);
  assert.equal(store.recordCount(), 1); assert.equal(store.globalAggregate().total_tokens, Number.MAX_SAFE_INTEGER); store.close();
  const reasoning = tempStore().store;
  reasoning.apply([record('reasoning:1:0', 0, { reasoningTokens: Number.MAX_SAFE_INTEGER })]);
  assert.throws(() => reasoning.apply([record('extra-reasoning:1:0', 0, { reasoningTokens: 1 })]), /aggregate overflow/);
  assert.equal(reasoning.recordCount(), 1); assert.equal(reasoning.globalAggregate().reasoning_tokens, Number.MAX_SAFE_INTEGER); reasoning.close();
});

test('v1 migration verifies a union and preserves a newer overlapping record', () => {
  const { store } = tempStore(); store.apply([record('overlap:1:0', 120, { seq: 9 }), record('independent:1:0', 200)]);
  const result = migrateV1Ledger(store, { v1Root: v1([record('overlap:1:0', 100)]), noBackup: true });
  assert.equal(result.status, 'done'); assert.equal(store.globalAggregate().total_tokens, 320);
  assert.equal(store.getRecord('overlap:1:0').seq, 9); store.close();
});

test('verification failure after replacement restores original rows and aggregates transactionally', () => {
  const { store } = tempStore(); store.apply([record('overlap:1:0', 120, { seq: 9 }), record('independent:1:0', 200)]);
  const realVerify = store.verifyAggregates.bind(store);
  store.verifyAggregates = () => ({ ...realVerify(), ok: false, details: ['injected post-write mismatch'] });
  const result = migrateV1Ledger(store, { v1Root: v1([record('overlap:1:0', 150, { seq: 10 }), record('new:1:0', 20)]), noBackup: true });
  assert.equal(result.status, 'failed'); assert.equal(store.globalAggregate().total_tokens, 320);
  assert.equal(store.getRecord('overlap:1:0').total_tokens, 120); assert.equal(store.getRecord('overlap:1:0').seq, 9);
  assert.equal(store.hasRecord('new:1:0'), false); store.verifyAggregates = realVerify;
  assert.equal(store.verifyAggregates().ok, true); store.close();
});

test('invalid v1 is distinguished from absence and never mutates existing history', () => {
  const { store, dir } = tempStore(); store.apply([record('existing:1:0', 500)]);
  const path = join(dir, 'dsh_token_usage_sidebar.json'); writeFileSync(path, '{broken');
  assert.equal(readV1RootResult(path).status, 'invalid'); assert.equal(readV1RootResult(path + '.missing').status, 'absent');
  assert.equal(migrateV1Ledger(store, { v1Path: path }).status, 'failed');
  assert.equal(store.globalAggregate().total_tokens, 500); assert.equal(readFileSync(path, 'utf8'), '{broken'); store.close();
});

test('DSH 0.2 attempts and stream fallback are counted and explicit retry samples deduplicate', () => {
  const streamOnly = { ...attempt(0, 125), type: 'assistant/message' };
  assert.equal(collectSessionUsage({ sessionId: 'stream', events: [streamOnly] })[0].totalTokens, 125);
  const events = [attempt(0, 100), retry(1), usageEvent(2, 200), usageEvent(3, 250)];
  const records = collectSessionUsage({ sessionId: 'retry', events });
  assert.equal(records.length, 2); assert.equal(records.reduce((sum, row) => sum + row.totalTokens, 0), 350);
  assert.deepEqual(records.map((row) => row.id), ['retry:1:0', 'retry:1:0:retry:1']);
  const live = new SessionUsageCollector({ sessionId: 'live' });
  const { store } = tempStore(); for (const event of events) store.apply(live.collect([event]));
  assert.equal(store.globalAggregate().total_tokens, 350); assert.equal(store.recordCount(), 2);
  for (const event of events) store.apply(live.collect([event])); assert.equal(store.globalAggregate().total_tokens, 350); store.close();
});

test('legacy retry correction creates a verified audit and a recoverable SQLite snapshot', () => {
  const { store, path } = tempStore(); store.apply([record('retry:1:0', 200, { seq: 2 })]);
  const events = [attempt(0, 100), retry(1), usageEvent(2, 200)];
  const records = collectSessionUsage({ sessionId: 'retry', events, sourceType: 'session_log' });
  store.reconcileSession('retry', records, [], 2);
  assert.equal(store.globalAggregate().total_tokens, 300); assert.equal(store.recordCount(), 2);
  assert.equal(store.accountingDiagnostics().accountingAdjustment, 100);
  const backups = readdirSync(join(path, '..')).filter((name) => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(join(path, '..', backups[0]), { readOnly: true });
  assert.equal(backup.prepare('SELECT total_tokens FROM aggregate_global').get().total_tokens, 200); backup.close();
  store.reconcileSession('retry', records, [], 2); assert.equal(store.accountingDiagnostics().accountingChangeCount, 1);
  store.apply([record('retry:1:0', 999, { seq: 999 })]); assert.equal(store.globalAggregate().total_tokens, 300); store.close();
});

test('fork correction excludes inherited records without deleting original evidence', () => {
  const { store } = tempStore();
  store.apply([record('parent:1:0', 100, { seq: 0 }), record('child:1:0', 100, { seq: 0 }), record('child:2:0', 50, { seq: 2 })]);
  const session = { id: 'child', inheritedEventCount: 1, header: { id: 'child', isSeeded: true, parentSession: 'parent' }, events: [
    usageEvent(0, 100), { type: 'session/end-seed', seq: 1, time: NOW, data: { inherited: true } }, usageEvent(2, 50, { turn: 2 }),
  ] };
  const replay = snapshotLiveSession(session); store.reconcileSession('child', replay.records, replay.inheritedIds, replay.lastSeq);
  assert.equal(store.globalAggregate().total_tokens, 150); assert.equal(store.recordCount(), 2);
  assert.equal(store.getRecord('child:1:0').total_tokens, 100); assert.equal(store.getRecord('child:1:0').excluded_reason, 'fork_inherited');
  assert.equal(store.accountingDiagnostics().accountingAdjustment, -100); assert.equal(store.verifyAggregates().ok, true); store.close();
});

test('a session snapshot behind legacy ledger never overwrites that newer history', () => {
  const { store } = tempStore(); store.apply([record('ahead:1:0', 999, { seq: 10 })]);
  assert.throws(() => store.reconcileSession('ahead', collectSessionUsage({ sessionId: 'ahead', events: [usageEvent(0, 100)] }), [], 0), /snapshot-behind/);
  assert.equal(store.globalAggregate().total_tokens, 999); assert.equal(store.accountingDiagnostics().accountingChangeCount, 0); store.close();
});

test('a snapshot missing an event cannot authorize a legacy accounting correction', () => {
  const { store } = tempStore(); store.apply([record('incomplete:1:0', 200, { seq: 2 })]);
  assert.throws(() => snapshotLiveSession({ id: 'incomplete', events: [attempt(0, 100), usageEvent(2, 200)] }), /non-contiguous/);
  assert.equal(store.globalAggregate().total_tokens, 200); assert.equal(store.accountingDiagnostics().accountingChangeCount, 0); store.close();
});

test('writes with no subscribers never compute a summary; summary count uses aggregates', () => {
  const { store } = tempStore(); const aggregator = new DurableAggregator(store, { now: () => NOW });
  const summary = aggregator.summary.bind(aggregator); aggregator.summary = () => { throw new Error('unexpected full summary'); };
  assert.equal(aggregator.apply([record('fast:1:0', 100)]), 1); aggregator.summary = summary;
  store.recordCount = () => { throw new Error('unexpected record scan'); };
  assert.equal(aggregator.summary().recordCount, 1); aggregator.close();
});

test('seven-day reads stay within indexed dates, with zero-filled empty days', () => {
  const { store } = tempStore(); const aggregator = new DurableAggregator(store, { now: () => NOW });
  assert.equal(aggregator.insights('7d').daily.length, 7);
  store.apply([record('current:1:0', 10), record('old:1:0', 999, { localDate: '2025-01-01' })]);
  const read = store.dayModelTotals.bind(store); const calls = [];
  store.dayModelTotals = (...args) => { calls.push(args); return read(...args); };
  const value = aggregator.insights('7d');
  assert.equal(value.totalTokens, 10); assert.equal(value.daily.length, 7); assert.equal(value.daily.filter((row) => row.totalTokens === 0).length, 6);
  assert.deepEqual(calls, [['2026-09-25', DAY]]); aggregator.close();
});

test('cold persisted sessions recover with historical attribution and unchanged logs use checkpoints', async () => {
  const { store } = tempStore(); const sessions = [{ id: 'cold', events: [attempt(0, 100), retry(1), usageEvent(2, 200)] }];
  const persistence = persistenceV2(sessions); const signal = new AbortController().signal;
  const first = await recoverPersistedSessions(store, persistence, signal);
  assert.equal(first.sourceScanStatus, 'complete'); assert.equal(store.globalAggregate().total_tokens, 300);
  assert.equal(store.provenanceSplit().historical, 300); assert.equal(persistence.closed.length, 1);
  persistence.reads.length = 0;
  const second = await recoverPersistedSessions(store, persistence, signal);
  assert.equal(second.sessionsSkippedUnchanged, 1); assert.equal(store.globalAggregate().total_tokens, 300);
  assert.deepEqual(persistence.reads.map((row) => row.offset), [2, 3]); assert.equal(persistence.closed.length, 2); store.close();
});

test('checkpoint retains retry boundary and atomically consumes appended usage once', async () => {
  const { store } = tempStore(); const session = { id: 'tail', events: [attempt(0, 100), retry(1)] };
  const persistence = persistenceV2([session]); const signal = new AbortController().signal;
  await recoverPersistedSessions(store, persistence, signal); session.events.push(usageEvent(2, 200));
  await recoverPersistedSessions(store, persistence, signal); assert.equal(store.globalAggregate().total_tokens, 300);
  await recoverPersistedSessions(store, persistence, signal); assert.equal(store.recordCount(), 2); store.close();
});

test('read failures are partial, close handles and never expose raw source errors', async () => {
  const { store } = tempStore(); const persistence = persistenceV2([{ id: 'good', events: [usageEvent(0, 100)] }, { id: 'bad', events: [usageEvent(0, 50)] }], { readError: 'bad' });
  const result = await recoverPersistedSessions(store, persistence, new AbortController().signal);
  assert.equal(result.sourceScanStatus, 'partial'); assert.equal(result.sessionsReadSuccessfully, 1); assert.equal(result.sessionsReadFailed, 1);
  assert.equal(store.globalAggregate().total_tokens, 100); assert.deepEqual(persistence.closed, ['good', 'bad']);
  assert.deepEqual(result.errors, ['session-read-failed']); store.close();
});

test('checkpoint conflicts preserve existing totals and report unreadable history', async () => {
  const { store } = tempStore(); const session = { id: 'conflict', events: [usageEvent(0, 100)] };
  const persistence = persistenceV2([session]); const signal = new AbortController().signal;
  await recoverPersistedSessions(store, persistence, signal); session.events[0] = usageEvent(0, 999);
  const result = await recoverPersistedSessions(store, persistence, signal);
  assert.equal(result.sourceScanStatus, 'failed'); assert.equal(store.globalAggregate().total_tokens, 100); assert.equal(persistence.closed.length, 2); store.close();
});

test('legacy DSH persistence reads include cold sessions', async () => {
  const { store } = tempStore();
  const persistence = { async list() { return [{ id: 'legacy-cold' }]; }, async readFrom(id, offset) { assert.equal(offset, 0); return { meta: { id }, events: [usageEvent(0, 123)] }; } };
  const result = await recoverPersistedSessions(store, persistence, new AbortController().signal);
  assert.equal(result.sourceScanStatus, 'complete'); assert.equal(store.globalAggregate().total_tokens, 123); store.close();
});

test('legacy persistence resumes from a verified checkpoint and retains the retry boundary', async () => {
  const { store } = tempStore(); const events = [attempt(0, 100), retry(1)]; const reads = [];
  const persistence = { async list() { return [{ id: 'legacy-tail' }]; }, async readFrom(id, offset) {
    reads.push(offset); return { meta: { id }, events: events.slice(offset) };
  } };
  const signal = new AbortController().signal;
  await recoverPersistedSessions(store, persistence, signal); events.push(usageEvent(2, 200));
  await recoverPersistedSessions(store, persistence, signal);
  const unchanged = await recoverPersistedSessions(store, persistence, signal);
  assert.deepEqual(reads, [0, 1, 2]); assert.equal(unchanged.sessionsSkippedUnchanged, 1);
  assert.equal(store.globalAggregate().total_tokens, 300);
  events[2] = usageEvent(2, 999);
  const conflict = await recoverPersistedSessions(store, persistence, signal);
  assert.equal(conflict.sourceScanStatus, 'failed'); assert.equal(store.globalAggregate().total_tokens, 300); store.close();
});

test('official unchanged revision skips source opening; changed revisions still validate the boundary', async () => {
  const { store } = tempStore(); const session = { id: 'revision', revision: 'source-A:1', events: [usageEvent(0, 100)] };
  const persistence = persistenceV2([session]); const signal = new AbortController().signal;
  await recoverPersistedSessions(store, persistence, signal); persistence.reads.length = 0;
  const unchanged = await recoverPersistedSessions(store, persistence, signal);
  assert.equal(unchanged.sessionsSkippedUnchanged, 1); assert.equal(persistence.opened.length, 1); assert.equal(persistence.reads.length, 0);
  session.revision = 'source-A:2'; session.events[0] = usageEvent(0, 999);
  const changed = await recoverPersistedSessions(store, persistence, signal);
  assert.equal(changed.sourceScanStatus, 'failed'); assert.equal(store.globalAggregate().total_tokens, 100); assert.equal(persistence.closed.length, 2); store.close();
});

test('DSH 0.1 lightweight snapshots avoid unchanged JSONL reads and resume changed logs', async () => {
  const { store } = tempStore(); const events = [attempt(0, 100), retry(1)]; let revision = 'legacy-source:1'; const reads = [];
  const persistence = { async list() { throw new Error('snapshot listing should be preferred'); },
    async listSnapshots() { return [{ header: { id: 'revision-v01' }, revision }]; },
    async readFrom(id, offset) { reads.push(offset); return { meta: { id }, events: events.slice(offset) }; } };
  const signal = new AbortController().signal;
  await recoverPersistedSessions(store, persistence, signal); await recoverPersistedSessions(store, persistence, signal);
  assert.deepEqual(reads, [0]); events.push(usageEvent(2, 200)); revision = 'legacy-source:2';
  await recoverPersistedSessions(store, persistence, signal); assert.deepEqual(reads, [0, 1]); assert.equal(store.globalAggregate().total_tokens, 300); store.close();
});

test('new legacy imports invalidate a saved fork checkpoint and are reconciled on replay', async () => {
  const { store } = tempStore(); store.apply([record('parent:1:0', 100, { accountingVersion: 2 })]);
  const session = { id: 'later-fork', revision: 'fork-source:1', inheritedEventCount: 1,
    header: { id: 'later-fork', isSeeded: true, parentSession: 'parent' },
    events: [usageEvent(0, 100), { type: 'session/end-seed', seq: 1, data: { inherited: true } }, usageEvent(2, 50, { turn: 2 })] };
  const persistence = persistenceV2([session]); const signal = new AbortController().signal;
  await recoverPersistedSessions(store, persistence, signal); assert.ok(store.readSessionCheckpoint(session.id));
  store.apply([record('later-fork:1:0', 100, { seq: 0, sourceType: 'legacy_store' })]);
  assert.equal(store.readSessionCheckpoint(session.id), undefined); assert.equal(store.globalAggregate().total_tokens, 250);
  await recoverPersistedSessions(store, persistence, signal);
  assert.equal(store.globalAggregate().total_tokens, 150); assert.equal(store.getRecord('later-fork:1:0').excluded_reason, 'fork_inherited');
  assert.equal(store.verifyAggregates().ok, true); store.close();
});

test('startup aggregate repair forces a full session replay rather than trusting an old checkpoint', async () => {
  const { store, path } = tempStore(); const persistence = persistenceV2([{ id: 'restored', revision: 'restore-source:1', events: [usageEvent(0, 100)] }]);
  const signal = new AbortController().signal; await recoverPersistedSessions(store, persistence, signal);
  store.database.exec('DELETE FROM usage_records'); store.close();
  const reopened = new DurableStore({ path }); assert.equal(reopened.repairedOnOpen, true);
  const result = await recoverPersistedSessions(reopened, persistence, signal);
  assert.equal(result.sourceScanStatus, 'complete'); assert.equal(result.sessionsSkippedUnchanged, 0);
  assert.equal(reopened.globalAggregate().total_tokens, 100); assert.equal(reopened.verifyAggregates().ok, true); reopened.close();
});

test('an invalidation during async recovery cannot recreate the stale checkpoint', async () => {
  const { store } = tempStore(); const session = { id: 'checkpoint-race', events: [usageEvent(0, 100)] }; let invalidate = false;
  const persistence = persistenceV2([session], { beforeRead: async (_id, offset) => {
    if (invalidate && offset === 0) { invalidate = false; store.apply([record('checkpoint-race:2:0', 50, { seq: 1, sourceType: 'legacy_store' })]); }
  } });
  const signal = new AbortController().signal;
  await recoverPersistedSessions(store, persistence, signal); invalidate = true;
  const stale = await recoverPersistedSessions(store, persistence, signal);
  assert.equal(stale.sourceScanStatus, 'failed'); assert.equal(store.readSessionCheckpoint(session.id), undefined);
  assert.equal(store.globalAggregate().total_tokens, 150);
  session.events.push(usageEvent(1, 50, { turn: 2 }));
  const retry = await recoverPersistedSessions(store, persistence, signal);
  assert.equal(retry.sourceScanStatus, 'complete'); assert.equal(store.globalAggregate().total_tokens, 150);
  assert.equal(store.accountingDiagnostics().legacyRecordCount, 0); store.close();
});
