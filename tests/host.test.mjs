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
      for (let i = 0; i < 100; i += 1) {
        const debug = await this.api('debug');
        if (debug.value.health.status !== 'loading') return debug.value;
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
