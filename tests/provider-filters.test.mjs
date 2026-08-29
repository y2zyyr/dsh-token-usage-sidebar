import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableStore } from '../src/usage/durable/durableStore.ts';
import { DurableAggregator } from '../src/usage/durable/durableAggregator.ts';

const NOW = Date.parse('2026-08-16T12:00:00');

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), 'dts-provider-filter-'));
  return join(dir, 'usage.db');
}

function record(id, date, total, extra = {}) {
  const [sessionId, turn, step] = id.split(':');
  return {
    id,
    source: 'assistant/message',
    sessionId,
    turn: Number(turn),
    step: Number(step),
    seq: 1,
    timestamp: Date.parse(date + 'T12:00:00'),
    localDate: date,
    inputTokens: total,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: total,
    accounting: 'exact',
    sourceType: 'live_event',
    ...extra,
  };
}

function seedStore() {
  const path = tempPath();
  const store = new DurableStore({ path, now: () => NOW });
  store.apply([
    record('scnet:1:0', '2026-08-16', 100, { provider: 'scnet', model: 'deepseek-v4' }),
    record('SCNET:1:0', '2026-08-15', 50, { provider: 'SCNET', model: 'deepseek-v4' }),
    record('my:1:0', '2026-08-16', 80, { provider: 'my-provider', model: 'deepseek-v4' }),
    record('my:2:0', '2026-08-16', 20, { provider: 'my-provider', model: 'other-model' }),
    record('unknown:1:0', '2026-08-16', 77, { inputTokens: 0 }),
  ]);
  return { store, path };
}

test('provider facets are dynamic and raw names remain exact', () => {
  const { store } = seedStore();
  const agg = new DurableAggregator(store, { now: () => NOW });
  const all = agg.insights('all');
  assert.deepEqual(all.facets.groups, []);
  assert.deepEqual(all.facets.providers.filter((p) => p.type === 'raw').map((p) => p.label).sort(), ['my-provider', 'SCNET', 'scnet'].sort());
  assert.ok(!all.facets.providers.some((p) => p.type === 'group' && p.label === 'SCNET'));

  const onlyScnet = agg.insights('all', { provider: { type: 'raw', value: 'scnet' } });
  assert.equal(onlyScnet.totalTokens, 100);
  assert.equal(onlyScnet.models.length, 1);
  assert.equal(onlyScnet.models[0].provider, 'scnet');

  const modelAcrossProviders = agg.insights('all', { model: 'deepseek-v4' });
  assert.equal(modelAcrossProviders.totalTokens, 230);
  assert.deepEqual(modelAcrossProviders.models.map((m) => m.provider).sort(), ['my-provider', 'scnet', 'SCNET'].sort());
  agg.close();
});

test('a user with a custom provider gets no empty preset provider option', () => {
  const store = new DurableStore({ path: tempPath(), now: () => NOW });
  store.apply([record('custom:1:0', '2026-08-16', 42, { provider: 'my-provider', model: 'custom-model' })]);
  const details = new DurableAggregator(store, { now: () => NOW }).insights('all');
  assert.deepEqual(details.facets.providers, [{ type: 'raw', value: 'my-provider', label: 'my-provider', rawValues: ['my-provider'] }]);
  store.close();
});

test('local alias groups merge only configured raw values and expose a breakdown', () => {
  const { store, path } = seedStore();
  store.upsertProviderAliasGroup({ id: 'scnet-group', label: 'SCNET', rawValues: ['scnet', 'SCNET'] });
  const agg = new DurableAggregator(store, { now: () => NOW });
  const all = agg.insights('all');
  const group = all.facets.providers.find((p) => p.type === 'group' && p.value === 'scnet-group');
  assert.deepEqual(group?.rawValues, ['scnet', 'SCNET']);

  const merged = agg.insights('all', { provider: { type: 'group', id: 'scnet-group' }, model: 'deepseek-v4' });
  assert.equal(merged.totalTokens, 150);
  assert.equal(merged.categories.callCount, 2);
  assert.equal(merged.models.length, 1);
  assert.equal(merged.models[0].provider, 'SCNET');
  assert.deepEqual(merged.models[0].rawProviders?.map((m) => [m.provider, m.totalTokens]), [['scnet', 100], ['SCNET', 50]]);
  assert.equal(merged.excludedUnclassified.tokens, 77);
  agg.close();

  const reopened = new DurableStore({ path, now: () => NOW });
  assert.deepEqual(reopened.listProviderAliasGroups(), [{ id: 'scnet-group', label: 'SCNET', rawValues: ['scnet', 'SCNET'] }]);
  assert.deepEqual(reopened.listRecords().map((entry) => entry.provider).filter(Boolean).sort(), ['SCNET', 'my-provider', 'my-provider', 'scnet'].sort());
  assert.equal(reopened.deleteProviderAliasGroup('scnet-group'), true);
  const afterDelete = new DurableAggregator(reopened, { now: () => NOW }).insights('all', { provider: { type: 'raw', value: 'SCNET' } });
  assert.equal(afterDelete.totalTokens, 50);
  reopened.close();
});

test('alias groups reject overlapping raw names', () => {
  const store = new DurableStore({ path: tempPath(), now: () => NOW });
  store.upsertProviderAliasGroup({ id: 'one', label: 'One', rawValues: ['provider-a'] });
  assert.throws(() => store.upsertProviderAliasGroup({ id: 'two', label: 'Two', rawValues: ['provider-a'] }), /provider-alias-overlap/);
  store.close();
});

test('alias configuration is isolated per local ledger', () => {
  const first = new DurableStore({ path: tempPath(), now: () => NOW });
  const second = new DurableStore({ path: tempPath(), now: () => NOW });
  first.upsertProviderAliasGroup({ id: 'private-group', label: 'Private', rawValues: ['my-provider'] });
  assert.deepEqual(second.listProviderAliasGroups(), []);
  first.close();
  second.close();
});

test('filtered seven-day details preserve zero days and exclude unclassified totals', () => {
  const { store } = seedStore();
  const agg = new DurableAggregator(store, { now: () => NOW });
  const filtered = agg.insights('7d', { provider: { type: 'raw', value: 'scnet' } });
  assert.equal(filtered.totalTokens, 100);
  assert.equal(filtered.daily.length, 7);
  assert.equal(filtered.daily.find((day) => day.date === '2026-08-16')?.totalTokens, 100);
  assert.equal(filtered.daily.find((day) => day.date === '2026-08-15')?.totalTokens, 0);
  assert.equal(filtered.excludedUnclassified.tokens, 77);
  assert.equal(filtered.unknownTokens, 0);
  agg.close();
});

test('an unknown record is never assigned to a provider alias', () => {
  const { store } = seedStore();
  store.upsertProviderAliasGroup({ id: 'all-scnet', label: 'SCNET', rawValues: ['scnet', 'SCNET'] });
  const agg = new DurableAggregator(store, { now: () => NOW });
  const selected = agg.insights('all', { provider: { type: 'group', id: 'all-scnet' } });
  assert.equal(selected.totalTokens, 150);
  assert.equal(selected.models.some((model) => model.provider === 'Unknown provider'), false);
  assert.equal(selected.excludedUnclassified.tokens, 77);
  agg.close();
});
