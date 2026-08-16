// scripts/bench-sqlite.mjs — v1.1 SQLite durable ledger benchmark
// Measures SQLite store behavior as invocation count grows.
import { performance } from 'node:perf_hooks';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableStore } from '../src/usage/durable/durableStore.ts';
import { DurableAggregator } from '../src/usage/durable/durableAggregator.ts';

const DAY = '2026-08-16';
function mk(i, seq) {
  return { id: 'sess' + (i % 200) + ':' + Math.floor(i / 200) + ':' + (i % 10), source: 'assistant/message', sessionId: 'sess' + (i % 200),
    turn: Math.floor(i / 200), step: i % 10, seq, timestamp: Date.parse(DAY + 'T12:00:00'), localDate: DAY,
    provider: 'deepseek', model: 'v4', inputTokens: 100 + (i % 500), outputTokens: 50, cacheReadTokens: 20,
    cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 170 + (i % 500), accounting: 'exact', sourceType: 'live_event' };
}

function bench(n) {
  const dir = mkdtempSync(join(tmpdir(), 'benchs-'));
  const store = new DurableStore({ path: join(dir, 'usage.db') });
  const records = Array.from({ length: n }, (_, i) => mk(i, i * 2 + 1));
  const t0 = performance.now();
  store.apply(records);
  const bulkMs = performance.now() - t0;
  const t1 = performance.now();
  for (let i = 0; i < 50; i++) store.apply([mk(n + 100 + i, 1000000 + i * 2)]);
  const singleMs = (performance.now() - t1) / 50;
  const t2 = performance.now();
  for (let i = 0; i < 1000; i++) store.apply([mk(99999 + i, 2000000 + i * 2)]);
  const seqMs = performance.now() - t2;
  const t3 = performance.now();
  store.apply([mk(n + 1, 9999999)]);
  const replMs = performance.now() - t3;
  const agg = new DurableAggregator(store, { now: () => Date.parse(DAY + 'T12:00:00') });
  const t4 = performance.now();
  const summary = agg.summary();
  const summaryMs = performance.now() - t4;
  const t5 = performance.now();
  const d7 = agg.insights('7d');
  const d7Ms = performance.now() - t5;
  const t6 = performance.now();
  const all = agg.insights('all');
  const allMs = performance.now() - t6;
  const db = join(dir, 'usage.db');
  const size = statSync(db).size;
  console.log(n + '\t' + bulkMs.toFixed(1) + '\t' + (singleMs * 1000).toFixed(2) + 'us\t' + (seqMs / 1000 * 1000).toFixed(1) + 'us/w\t' + (replMs * 1000).toFixed(2) + 'us\t' + summaryMs.toFixed(3) + '\t' + d7Ms.toFixed(2) + '\t' + allMs.toFixed(2) + '\t' + size + '\t' + summary.lifetimeTotal);
  const mem = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log('  heapUsed(MB): ' + mem.toFixed(1));
  agg.close(); store.close();
}

const SIZES = [1000, 10000, 50000, 100000, 500000].filter((s) => s <= (Number(process.env.BENCH_MAX) || 500000));
console.log('rows\tbulkMs\tsingleUs\tseqUs/w\treplUs\tsummaryMs\t7dMs\tallMs\tdbSize\tlifetime');
for (const n of SIZES) bench(n);
console.log('\nNote: singleUs = avg of 50 single upserts on top of existing n rows; seqUs/w = 1000 sequential writes.');
