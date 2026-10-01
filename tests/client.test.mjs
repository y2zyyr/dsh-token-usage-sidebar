import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { tick, DAY } from './fixtures.mjs';
import { usageRequest } from '../src/client/request.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'package.json'));
const output = mkdtempSync(join(tmpdir(), 'dtsu-react-'));
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
const saved = new Map();
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}
let hidden = false; Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true });
const originalFetch = globalThis.fetch;
await build({ entryPoints: [join(root, 'src/client/index.tsx'), join(root, 'src/client/settings.tsx')], outdir: output,
  outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', logLevel: 'silent',
  define: { __DTSU_PLUGIN_VERSION__: JSON.stringify('test') },
  plugins: [{ name: 'external-react', setup(builder) {
    builder.onResolve({ filter: /^(react|react-dom)(\/|$)/ }, ({ path }) => ({ path: require.resolve(path), external: true }));
  } }],
});
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { TokenUsageSidebar } = await import(pathToFileURL(join(output, 'index.mjs')).href);
const { TokenUsageSettings } = await import(pathToFileURL(join(output, 'settings.mjs')).href);
const t = (key) => ({ today: 'Today', yesterday: 'Yesterday', '7d': '7D', all: 'All time', total: 'Total',
  unavailable: 'Could not refresh usage.', lastUpdated: 'Last updated', partialHistory: 'Some history is unverified.', accountingAdjusted: 'Verified adjustment' })[key] ?? key;
const response = (value, ok = true) => ({ ok, async json() { return { ok, value }; } });
const summary = (tokens) => ({ todayTotal: tokens, yesterdayTotal: 0, lifetimeTotal: tokens, recordCount: 1, todayDate: DAY, serverNow: DAY });
function details(range, tokens, unknown = 0, health) {
  const metrics = { totalTokens: tokens - unknown, inputTokens: tokens - unknown, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, reasoningTokens: 0, callCount: 1 };
  return { range, totalTokens: tokens, categories: metrics, unknownTokens: unknown, unknownCallCount: unknown ? 1 : 0,
    rangeStartDate: '2026-09-25', rangeEndDate: DAY, daily: [{ date: DAY, ...metrics, totalTokens: tokens, unknownTokens: unknown }],
    models: [], health, filters: { provider: null, model: null }, facets: { providers: [], models: [], pairs: [], groups: [] } };
}
async function mounted(Component) {
  const container = document.createElement('div'); document.body.append(container);
  const reactRoot = createRoot(container);
  await act(async () => { reactRoot.render((await import('react')).createElement(Component, { t })); await tick(); });
  return { container, async close() { await act(async () => { reactRoot.unmount(); }); container.remove(); } };
}
function visibilityRefresh() {
  hidden = true; document.dispatchEvent(new dom.window.Event('visibilitychange'));
  hidden = false; document.dispatchEvent(new dom.window.Event('visibilitychange'));
}
after(() => {
  globalThis.fetch = originalFetch; dom.window.close(); rmSync(output, { recursive: true, force: true });
  for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
});

test('rendered daily total includes unknown tokens exactly once', async () => {
  globalThis.fetch = async (_url, init) => response(details(JSON.parse(init.body).range, 177, 77));
  const view = await mounted(TokenUsageSettings);
  try {
    const row = view.container.querySelector('.dtsu-daily-compact tbody tr');
    assert.equal(row.children[1].textContent, '177'); assert.equal(view.container.querySelector('.dtsu-metric strong').textContent, '177');
  } finally { await view.close(); }
});

test('switching range and failing the request never labels previous seven-day numbers as Today', async () => {
  globalThis.fetch = async (_url, init) => {
    const range = JSON.parse(init.body).range; return range === 'today' ? response(undefined, false) : response(details(range, 770));
  };
  const view = await mounted(TokenUsageSettings);
  try {
    assert.equal(view.container.querySelector('.dtsu-metric strong').textContent, '770');
    const today = [...view.container.querySelectorAll('[role=tab]')].find((button) => button.textContent === 'Today');
    await act(async () => { today.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await tick(); });
    assert.equal(today.getAttribute('aria-selected'), 'true'); assert.equal(view.container.querySelector('.dtsu-metrics-grid'), null);
    assert.match(view.container.textContent, /Could not refresh usage/);
  } finally { await view.close(); }
});

test('failed refresh of the same range retains numbers with a visible stale-data notice', async () => {
  let fail = false, poll; const realInterval = globalThis.setInterval;
  globalThis.fetch = async (_url, init) => fail ? response(undefined, false) : response(details(JSON.parse(init.body).range, 100));
  globalThis.setInterval = (callback, delay, ...args) => { if (delay === 30_000) poll = callback; return realInterval(callback, delay, ...args); };
  const view = await mounted(TokenUsageSettings); globalThis.setInterval = realInterval;
  try {
    assert.equal(typeof poll, 'function'); fail = true;
    await act(async () => { poll(); await tick(); });
    assert.equal(view.container.querySelector('.dtsu-metric strong').textContent, '100');
    assert.match(view.container.querySelector('[role=status]').textContent, /Could not refresh usage.*Last updated/);
  } finally { globalThis.setInterval = realInterval; await view.close(); }
});

test('sidebar ignores an older response and visibly marks a later failed probe', async () => {
  const resolves = [], signals = [];
  globalThis.fetch = (_url, init) => { signals.push(init.signal); return new Promise((resolve) => resolves.push(resolve)); };
  const view = await mounted(TokenUsageSidebar);
  try {
    await act(async () => { visibilityRefresh(); await tick(); });
    assert.equal(resolves.length, 2); assert.equal(signals[0].aborted, true);
    await act(async () => { resolves[1](response(summary(200))); await tick(); });
    await act(async () => { resolves[0](response(summary(100))); await tick(); });
    assert.equal(view.container.querySelectorAll('.dtsu-v')[2].textContent, '200');
    await act(async () => { visibilityRefresh(); await tick(); resolves[2](response(undefined, false)); await tick(); });
    assert.equal(view.container.querySelectorAll('.dtsu-v')[2].textContent, '200');
    assert.match(view.container.querySelector('[role=status]').textContent, /Could not refresh usage.*Last updated/);
  } finally { for (const resolve of resolves) resolve(response(undefined, false)); await view.close(); }
});

test('partial history and verified signed accounting adjustments are visible', async () => {
  globalThis.fetch = async (_url, init) => response(details(JSON.parse(init.body).range, 100, 0, { status: 'partial', accountingAdjustment: -100 }));
  const view = await mounted(TokenUsageSettings);
  try { assert.match(view.container.textContent, /Some history is unverified/); assert.match(view.container.textContent, /Verified adjustment: -100 tokens/); }
  finally { await view.close(); }
});

test('initial recovery failure renders unavailable state with no fabricated zero totals', async () => {
  globalThis.fetch = async () => response(undefined, false);
  const view = await mounted(TokenUsageSidebar);
  try { assert.deepEqual([...view.container.querySelectorAll('.dtsu-v')].map((item) => item.textContent), ['–', '–', '–']); assert.match(view.container.textContent, /Could not refresh usage/); }
  finally { await view.close(); }
});

test('request deadline cancels a stalled response body and leaves the caller controller usable', async () => {
  const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const caller = new AbortController(); let deadline, cleared = false, requestSignal;
  globalThis.setTimeout = (callback, delay, ...args) => delay === 15_000 ? (deadline = callback, 'probe-deadline') : realTimeout(callback, delay, ...args);
  globalThis.clearTimeout = (id) => { if (id === 'probe-deadline') cleared = true; else realClear(id); };
  globalThis.fetch = async (_url, init) => {
    requestSignal = init.signal;
    return { ok: true, json: () => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('deadline', 'AbortError')), { once: true });
    }) };
  };
  try {
    const pending = usageRequest('/token-usage/api/summary', { method: 'POST' }, caller.signal);
    await tick(); assert.equal(typeof deadline, 'function');
    const rejection = assert.rejects(pending, { name: 'AbortError' }); deadline(); await rejection;
    assert.equal(requestSignal.aborted, true); assert.equal(caller.signal.aborted, false); assert.equal(cleared, true);
  } finally { globalThis.setTimeout = realTimeout; globalThis.clearTimeout = realClear; }
});
