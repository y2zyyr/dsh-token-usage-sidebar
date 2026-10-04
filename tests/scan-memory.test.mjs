// Remembered scan failures (v1.1.11): a session that could not be verified at one
// source revision must not be re-read at every start. It is retried only when the
// source revision changes, when the retry window expires, or when a repair
// invalidated the ledger's caches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DurableStore } from '../src/usage/durable/durableStore.ts';
import { recoverPersistedSessions, SESSION_SCAN_RETRY_TTL_MS } from '../src/usage/durable/sessionRecovery.ts';
import { tempStore, record, usageEvent, persistenceV2 } from './fixtures.mjs';

const signal = () => new AbortController().signal;

test('a failed read at one revision is remembered and not read again on the next start', async () => {
  const { store } = tempStore();
  const sessions = [{ id: 'bad', revision: 'rev-1', events: [usageEvent(0, 50)] }];
  const first = await recoverPersistedSessions(store, persistenceV2(sessions, { readError: 'bad' }), signal());
  assert.equal(first.sourceScanStatus, 'failed'); assert.equal(first.sessionsReadFailed, 1);
  assert.equal(first.sessionsSkippedKnownUnreadable, 0);
  assert.equal(store.sessionScanFailureCount(), 1, 'the failure is remembered');
  assert.equal(store.readSessionScanFailure('bad').revision, 'revision:rev-1');

  const second = persistenceV2(sessions, { readError: 'bad' });
  const result = await recoverPersistedSessions(store, second, signal());
  assert.equal(result.sessionsSkippedKnownUnreadable, 1);
  assert.equal(result.sessionsReadFailed, 1, 'a known-unreadable session still reports as failed');
  assert.equal(result.sourceScanStatus, 'failed');
  assert.deepEqual(result.errors, ['session-read-failed'], 'cached failures retain safe diagnostics');
  assert.deepEqual(second.opened, [], 'a remembered failure must not open the source again');
  assert.deepEqual(second.reads, [], 'no bytes may be read for a remembered failure');
  assert.equal(typeof first.listMs, 'number'); assert.equal(typeof first.durationMs, 'number');
  store.close();
});

test('a changed source revision retries a remembered failure', async () => {
  const { store } = tempStore();
  await recoverPersistedSessions(store, persistenceV2([{ id: 'bad', revision: 'rev-1', events: [usageEvent(0, 50)] }], { readError: 'bad' }), signal());
  const changed = persistenceV2([{ id: 'bad', revision: 'rev-2', events: [usageEvent(0, 50), usageEvent(1, 10)] }], { readError: 'bad' });
  const result = await recoverPersistedSessions(store, changed, signal());
  assert.equal(result.sessionsSkippedKnownUnreadable, 0);
  assert.deepEqual(changed.opened, ['bad'], 'a changed revision must be read again');
  assert.equal(store.readSessionScanFailure('bad').revision, 'revision:rev-2', 'the remembered revision is refreshed');
  store.close();
});

test('the retry window expires and a still-failing source is read again', async () => {
  const { store } = tempStore();
  const sessions = [{ id: 'bad', revision: 'rev-1', events: [usageEvent(0, 50)] }];
  let clock = 1_000;
  const now = () => clock;
  await recoverPersistedSessions(store, persistenceV2(sessions, { readError: 'bad' }), signal(), { now, retryTtlMs: 5_000 });
  assert.equal(store.readSessionScanFailure('bad').attemptedAt, 1_000);

  clock = 1_000 + 4_999;
  const within = persistenceV2(sessions, { readError: 'bad' });
  assert.equal((await recoverPersistedSessions(store, within, signal(), { now, retryTtlMs: 5_000 })).sessionsSkippedKnownUnreadable, 1);
  assert.deepEqual(within.opened, []);

  clock = 1_000 + 5_000;
  const expired = persistenceV2(sessions, { readError: 'bad' });
  const result = await recoverPersistedSessions(store, expired, signal(), { now, retryTtlMs: 5_000 });
  assert.equal(result.sessionsSkippedKnownUnreadable, 0);
  assert.deepEqual(expired.opened, ['bad'], 'the retry window must expire');
  assert.equal(store.readSessionScanFailure('bad').attemptedAt, 6_000, 'the retry refreshes the remembered attempt');
  store.close();
});

test('a later successful read forgets the remembered failure', async () => {
  const { store } = tempStore();
  const sessions = [{ id: 'flaky', revision: 'rev-1', events: [usageEvent(0, 50)] }];
  await recoverPersistedSessions(store, persistenceV2(sessions, { readError: 'flaky' }), signal());
  assert.equal(store.sessionScanFailureCount(), 1);
  const healthy = persistenceV2(sessions);
  const result = await recoverPersistedSessions(store, healthy, signal(), { retryTtlMs: 0 });
  assert.equal(result.sourceScanStatus, 'complete');
  assert.equal(store.globalAggregate().total_tokens, 50);
  assert.equal(store.sessionScanFailureCount(), 0, 'a successful read must clear the memory');
  const again = persistenceV2(sessions);
  assert.equal((await recoverPersistedSessions(store, again, signal())).sessionsSkippedKnownUnreadable, 0);
  assert.equal((await recoverPersistedSessions(store, persistenceV2(sessions), signal())).sessionsSkippedUnchanged, 1);
  store.close();
});

test('a source with neither revision nor size is never remembered and always retried', async () => {
  const { store } = tempStore();
  const sessions = [{ id: 'opaque', events: [usageEvent(0, 50)] }];
  await recoverPersistedSessions(store, persistenceV2(sessions, { readError: 'opaque' }), signal());
  assert.equal(store.sessionScanFailureCount(), 0, 'without a fingerprint no failure may be remembered');
  const second = persistenceV2(sessions, { readError: 'opaque' });
  const result = await recoverPersistedSessions(store, second, signal());
  assert.equal(result.sessionsSkippedKnownUnreadable, 0);
  assert.deepEqual(second.opened, ['opaque'], 'an unfingerprinted source is always read again');
  store.close();
});

test('a byte-size fingerprint suppresses a re-read when the source exposes no revision', async () => {
  const { store } = tempStore();
  const sessions = [{ id: 'sized', sizeBytes: 4_096, events: [usageEvent(0, 50)] }];
  await recoverPersistedSessions(store, persistenceV2(sessions, { readError: 'sized' }), signal());
  assert.equal(store.readSessionScanFailure('sized').revision, 'size:4096');

  const same = persistenceV2(sessions, { readError: 'sized' });
  assert.equal((await recoverPersistedSessions(store, same, signal())).sessionsSkippedKnownUnreadable, 1);
  assert.deepEqual(same.opened, []);

  const grown = persistenceV2([{ id: 'sized', sizeBytes: 8_192, events: [usageEvent(0, 50)] }], { readError: 'sized' });
  const result = await recoverPersistedSessions(store, grown, signal());
  assert.equal(result.sessionsSkippedKnownUnreadable, 0);
  assert.deepEqual(grown.opened, ['sized'], 'a grown log must be read again');
  store.close();
});

test('a repaired ledger ignores the remembered failures and retries', async () => {
  const { store, path } = tempStore();
  store.apply([record('known:1:0', 100)]);
  const sessions = [{ id: 'bad', revision: 'rev-1', events: [usageEvent(0, 50)] }];
  await recoverPersistedSessions(store, persistenceV2(sessions, { readError: 'bad' }), signal());
  assert.equal(store.sessionScanFailureCount(), 1);
  store.close();

  // Corrupt the derived aggregate so reopening repairs it (repairedOnOpen).
  const db = new DatabaseSync(path);
  db.exec('UPDATE aggregate_global SET total_tokens = 999');
  db.close();
  const repaired = new DurableStore({ path });
  assert.equal(repaired.repairedOnOpen, true);
  const retried = persistenceV2(sessions, { readError: 'bad' });
  const result = await recoverPersistedSessions(repaired, retried, signal());
  assert.equal(result.sessionsSkippedKnownUnreadable, 0, 'a repair must retry every source');
  assert.deepEqual(retried.opened, ['bad']);
  await recoverPersistedSessions(repaired, persistenceV2(sessions), signal());
  assert.equal(repaired.sessionScanFailureCount(), 0, 'success after a repair also clears old failures');
  repaired.close();
});

test('failure memory survives closing and reopening the ledger', async () => {
  const { store, path } = tempStore();
  const sessions = [{ id: 'bad', revision: 'rev-1', events: [usageEvent(0, 50)] }];
  await recoverPersistedSessions(store, persistenceV2(sessions, { readError: 'bad' }), signal());
  store.close();
  const reopened = new DurableStore({ path });
  try {
    const next = persistenceV2(sessions, { readError: 'bad' });
    const result = await recoverPersistedSessions(reopened, next, signal());
    assert.equal(result.sessionsSkippedKnownUnreadable, 1);
    assert.deepEqual(next.opened, []);
  } finally { reopened.close(); }
});

test('malformed session descriptors do not stop recovery of later valid sessions', async () => {
  const { store } = tempStore();
  const persistence = persistenceV2([{ id: 'valid', revision: 'rev-1', events: [usageEvent(0, 50)] }]);
  const list = persistence.list;
  persistence.list = async () => [null, undefined, 42, [], {}, ...(await list())];
  try {
    const result = await recoverPersistedSessions(store, persistence, signal());
    assert.equal(result.sessionsReadFailed, 5);
    assert.equal(result.sessionsReadSuccessfully, 1);
    assert.equal(result.sourceScanStatus, 'partial');
    assert.deepEqual(result.errors, Array(5).fill('invalid-session-descriptor'));
    assert.equal(store.globalAggregate().total_tokens, 50);
    assert.equal(store.sessionScanFailureCount(), 0);
  } finally { store.close(); }
});

test('a clock moving backwards retries instead of extending a cached failure', async () => {
  const { store } = tempStore();
  const sessions = [{ id: 'bad', revision: 'rev-1', events: [usageEvent(0, 50)] }];
  try {
    await recoverPersistedSessions(store, persistenceV2(sessions, { readError: 'bad' }), signal(), { now: () => 10_000 });
    const next = persistenceV2(sessions);
    const result = await recoverPersistedSessions(store, next, signal(), { now: () => 5_000 });
    assert.equal(result.sessionsSkippedKnownUnreadable, 0);
    assert.deepEqual(next.opened, ['bad']);
    assert.equal(store.sessionScanFailureCount(), 0);
  } finally { store.close(); }
});

test('a revision cannot collide with a fallback size fingerprint', async () => {
  const { store } = tempStore();
  try {
    await recoverPersistedSessions(store, persistenceV2([{ id: 'source', sizeBytes: 4096, events: [] }], { readError: 'source' }), signal());
    const next = persistenceV2([{ id: 'source', revision: 'size:4096', events: [usageEvent(0, 50)] }]);
    const result = await recoverPersistedSessions(store, next, signal());
    assert.equal(result.sessionsSkippedKnownUnreadable, 0);
    assert.deepEqual(next.opened, ['source']);
    assert.equal(store.globalAggregate().total_tokens, 50);
  } finally { store.close(); }
});

const jsonlRevision = (corpus, file = '1:2:4096:4:5') => file + ':' + corpus.repeat(64);
test('JSONL corpus changes do not re-read an unchanged failed source until its retry window expires', async () => {
  const { store, path } = tempStore();
  const name = 'session-persistence-jsonl';
  const sessions = [{ id: 'legacy', sizeBytes: 4096, revision: jsonlRevision('a'), events: [usageEvent(0, 50)] }];
  await recoverPersistedSessions(store, persistenceV2(sessions, { name, readError: 'legacy' }), signal(), { now: () => 1_000 });
  assert.equal(store.readSessionScanFailure('legacy').revision, 'historical-file:1:2:4096:4:5');
  store.close();
  const reopened = new DurableStore({ path });
  try {
    const changedCorpus = [{ ...sessions[0], revision: jsonlRevision('b') }];
    const within = persistenceV2(changedCorpus, { name, readError: 'legacy' });
    const skipped = await recoverPersistedSessions(reopened, within, signal(), { now: () => 2_000 });
    assert.equal(skipped.sessionsSkippedKnownUnreadable, 1); assert.deepEqual(within.opened, []);
    assert.equal(reopened.readSessionScanFailure('legacy').attemptedAt, 1_000, 'skips must not extend the retry window');
    const expired = persistenceV2(changedCorpus, { name });
    await recoverPersistedSessions(reopened, expired, signal(), { now: () => 1_000 + SESSION_SCAN_RETRY_TTL_MS });
    assert.deepEqual(expired.opened, ['legacy'], 'related-source repairs are reconsidered when TTL expires');
    assert.equal(reopened.globalAggregate().total_tokens, 50); assert.equal(reopened.sessionScanFailureCount(), 0);
  } finally { reopened.close(); }
});

test('an old full-revision failure cache also survives an unrelated JSONL corpus change', async () => {
  const { store } = tempStore();
  try {
    store.writeSessionScanFailure('legacy', 'revision:' + jsonlRevision('a'), 'session-read-failed', 1_000);
    const persistence = persistenceV2([{ id: 'legacy', sizeBytes: 4096, revision: jsonlRevision('b'), events: [] }],
      { name: 'session-persistence-jsonl', readError: 'legacy' });
    const result = await recoverPersistedSessions(store, persistence, signal(), { now: () => 2_000 });
    assert.equal(result.sessionsSkippedKnownUnreadable, 1); assert.deepEqual(persistence.opened, []);
  } finally { store.close(); }
});

test('a changed JSONL source file is retried even when its size stays the same', async () => {
  const { store } = tempStore();
  const name = 'session-persistence-jsonl';
  try {
    await recoverPersistedSessions(store, persistenceV2([{ id: 'legacy', sizeBytes: 4096,
      revision: jsonlRevision('a'), events: [] }], { name, readError: 'legacy' }), signal());
    const changed = persistenceV2([{ id: 'legacy', sizeBytes: 4096,
      revision: jsonlRevision('b', '1:2:4096:6:7'), events: [usageEvent(0, 50)] }], { name });
    await recoverPersistedSessions(store, changed, signal());
    assert.deepEqual(changed.opened, ['legacy']); assert.equal(store.globalAggregate().total_tokens, 50);
  } finally { store.close(); }
});

test('successful JSONL checkpoints still use full revisions after related-source changes', async () => {
  const { store } = tempStore();
  const name = 'session-persistence-jsonl';
  try {
    await recoverPersistedSessions(store, persistenceV2([{ id: 'legacy', sizeBytes: 4096,
      revision: jsonlRevision('a'), events: [usageEvent(0, 50)] }], { name }), signal());
    const changed = persistenceV2([{ id: 'legacy', sizeBytes: 4096,
      revision: jsonlRevision('b'), events: [usageEvent(0, 50), usageEvent(1, 60)] }], { name });
    await recoverPersistedSessions(store, changed, signal());
    assert.deepEqual(changed.opened, ['legacy']); assert.equal(store.globalAggregate().total_tokens, 60);
    assert.equal(store.readSessionCheckpoint('legacy').revision, jsonlRevision('b'));
  } finally { store.close(); }
});

test('unknown backends and mismatched file sizes retain full opaque revision semantics', async () => {
  for (const options of [{ name: 'another-backend', sizeBytes: 4096 }, { name: 'session-persistence-jsonl', sizeBytes: 4097 }]) {
    const { store } = tempStore();
    try {
      await recoverPersistedSessions(store, persistenceV2([{ id: 'source', sizeBytes: options.sizeBytes,
        revision: jsonlRevision('a'), events: [] }], { name: options.name, readError: 'source' }), signal());
      const changed = persistenceV2([{ id: 'source', sizeBytes: options.sizeBytes,
        revision: jsonlRevision('b'), events: [usageEvent(0, 50)] }], { name: options.name });
      await recoverPersistedSessions(store, changed, signal());
      assert.deepEqual(changed.opened, ['source']); assert.equal(store.globalAggregate().total_tokens, 50);
    } finally { store.close(); }
  }
});

test('the schema 4 table is additive: an existing ledger keeps records and aggregates', async () => {
  const { store, path } = tempStore();
  store.apply([record('known:1:0', 400)]);
  store.close();

  const db = new DatabaseSync(path);
  db.exec('DROP TABLE session_scan_failures');
  db.exec('UPDATE meta SET storage_schema_version=3');
  db.close();

  const reopened = new DurableStore({ path });
  assert.equal(reopened.readMeta().storageSchemaVersion, 4, 'the additive upgrade advances the recorded version');
  assert.equal(reopened.globalAggregate().total_tokens, 400, 'records and aggregates survive the upgrade');
  assert.equal(reopened.verifyAggregates().ok, true);
  assert.equal(reopened.sessionScanFailureCount(), 0);
  reopened.writeSessionScanFailure('x', 'rev', 'session-read-failed', 5);
  assert.deepEqual(reopened.readSessionScanFailure('x'), { revision: 'rev', failureCode: 'session-read-failed', attemptedAt: 5 });
  reopened.close();
});

test('the default retry window is a full day', () => {
  assert.equal(SESSION_SCAN_RETRY_TTL_MS, 24 * 60 * 60 * 1000);
});
