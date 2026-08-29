// Source-discovery tests use only synthetic DSH storage-unit fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverTokenSources } from '../src/usage/durable/sourceDiscovery.ts';
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
