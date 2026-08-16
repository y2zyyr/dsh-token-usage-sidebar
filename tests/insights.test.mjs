import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUsageInsights, lastSevenLocalDates } from '../src/usage/insights.ts';
import { emptyLedger, recordUsage } from '../src/usage/ledger.ts';

const NOW = new Date(2026, 7, 16, 12, 0, 0).getTime();

function record(id, date, seq, buckets, source = {}) {
  const totalTokens = buckets.input + buckets.output + (buckets.read ?? 0) + (buckets.write ?? 0);
  return {
    id, source: 'assistant/message', sessionId: id.split(':')[0], turn: 1, step: 0, seq,
    timestamp: NOW, localDate: date, inputTokens: buckets.input, outputTokens: buckets.output,
    cacheReadTokens: buckets.read ?? 0, cacheWriteTokens: buckets.write ?? 0,
    reasoningTokens: buckets.reasoning ?? 0, totalTokens, accounting: 'exact', ...source,
  };
}

test('last seven local dates include today, prior six days, and no gaps', () => {
  const dates = lastSevenLocalDates(NOW);
  assert.equal(dates.length, 7);
  assert.equal(dates.at(-1), '2026-08-16');
  assert.equal(dates[0], '2026-08-10');
  for (let i = 1; i < dates.length; i++) {
    const previous = new Date(dates[i - 1] + 'T12:00:00');
    previous.setDate(previous.getDate() + 1);
    assert.equal(dates[i], [previous.getFullYear(), String(previous.getMonth() + 1).padStart(2, '0'), String(previous.getDate()).padStart(2, '0')].join('-'));
  }
});

test('range aggregation keeps buckets, reasoning, calls, and models distinct', () => {
  const dates = lastSevenLocalDates(NOW);
  let ledger = emptyLedger(NOW);
  ledger = recordUsage(ledger, record('a:1:0', dates[6], 3, { input: 100, output: 50, read: 20, write: 5, reasoning: 30 }, { provider: 'deepseek', model: 'v4' }));
  ledger = recordUsage(ledger, record('b:1:0', dates[5], 2, { input: 200, output: 80, read: 0, reasoning: 20 }, { provider: 'openai', model: 'gpt' }));
  ledger = recordUsage(ledger, record('c:1:0', dates[0], 2, { input: 10, output: 5 }, { provider: 'deepseek', model: 'v4' }));
  const today = buildUsageInsights(ledger, 'today', NOW);
  assert.equal(today.totalTokens, 175);
  assert.deepEqual(today.categories, { totalTokens: 175, inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 5, reasoningTokens: 30, callCount: 1 });
  assert.equal(today.models[0].provider, 'deepseek');
  assert.equal(today.models[0].model, 'v4');
  const week = buildUsageInsights(ledger, '7d', NOW);
  assert.equal(week.totalTokens, 470);
  assert.equal(week.categories.reasoningTokens, 50, 'reasoning is displayed but not added to total');
  assert.deepEqual(week.daily.map((d) => d.date), dates, 'zero-value days are retained');
  assert.equal(week.models.length, 2);
  assert.equal(week.models[0].provider, 'openai', 'models are sorted by total descending');
  const yesterday = buildUsageInsights(ledger, 'yesterday', NOW);
  assert.equal(yesterday.totalTokens, 280);
});

test('legacy records remain in all-time total as explicit unknown coverage', () => {
  const dates = lastSevenLocalDates(NOW);
  let ledger = emptyLedger(NOW);
  ledger = recordUsage(ledger, record('known:1:0', dates[6], 1, { input: 100, output: 50 }, { provider: 'p', model: 'm' }));
  ledger = { ...ledger, byId: { ...ledger.byId, 'legacy:1:0': 77 }, recordCount: 2, lifetimeTotal: 227 };
  const all = buildUsageInsights(ledger, 'all', NOW);
  assert.equal(all.totalTokens, 227);
  assert.equal(all.categories.totalTokens, 150);
  assert.equal(all.unknownTokens, 77);
  assert.equal(all.unknownCallCount, 1);
  assert.equal(all.models.length, 1, 'an undated old record is not assigned a fabricated model');
  const today = buildUsageInsights(ledger, 'today', NOW);
  assert.equal(today.totalTokens, 150, 'undated legacy record is not invented into a natural day');
});
