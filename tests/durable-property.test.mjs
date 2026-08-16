// tests/durable-property.test.mjs — v1.1 SQLite store vs reference v1 ledger
// equivalence over randomized records + replacements (property test) and
// concurrent-write serialization.
import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { emptyLedger, foldRecords, totalForDay } from '../src/usage/ledger.ts';
import { buildUsageInsights } from '../src/usage/insights.ts';
import { DurableStore } from '../src/usage/durable/durableStore.ts';
import { DurableAggregator } from '../src/usage/durable/durableAggregator.ts';

const DATES = ['2026-08-10','2026-08-11','2026-08-12','2026-08-13','2026-08-14','2026-08-15','2026-08-16'];
const PROVIDERS = ['deepseek','openai','anthropic'];
const MODELS = ['v4','gpt-4o','claude-3.7','dummy'];
// deterministic PRNG so failures are reproducible
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function makeRec(id, seq, total, date, provider, model, extra = {}) {
  const p = id.split(':');
  const step = Number(p[p.length-1])||0; const turn = Number(p[p.length-2])||0;
  const sid = p.slice(0,-2).join(':');
  return {
    id, source: 'assistant/message', sessionId: sid||id, turn, step, seq,
    timestamp: Date.parse(date + 'T12:00:00'), localDate: date,
    provider, model,
    inputTokens: extra.inputTokens ?? total, outputTokens: extra.outputTokens ?? 0,
    cacheReadTokens: extra.cacheReadTokens ?? 0, cacheWriteTokens: extra.cacheWriteTokens ?? 0,
    reasoningTokens: extra.reasoningTokens ?? 0, totalTokens: total,
    accounting: 'exact', sourceType: 'live_event',
  };
}

test('property: random records + replacements match reference in-memory ledger', () => {
  const rand = rng(0xD5EE2);
  const dir = mkdtempSync(join(tmpdir(), 'prop-'));
  const store = new DurableStore({ path: join(dir, 'usage.db') });

  const SESSIONS = 12;
  const ids = [];
  for (let s = 0; s < SESSIONS; s++) for (let t = 0; t < 5; t++) for (let k = 0; k < 4; k++) ids.push('sess' + s + ':' + t + ':' + k);
  const events = [];
  const N = 1500;
  // DSH contract: seq is monotonically increasing per (session) event append, so a
  // re-delivery for an id has a strictly higher seq (chunk -> final). We model that
  // per-id monotonic seq while interleaving many ids arbitrarily.
  const maxSeqPerId = new Map();
  for (let i = 0; i < N; i++) {
    const id = ids[Math.floor(rand() * ids.length)];
    const seq = (maxSeqPerId.get(id) ?? 0) + 1 + Math.floor(rand() * 20);
    maxSeqPerId.set(id, seq);
    const total = 10 + Math.floor(rand() * 50000);
    const date = DATES[Math.floor(rand() * DATES.length)];
    const provider = PROVIDERS[Math.floor(rand() * PROVIDERS.length)];
    const model = MODELS[Math.floor(rand() * MODELS.length)];
    const rec = makeRec(id, seq, total, date, provider, model);
    events.push(rec);
    store.apply([rec]);
  }

  // reference: fold all events (higher seq wins per id) - same semantics as store
  const reference = foldRecords(emptyLedger(), events);

  // compare lifetime
  assert.equal(store.globalAggregate().total_tokens, reference.lifetimeTotal, 'lifetimeTotal mismatch');
  assert.equal(store.recordCount(), reference.recordCount, 'recordCount mismatch');
  assert.equal(store.verifyAggregates().ok, true, 'aggregates must be internally consistent');

  // compare daily totals across all dates (only set counts; set semantics match lifetime)
  for (const date of DATES) {
    const refDay = totalForDay(reference, date);
    const storeDay = store.daily(date)?.total_tokens ?? 0;
    assert.equal(storeDay, refDay, 'day total mismatch for ' + date);
  }
  store.close();
});

test('property: aggregate rebuild from records reproduces identical insights vs fold', () => {
  const rand = rng(0xC0FFEE);
  const dir = mkdtempSync(join(tmpdir(), 'prop2-'));
  const store = new DurableStore({ path: join(dir, 'usage.db') });
  const now = Date.parse('2026-08-16T12:00:00');
  const events = [];
  const maxSeq = new Map();
  for (let i = 0; i < 600; i++) {
    const id = 'p' + Math.floor(rand()*30) + ':' + (Math.floor(rand()*4)) + ':' + 0;
    const seq = (maxSeq.get(id) ?? 0) + 1 + Math.floor(rand()*20);
    maxSeq.set(id, seq);
    const total = 5 + Math.floor(rand()*2000);
    const date = DATES[Math.floor(rand()*DATES.length)];
    const provider = PROVIDERS[Math.floor(rand()*PROVIDERS.length)];
    const model = MODELS[Math.floor(rand()*MODELS.length)];
    const rec = makeRec(id, seq, total, date, provider, model);
    events.push(rec);
    store.apply([rec]);
  }
  // Corrupt then rebuild
  store.database.exec('UPDATE aggregate_global SET total_tokens = 0');
  store.rebuildAggregates();
  assert.equal(store.verifyAggregates().ok, true);

  const reference = foldRecords(emptyLedger(), events);
  const agg = new DurableAggregator(store, { now: () => now });
  const all = agg.insights('all');
  const refAll = buildUsageInsights(reference, 'all', now);
  assert.equal(all.totalTokens, refAll.totalTokens, 'all-total mismatch');
  assert.equal(all.categories.callCount, refAll.categories.callCount, 'call count mismatch');
  assert.equal(all.unknownTokens, refAll.unknownTokens, 'unknown tokens mismatch');
  // model aggregation should agree on the top aggregate per provider+model
  const sortM = (arr) => [...arr].sort((a,b)=> b.totalTokens-a.totalTokens || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  const sm = sortM(all.models), srm = sortM(refAll.models);
  assert.equal(sm.length, srm.length, 'model list length mismatch');
  for (let i = 0; i < sm.length; i++) {
    assert.equal(sm[i].totalTokens, srm[i].totalTokens, 'model total mismatch for ' + sm[i].provider + '/' + sm[i].model);
    assert.equal(sm[i].callCount, srm[i].callCount, 'model call mismatch');
  }
  agg.close();
});

test('property: concurrent batch writes serialize without corruption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conc-'));
  const store = new DurableStore({ path: join(dir, 'usage.db') });
  const writers = Array.from({ length: 8 }, (_, w) => {
    return new Promise((resolve) => {
      let i = 0;
      const step = () => {
        if (i >= 200) return resolve();
        const id = 'w' + w + ':' + 1 + ':' + i;
        const rec = makeRec(id, i + 1, 10 + i, '2026-08-' + String(10 + (i % 7)).padStart(2,'0'), 'deepseek', 'v4');
        store.apply([rec]);
        i++;
        setImmediate(step);
      };
      setImmediate(step);
    });
  });
  await Promise.all(writers);
  assert.equal(store.verifyAggregates().ok, true, 'aggregates inconsistent after concurrent writes');
  assert.equal(store.recordCount(), 8 * 200, 'all concurrent records recorded');
  store.close();
});

test('property: incremental provenance split equals full recompute (no O(N) scan on write path)', () => {
  const rand = rng(0x51A7);
  const dir = mkdtempSync(join(tmpdir(), 'split-'));
  const store = new DurableStore({ path: join(dir, 'usage.db'), now: () => Date.parse('2026-08-16T12:00:00') });
  const SRC = ['live_event', 'session_log', 'other'];
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const id = 's' + (Math.floor(rand() * 20)) + ':' + 1 + ':' + 0;
    seen.add(id);
    const seq = 1 + Math.floor(rand() * 100);
    const total = 1 + Math.floor(rand() * 1000);
    const st = SRC[Math.floor(rand() * SRC.length)];
    const r = makeRec(id, seq, total, '2026-08-16', 'deepseek', 'v4');
    r.sourceType = st;
    const unclassified = rand() < 0.25;
    if (unclassified) { r.inputTokens = 0; r.outputTokens = 0; r.cacheReadTokens = 0; r.cacheWriteTokens = 0; r.totalTokens = total; }
    store.apply([r]);
    const inc = store.readMeta();
    const full = store.provenanceSplit();
    assert.equal(inc.liveRecordedTotal, full.live, 'live split mismatch at ' + i);
    assert.equal(inc.historicalRecoveredTotal, full.historical, 'hist split mismatch at ' + i);
    assert.equal(inc.historicalRecoveredRecordCount, full.historicalCount, 'hist count mismatch at ' + i);
  }
  store.close();
});
