// Source-discovery tests use only synthetic DSH storage-unit fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, utimesSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverTokenSources, importTokenSources } from '../src/usage/durable/sourceDiscovery.ts';
import { DurableStore } from '../src/usage/durable/durableStore.ts';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dts-source-discovery-'));
}

function record(id, total, seq = 1, localDate = '2026-08-29', extra = {}) {
  const parts = id.split(':');
  return {
    id,
    source: 'assistant/message',
    sessionId: parts.slice(0, -2).join(':') || id,
    turn: Number(parts.at(-2)) || 0,
    step: Number(parts.at(-1)) || 0,
    seq,
    timestamp: Date.parse(`${localDate}T12:00:00`),
    localDate,
    provider: 'synthetic-provider',
    model: 'synthetic-model',
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

function writeRecordUnit(dir, name, records) {
  writeFileSync(join(dir, name), JSON.stringify({
    unit: { name: name.replace(/\.json$/, ''), version: 1 },
    global: null,
    tables: { records: Object.fromEntries(records.map((item) => [item.id, item])) },
  }));
}

test('discovers record-table units and verifies an aggregate-only companion', () => {
  const dir = tempDir();
  const records = [record('a:1:0', 10), record('b:1:0', 20)];
  writeRecordUnit(dir, 'dsh_token_usage_day_20260829.json', records);
  writeFileSync(join(dir, 'dsh_token_usage_v11.json'), JSON.stringify({
    unit: { name: 'dsh_token_usage_v11', version: 1 },
    global: null,
    tables: {
      meta: { root: { meta: { schemaVersion: 1 }, aggregate: {
        global: { input: 30, output: 0, cacheRead: 0, cacheWrite: 0, recordCount: 2, calls: 2 },
      } } },
    },
  }));
  writeFileSync(join(dir, 'dsh_token_usage_day_20260829.json.bak'), 'not a candidate');

  const result = discoverTokenSources(dir);
  assert.equal(result.status, 'complete');
  assert.equal(result.records.length, 2);
  assert.equal(result.aggregateChecks.discoveredTotal, 30);
  assert.equal(result.aggregateChecks.expectedTotal, 30);
  assert.equal(result.aggregateChecks.expectedRecordCount, 2);
  assert.equal(result.sources.filter((source) => source.format === 'record-table').length, 1);
  assert.equal(result.sources.filter((source) => source.format === 'aggregate-summary').length, 1);
  assert.ok(result.records.every((item) => item.sourceType === 'legacy_store'));
  assert.ok(result.records.every((item) => item.sourcePath?.endsWith('dsh_token_usage_day_20260829.json')));
});

test('deduplicates the same canonical invocation by highest sequence', () => {
  const dir = tempDir();
  writeRecordUnit(dir, 'dsh_token_usage_day_20260828.json', [record('same:2:0', 10, 4, '2026-08-28')]);
  writeRecordUnit(dir, 'dsh_token_usage_day_20260829.json', [record('same:2:0', 25, 9, '2026-08-29')]);

  const result = discoverTokenSources(dir);
  assert.equal(result.status, 'complete');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].seq, 9);
  assert.equal(result.records[0].totalTokens, 25);
  assert.equal(result.records[0].localDate, '2026-08-29');

  const store = new DurableStore({ path: join(dir, 'usage.sqlite') });
  const first = store.apply(result.records);
  const second = store.apply(result.records);
  assert.equal(first.added, 1);
  assert.equal(second.ignored, 1);
  assert.equal(store.globalAggregate()?.total_tokens, 25);
  assert.equal(store.recordCount(), 1);
  store.close();
});

test('reports a partial discovery when a recognized unit is malformed', () => {
  const dir = tempDir();
  writeRecordUnit(dir, 'dsh_token_usage_day_20260828.json', [record('valid:1:0', 7, 1, '2026-08-28')]);
  writeFileSync(join(dir, 'dsh_token_usage_day_20260829.json'), '{broken');

  const result = discoverTokenSources(dir);
  assert.equal(result.status, 'partial');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].totalTokens, 7);
  assert.ok(result.errors.some((message) => message.includes('JSON parse failed')));
});

test('successful source imports survive restart and cache unchanged files without replaying records', () => {
  const dir = tempDir(), path = join(dir, 'usage.sqlite'), name = 'dsh_token_usage_day_20260829.json';
  writeRecordUnit(dir, name, [record('cached:1:0', 10)]);
  const original = statSync(join(dir, name));
  const first = new DurableStore({ path });
  assert.equal(importTokenSources(first, dir).applied, 1); first.close();
  const store = new DurableStore({ path }); const apply = store.apply.bind(store);
  store.apply = () => { throw new Error('unchanged source must not be replayed'); };
  const cached = importTokenSources(store, dir);
  assert.equal(cached.discovery.cached, true); assert.equal(cached.discovery.aggregateChecks.discoveredRecordCount, 1);
  assert.equal(cached.applied, 0); assert.equal(store.globalAggregate().total_tokens, 10); store.apply = apply;
  // Same size and restored mtime still invalidates via inode/ctime metadata.
  writeRecordUnit(dir, name, [record('cached:1:0', 20, 2)]);
  utimesSync(join(dir, name), original.atime, original.mtime);
  const changed = importTokenSources(store, dir);
  assert.notEqual(changed.discovery.cached, true); assert.equal(changed.applied, 1); assert.equal(store.globalAggregate().total_tokens, 20);
  unlinkSync(join(dir, name)); assert.equal(importTokenSources(store, dir).discovery.status, 'none');
  assert.equal(store.globalAggregate().total_tokens, 20); store.close();
});

test('failed source scans are never cached as successful and are retried after repair', () => {
  const dir = tempDir(), name = 'dsh_token_usage_day_20260829.json';
  writeFileSync(join(dir, name), '{broken'); const store = new DurableStore({ path: join(dir, 'usage.sqlite') });
  for (let i = 0; i < 2; i += 1) {
    const result = importTokenSources(store, dir); assert.equal(result.discovery.status, 'failed'); assert.notEqual(result.discovery.cached, true);
  }
  writeRecordUnit(dir, name, [record('repaired:1:0', 10)]);
  assert.equal(importTokenSources(store, dir).applied, 1); assert.equal(store.globalAggregate().total_tokens, 10); store.close();
});

test('source cache and imported records commit together; repaired aggregates invalidate the cache', () => {
  const dir = tempDir(), path = join(dir, 'usage.sqlite');
  writeRecordUnit(dir, 'dsh_token_usage_day_20260829.json', [record('atomic:1:0', 10)]);
  const store = new DurableStore({ path }); const save = store.writeSourceDiscoveryCache.bind(store);
  store.writeSourceDiscoveryCache = () => { throw new Error('simulated interruption'); };
  assert.throws(() => importTokenSources(store, dir), /simulated interruption/);
  assert.equal(store.recordCount(), 0); assert.equal(store.readSourceDiscoveryCache(), undefined);
  store.writeSourceDiscoveryCache = save; assert.equal(importTokenSources(store, dir).applied, 1);
  store.database.exec('DELETE FROM usage_records'); store.close();
  const reopened = new DurableStore({ path }); assert.equal(reopened.repairedOnOpen, true);
  assert.equal(importTokenSources(reopened, dir).applied, 1); assert.equal(reopened.globalAggregate().total_tokens, 10); reopened.close();
});

test('invalid source buckets and missing totals are rejected instead of being coerced into calls', () => {
  const dir = tempDir();
  writeRecordUnit(dir, 'dsh_token_usage_day_20260829.json', [record('good:1:0', 10),
    record('negative:1:0', 10, 1, undefined, { cacheReadTokens: -1 }),
    record('fractional:1:0', 10, 1, undefined, { seq: 1.5 }),
    record('missing:1:0', 10, 1, undefined, { totalTokens: undefined })]);
  const result = discoverTokenSources(dir); assert.equal(result.status, 'partial'); assert.equal(result.errors.length, 3);
  assert.deepEqual(result.records.map((item) => item.id), ['good:1:0']);
});
