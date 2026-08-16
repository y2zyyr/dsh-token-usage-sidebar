// scripts/bench.mjs — ledger scalability benchmark (v1.0.1).
// Measures how the current root-JSON ledger behaves as the invocation count
// grows. Run: node --experimental-strip-types scripts/bench.mjs
// WARNING: run with --disable-warning=ExperimentalWarning to suppress noise.
import { performance } from 'node:perf_hooks';
import { emptyLedger, recordUsage, foldRecords } from '../src/usage/ledger.ts';
import { zstdCompressSync } from 'node:zlib';

const mk = (id, seq) => ({
  id, source: 'assistant/message', sessionId: 'sess' + (id % 100),
  turn: Math.floor(id / 1000), step: id % 1000, seq,
  timestamp: 1, localDate: '2026-08-16',
  inputTokens: 100 + (id % 500), outputTokens: 50, cacheReadTokens: 20,
  cacheWriteTokens: 0, reasoningTokens: 0,
  totalTokens: 170 + (id % 500), accounting: 'exact', sourceType: 'live_event',
});

function runSize(n) {
  const records = Array.from({ length: n }, (_, i) => mk(i, i));
  const t0 = performance.now();
  let l = foldRecords(emptyLedger(), records);
  const foldMs = performance.now() - t0;

  const rec = mk(n + 1, n + 1);
  const t1 = performance.now();
  l = recordUsage(l, rec);
  const singleMs = performance.now() - t1;

  const t2 = performance.now();
  const json = JSON.stringify(l);
  const serMs = performance.now() - t2;
  const bytes = Buffer.byteLength(json, 'utf8');

  const t3 = performance.now();
  zstdCompressSync(Buffer.from(json, 'utf8'));
  const zstdMs = performance.now() - t3;

  return {
    n, recordCount: Object.keys(l.byId).length,
    foldMs: Number(foldMs.toFixed(1)),
    singleUs: Number((singleMs * 1000).toFixed(1)),
    serMs: Number(serMs.toFixed(1)),
    jsonKB: Number((bytes / 1024).toFixed(1)),
    zstdMs: Number(zstdMs.toFixed(1)),
  };
}

const sizes = [1000, 5000, 10000, 50000].filter((s) => s <= (Number(process.env.BENCH_MAX) || 50000));
console.log('size\tfoldMs\tsingleUs\tjsonKB\tzstdMs');
for (const n of sizes) {
  const r = runSize(n);
  console.log([r.n, r.foldMs, r.singleUs, r.jsonKB, r.zstdMs].join('\t'));
}
console.log('\nNote: single recordUsage is O(N) because every recordUsage spreads the\nfull byId/dayBy/seqBy/detailBy/src maps (O(N) copy per event).');
