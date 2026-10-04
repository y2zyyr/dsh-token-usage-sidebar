import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.ts';
import { DurableStore } from '../src/usage/durable/durableStore.ts';
import { record, usageEvent, attempt, retry, v1, persistenceV2, tick } from './fixtures.mjs';

function makeHost(options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dtsu-host-'));
  const storages = join(home, 'storages'); mkdirSync(storages);
  const dbPath = join(storages, 'dsh_token_usage_sidebar.sqlite');
  const v1Path = join(storages, 'dsh_token_usage_sidebar.json');
  if (options.v1Text !== undefined) writeFileSync(v1Path, options.v1Text);
  if (options.v1Root) writeFileSync(v1Path, JSON.stringify({ tables: { ledger: { root: options.v1Root } } }));
  if (options.corruptDb) writeFileSync(dbPath, 'synthetic invalid SQLite source');
  if (options.records) { const store = new DurableStore({ path: dbPath }); store.apply(options.records); store.close(); }
  const listeners = new Map(); let route, dispose; let routeDisposed = false;
  const sessions = options.sessions ?? [];
  const context = {
    sessions: { list: () => { if (options.listError) throw new Error('synthetic list failure'); return sessions; } },
    sessionPersistence: options.persistence,
    webRuntime: { trustedHosts: [] },
    webServer: { register: (value) => { route = value.handler; return () => { routeDisposed = true; }; } },
    logger: { warn() {} },
    on: (event, listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(listener);
      return () => listeners.get(event).delete(listener);
    },
    effect: (callback) => { dispose = callback(); assert.equal(typeof dispose, 'function'); },
  };
  const previousHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
  try { apply(context); }
  finally { if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; }
  return {
    dbPath, v1Path, sessions,
    emit: (event, ...args) => { for (const listener of listeners.get(event) ?? []) listener(...args); },
    dispose: () => dispose(),
    get routeDisposed() { return routeDisposed; },
    get listenerCount() { return [...listeners.values()].reduce((sum, values) => sum + values.size, 0); },
    async api(method, payload = {}, options = {}) {
      let result; const res = { statusCode: 200, setHeader() {}, end(body) { result = JSON.parse(body); } };
      const req = { method: 'POST', url: '/token-usage/api/' + method, headers: { host: 'localhost', ...options.headers },
        async *[Symbol.asyncIterator]() { yield options.body ?? JSON.stringify(payload); } };
      await route(req, res); return { status: res.statusCode, ...result };
    },
    async ready() {
      for (let i = 0; i < 400; i += 1) {
        const debug = await this.api('debug');
        if (debug.value.health.status !== 'loading' && debug.value.health.scanInProgress === false) return debug.value;
        await tick();
      }
      throw new Error('host initialization did not settle');
    },
  };
}

test('actual host API refuses successful zero when v1 JSON is corrupt', async () => {
  const host = makeHost({ v1Text: '{broken JSON' });
  try {
    const debug = await host.ready(); const response = await host.api('summary');
    assert.equal(debug.failureCode, 'v1-migration-failed'); assert.equal(response.status, 503);
    assert.equal(response.ok, false); assert.equal(response.value, undefined);
    assert.equal(readFileSync(host.v1Path, 'utf8'), '{broken JSON');
  } finally { host.dispose(); }
});

test('failed migration preserves existing SQLite history and gates reads', async () => {
  const root = { ...v1([record('old:1:0', 100)]), lifetimeTotal: 999 };
  const host = makeHost({ v1Root: root, records: [record('existing:1:0', 500)] });
  try {
    await host.ready(); assert.equal((await host.api('summary')).status, 503);
    const debug = await host.api('debug'); assert.equal(debug.value.lifetimeTotal, 500);
    assert.equal(debug.value.migrationStatus, 'failed');
  } finally { host.dispose(); }
});

test('unreadable SQLite remains untouched and API reports recovery failure', async () => {
  const host = makeHost({ corruptDb: true });
  try {
    await host.ready(); assert.equal((await host.api('summary')).status, 503);
    assert.equal(readFileSync(host.dbPath, 'utf8'), 'synthetic invalid SQLite source');
  } finally { host.dispose(); }
});

test('unopened persisted history is recovered, attributed historically and exposed through actual routes', async () => {
  const persistence = persistenceV2([{ id: 'cold', events: [attempt(0, 100), retry(1), usageEvent(2, 200)] }]);
  const host = makeHost({ persistence });
  try {
    const debug = await host.ready(); const response = await host.api('summary');
    assert.equal(response.status, 200); assert.equal(response.value.lifetimeTotal, 300);
    assert.equal(response.value.recordCount, 2); assert.equal(debug.historicalRecoveredTotal, 300);
    assert.equal(debug.liveRecordedTotal, 0); assert.equal(debug.sourceScanStatus, 'complete');
    assert.equal(debug.sessionsReadSuccessfully, 1); assert.deepEqual(persistence.closed, ['cold']);
  } finally { host.dispose(); }
});

test('actual live single-event delivery keeps retry boundaries and counts each attempt once', async () => {
  const events = []; const session = { id: 'live', snapshotEvents: () => [...events] };
  const host = makeHost({ sessions: [session], persistence: persistenceV2([]) });
  try {
    await host.ready();
    for (const event of [attempt(0, 100), retry(1), usageEvent(2, 200)]) { events.push(event); host.emit('session/event', session, event); }
    assert.equal((await host.api('summary')).value.lifetimeTotal, 300);
    host.emit('session/event', session, events.at(-1));
    const debug = (await host.api('debug')).value;
    assert.equal(debug.liveRecordedTotal, 300); assert.equal(debug.lifetimeTotal, 300);
  } finally { host.dispose(); }
});

test('a session opened after initialization replays owned history and excludes fork inheritance', async () => {
  const host = makeHost({ persistence: persistenceV2([]) });
  try {
    await host.ready();
    const parent = { id: 'parent', snapshotEvents: () => [usageEvent(0, 100)] };
    const child = { id: 'child', inheritedEventCount: 1, snapshotEvents: () => [usageEvent(0, 100), { type: 'session/end-seed', seq: 1, data: { inherited: true } }, usageEvent(2, 50, { turn: 2 })] };
    host.emit('session/created', parent); host.emit('session/created', child);
    assert.equal((await host.api('summary')).value.lifetimeTotal, 150);
  } finally { host.dispose(); }
});

test('a failed live snapshot remains provisional and later complete retry replay corrects it once', async () => {
  const host = makeHost({ persistence: persistenceV2([]) }); let readable = false;
  const events = [attempt(0, 100), retry(1), usageEvent(2, 200)];
  const session = { id: 'transient', snapshotEvents() { if (!readable) throw new Error('temporarily unavailable'); return [...events]; } };
  try {
    await host.ready(); host.emit('session/event', session, events[2]);
    const partial = await host.api('summary'); assert.equal(partial.value.lifetimeTotal, 200); assert.equal(partial.value.health.status, 'partial');
    readable = true; const next = { type: 'turn/end', seq: 3, data: {} }; events.push(next); host.emit('session/event', session, next);
    const recovered = await host.api('summary'); assert.equal(recovered.value.lifetimeTotal, 300); assert.equal(recovered.value.health.legacyRecordCount, 0);
    assert.equal(recovered.value.health.accountingAdjustment, 100); assert.equal(recovered.value.health.sessionsReadFailed, 0);
    host.emit('session/event', session, next); assert.equal((await host.api('summary')).value.lifetimeTotal, 300);
  } finally { host.dispose(); }
});

test('unavailable fork ownership never counts an inherited live event as child usage', async () => {
  const host = makeHost({ records: [record('parent:1:0', 100, { accountingVersion: 2 })], persistence: persistenceV2([]) });
  const child = { id: 'uncertain-child', header: { id: 'uncertain-child', isSeeded: true, parentSession: 'parent' }, snapshotEvents() { throw new Error('unavailable'); } };
  try {
    await host.ready(); host.emit('session/event', child, usageEvent(0, 100));
    const response = await host.api('summary'); assert.equal(response.value.lifetimeTotal, 100); assert.equal(response.value.health.status, 'partial');
  } finally { host.dispose(); }
});

test('a restart serves durable totals while the session scan still runs in the background', async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const persistence = persistenceV2([{ id: 'slow', revision: 'rev-1', events: [usageEvent(0, 50)] }],
    { beforeRead: async () => { await gate; } });
  const host = makeHost({ records: [record('known:1:0', 400)], persistence });
  try {
    const debug = await host.api('debug');
    assert.equal(debug.value.health.scanInProgress, true, 'the scan must run in the background');
    assert.notEqual(debug.value.health.status, 'loading', 'a restart must not block on the scan');
    const during = await host.api('summary');
    assert.equal(during.status, 200, 'durable aggregates are served during the scan');
    assert.equal(during.value.lifetimeTotal, 400);
    assert.equal(during.value.health.scanInProgress, true);
    release();
    const settled = await host.ready();
    assert.equal(settled.scanInProgress, false);
    assert.equal(settled.sessionsReadSuccessfully, 1);
    const after = await host.api('summary');
    assert.equal(after.status, 200); assert.equal(after.value.lifetimeTotal, 450);
  } finally { host.dispose(); }
});

test('an empty ledger still blocks on the scan so a failure is never shown as zero usage', async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const persistence = { async list() { await gate; throw new Error('synthetic private read error'); } };
  const host = makeHost({ persistence });
  try {
    const debug = await host.api('debug');
    assert.equal(debug.value.health.scanInProgress, false);
    assert.equal(debug.value.health.status, 'loading', 'an empty ledger must not report ready before the scan');
    const blocked = await host.api('summary');
    assert.equal(blocked.status, 503); assert.equal(blocked.error.code, 'initializing');
    release();
    await host.ready();
    assert.equal((await host.api('summary')).status, 503, 'an unusable empty history is never served as zero usage');
  } finally { host.dispose(); }
});

test('summary, details and live usage remain available while history enumeration waits', async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const host = makeHost({ records: [record('known:1:0', 400, { accountingVersion: 1 })],
    persistence: { async list() { await gate; throw new Error('private enumeration failure'); } } });
  try {
    const summary = await host.api('summary');
    assert.equal(summary.status, 200);
    assert.equal(summary.value.health.scanInProgress, true);
    assert.equal(summary.value.health.legacyRecordCount, 1, 'startup diagnostics come from the existing ledger');
    const details = await host.api('details', { range: 'all' });
    assert.equal(details.status, 200);
    assert.equal(details.value.totalTokens, 400);
    const live = { id: 'live', events: [] };
    host.emit('session/created', live);
    const event = usageEvent(0, 50); live.events.push(event);
    host.emit('session/event', live, event);
    assert.equal((await host.api('summary')).value.lifetimeTotal, 450);
    release();
    const debug = await host.ready();
    assert.equal(debug.sourceScanStatus, 'failed');
    assert.equal(debug.scanInProgress, false);
    assert.equal((await host.api('summary')).status, 200, 'a failed background enumeration preserves saved usage');
    assert.equal((await host.api('summary')).value.lifetimeTotal, 450);
  } finally { release(); host.dispose(); }
});

test('disposing during background recovery closes the handle and never commits its pending records', async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const persistence = persistenceV2([{ id: 'slow', revision: 'rev-1', events: [usageEvent(0, 50)] }],
    { beforeRead: async () => { await gate; } });
  const host = makeHost({ records: [record('known:1:0', 400)], persistence });
  try {
    for (let i = 0; i < 20 && persistence.reads.length === 0; i += 1) await tick();
    assert.equal(persistence.reads.length, 1);
    host.dispose(); release();
    for (let i = 0; i < 20 && persistence.closed.length === 0; i += 1) await tick();
    assert.deepEqual(persistence.closed, ['slow']);
    const store = new DurableStore({ path: host.dbPath });
    try {
      assert.equal(store.globalAggregate().total_tokens, 400);
      assert.equal(store.sessionScanFailureCount(), 0, 'cancellation is never remembered as a source failure');
    } finally { store.close(); }
  } finally { release(); host.dispose(); }
});

test('history enumeration errors are reported and never pretend an empty history succeeded', async () => {
  const host = makeHost({ listError: true, persistence: persistenceV2([], { listError: true }) });
  try {
    const debug = await host.ready(); assert.equal(debug.sourceScanStatus, 'failed');
    assert.ok(debug.sessionsReadFailed > 0); assert.equal((await host.api('summary')).status, 503);
  } finally { host.dispose(); }
});

test('existing known totals remain available with a partial warning when source reads fail', async () => {
  const host = makeHost({ records: [record('known:1:0', 500)], persistence: persistenceV2([], { listError: true }) });
  try {
    await host.ready(); const response = await host.api('summary');
    assert.equal(response.status, 200); assert.equal(response.value.lifetimeTotal, 500); assert.equal(response.value.health.status, 'partial');
  } finally { host.dispose(); }
});

test('new confirmed live usage becomes available after an empty-history scan failure', async () => {
  const host = makeHost({ persistence: persistenceV2([], { listError: true }) });
  const events = []; const session = { id: 'after-failure', snapshotEvents: () => [...events] };
  try {
    await host.ready(); assert.equal((await host.api('summary')).status, 503);
    events.push(usageEvent(0, 100)); host.emit('session/event', session, events[0]);
    const response = await host.api('summary'); assert.equal(response.status, 200); assert.equal(response.value.lifetimeTotal, 100);
    assert.equal(response.value.health.status, 'partial'); assert.equal(response.value.health.sourceScanStatus, 'failed');
    assert.equal(response.value.health.historicalCoverage, 'partial');
  } finally { host.dispose(); }
});

test('live collection during an asynchronous cold scan survives stale persisted snapshots', async () => {
  let release; const held = new Promise((resolve) => { release = resolve; }); let blocked = false;
  const persistence = persistenceV2([{ id: 'racing', events: [attempt(0, 100)] }], { beforeRead: async (_id, offset) => { if (offset === 0 && !blocked) { blocked = true; await held; } } });
  const host = makeHost({ persistence });
  try {
    for (let i = 0; i < 10 && !blocked; i += 1) await tick(); assert.equal(blocked, true);
    const events = [attempt(0, 100)]; const session = { id: 'racing', snapshotEvents: () => [...events] };
    host.emit('session/created', session);
    for (const event of [retry(1), usageEvent(2, 200)]) { events.push(event); host.emit('session/event', session, event); }
    release(); await host.ready(); assert.equal((await host.api('summary')).value.lifetimeTotal, 300);
  } finally { release(); host.dispose(); }
});

test('disposal aborts an in-progress scan, unregisters routes/listeners and closes the read handle', async () => {
  let release; const held = new Promise((resolve) => { release = resolve; }); let blocked = false;
  const persistence = persistenceV2([{ id: 'cancel', events: [usageEvent(0, 100)] }], { beforeRead: async () => { blocked = true; await held; } });
  const host = makeHost({ persistence });
  for (let i = 0; i < 10 && !blocked; i += 1) await tick(); assert.equal(blocked, true);
  host.dispose(); release();
  for (let i = 0; i < 10 && persistence.closed.length === 0; i += 1) await tick();
  assert.equal(host.routeDisposed, true); assert.equal(host.listenerCount, 0); assert.deepEqual(persistence.closed, ['cancel']);
  const reopened = new DurableStore({ path: host.dbPath }); assert.equal(reopened.recordCount(), 0); reopened.close();
});

test('trust fence, invalid JSON and oversized bodies are handled before mutation', async () => {
  const host = makeHost({ persistence: persistenceV2([]) });
  try {
    await host.ready();
    assert.equal((await host.api('summary', {}, { headers: { host: 'evil.example' } })).status, 403);
    assert.equal((await host.api('summary', {}, { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await host.api('summary', {}, { body: '{broken' })).status, 400);
    assert.equal((await host.api('summary', {}, { body: 'x'.repeat(65_537) })).status, 413);
    assert.equal((await host.api('details', { range: 'invalid' })).status, 400);
  } finally { host.dispose(); }
});
