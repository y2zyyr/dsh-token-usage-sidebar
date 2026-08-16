// src/index.ts
// Host half of dsh-token-usage-sidebar (v1.1 — scalable durable ledger).
//
//   Authoritative source : durable session-log events assistant/message.usage
//                          and assistant/chunk{type:'usage'}.usage
//                          (exactly-once, framework-committed, restart-safe).
//   Exactly-once         : a (sessionId, turn, step) invocation is recorded at
//                          its final authoritative total once; replays/retries
//                          are ignored (higher-seq wins on conflict).
//   Persistence          : plugin-owned SQLite ledger (node:sqlite, WAL).
//                          usage_records = source of truth; aggregate_* =
//                          derived rebuildable cache. Writes are O(1)-ish per
//                          invocation regardless of lifetime history size.
//   Migration            : v1.0.1 root-JSON ledger is migrated automatically
//                          and VERIFIED before cutover (see
//                          docs/migrations/v1.0.1-to-v1.1.0.md).
//   Client channel       : POST /token-usage/api/summary (browser-trust fence).
//
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DurableStore,
} from './usage/durable/durableStore.ts';
import {
  DurableAggregator,
} from './usage/durable/durableAggregator.ts';
import {
  migrateV1Ledger,
  readV1Root,
  type MigrationResult,
} from './usage/durable/migration.ts';
import { collectSessionUsage, type SessionEventLike } from './usage/collector.ts';
import { defaultDbPath, ensureDbDir, DB_FILE_NAME } from './usage/durable/wrapper.ts';
import type { InsightRange } from './usage/insights.ts';

export const name = 'dsh-token-usage-sidebar';

/** Services required to mount. */
export const inject = ['webServer', 'sessions', 'webRuntime'];

// ── browser-trust fence (behavior-identical to the v1.0.1 gateway fence) ──
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL('http://' + authority);
  } catch {
    return undefined;
  }
}
function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL('https://' + entry).port;
  return port === '' ? entryUrl.hostname : entryUrl.hostname + ':' + port;
}
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host;
  });
}
function isTrustedApiRequest(request: { headers: Record<string, string | string[] | undefined> }, trustedHosts: readonly string[]): boolean {
  const raw = request.headers['host'];
  const host = typeof raw === 'string' ? raw : undefined;
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers['origin'];
  if (origin === undefined) return true;
  try {
    return new URL(origin as string).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(res: any, status: number, body: unknown): void {
  if (typeof res.statusCode === 'number') res.statusCode = status;
  if (typeof res.setHeader === 'function') res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}
async function readJsonBody(req: any): Promise<unknown> {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}
function insightRangeOf(body: unknown): InsightRange | undefined {
  const range = body && typeof body === 'object' ? (body as { range?: unknown }).range : undefined;
  return range === 'today' || range === 'yesterday' || range === '7d' || range === 'all' ? range : undefined;
}

/** Migration source is the v1 (or no) JSON ledger that shared the storages dir. */
function v1LedgerPath(dbPath: string): string {
  return join(dirname(dbPath), 'dsh_token_usage_sidebar.json');
}

/** Services this plugin injects onto the cordis Context at runtime. */
interface HostCtx {
  sessions: { list(): Array<{ id: string; events?: readonly SessionEventLike[] }> };
  webRuntime: { trustedHosts?: unknown };
  webServer: { register(opts: unknown): unknown };
  on(event: string, listener: (session: unknown, event: SessionEventLike) => void): void;
  logger?: { warn?: (...args: unknown[]) => void };
  effect(fn: () => (() => void) | void, id?: string): unknown;
}

export function apply(ctx: Context): void {
  const hctx = ctx as unknown as HostCtx;
  const dbPath = (() => {
    try {
      return defaultDbPath({ DSH_HOME: process.env.DSH_HOME });
    } catch {
      return defaultDbPath({});
    }
  })();

  const store = new DurableStore({ path: dbPath });
  ensureDbDir(dbPath);
  const agg = new DurableAggregator(store);

  ctx.effect(async () => {
    let migrated = false;
    let migration: MigrationResult | undefined;
    try {
      // 1) Migration: v1.0.1 JSON ledger -> v1.1 SQLite, verified before cutover.
      //    Idempotent: a 'done' meta short-circuits. Fail-closed: no cutover on
      //    any verification mismatch; the v1 source is only ever read/copied.
      const v1Path = v1LedgerPath(dbPath);
      if (existsSync(v1Path)) {
        const v1 = readV1Root(v1Path);
        if (v1) {
          migration = migrateV1Ledger(store, { v1Path, backupDir: dirname(v1Path) });
          migrated = migration.migrated;
          if (migration.status === 'done' && migration.verification.length === 0) {
            console.log('[dsh-token-usage-sidebar] v1.0.1 -> v1.1 migration complete:',
              migration.migratedRecords, 'records, lifetimeTotal', migration.v11LifetimeTotal,
              'in', migration.durationMs, 'ms');
          } else if (migration.status === 'failed') {
            console.error('[dsh-token-usage-sidebar] v1.0.1 -> v1.1 migration FAILED (no cutover):',
              migration.verification);
          } else if (migration.skippedBecauseDone) {
            console.log('[dsh-token-usage-sidebar] v1.1 ledger already migrated; skipping.');
          }
        } else {
          console.log('[dsh-token-usage-sidebar] no readable v1 ledger; starting fresh.');
        }
      } else {
        console.log('[dsh-token-usage-sidebar] no v1 JSON ledger present; fresh v1.1 install.');
      }

      // 2) Live drive: start AFTER migration so no live event races the cutover.
      //    Events recorded before this handler are captured in session logs and
      //    reconciled idempotently below.
      let sessions: Array<{ id: string; events?: readonly SessionEventLike[] }> = [];
      try {
        sessions = hctx.sessions.list ? [...hctx.sessions.list()] : [];
      } catch {
        sessions = [];
      }
      for (const s of sessions) {
        const events = s.events ?? [];
        if (events.length === 0) continue;
        agg.apply(collectSessionUsage({ sessionId: String(s.id), events }));
      }
      hctx.on('session/event', (session: unknown, event: SessionEventLike) => {
        const recs = collectSessionUsage({ sessionId: String((session as { id?: unknown })?.id ?? ''), events: [event] });
        if (recs.length > 0) agg.apply(recs);
      });

      const trustedHosts = () => {
        const rt = hctx.webRuntime?.trustedHosts;
        return Array.isArray(rt) ? rt : [];
      };
      const fence = (req: any): boolean => {
        try {
          return isTrustedApiRequest(req, trustedHosts());
        } catch {
          return false;
        }
      };

      const dispose = hctx.webServer.register({
        kind: 'prefix',
        path: '/token-usage/api',
        handler: async (req: any, res: any) => {
          if (!fence(req)) {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } });
            return;
          }
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } });
            return;
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
          const method = pathname.startsWith('/token-usage/api/') ? pathname.slice('/token-usage/api/'.length) : undefined;
          if (!method || method.includes('/')) {
            writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } });
            return;
          }
          try {
            const body = await readJsonBody(req);
            if (method === 'summary') {
              writeJson(res, 200, { ok: true, value: agg.summary() });
            } else if (method === 'details') {
              const range = insightRangeOf(body);
              if (!range) {
                writeJson(res, 400, { ok: false, error: { code: 'validation-error', message: 'range must be today, yesterday, 7d, or all' } });
                return;
              }
              writeJson(res, 200, { ok: true, value: agg.insights(range) });
            } else if (method === 'debug') {
              writeJson(res, 200, { ok: true, value: agg.diagnostics() });
            } else {
              writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method ' + method } });
            }
          } catch (e) {
            writeJson(res, 500, { ok: false, error: { code: 'internal', message: String((e as Error)?.message ?? e) } });
          }
        },
      });

      const closer = (dispose as (() => void) | null | undefined) ?? undefined;
      return () => {
        try { closer?.(); } catch { /* noop */ }
        void agg.close();
      };
    } catch (e) {
      // Contain failures: the plugin must never take the host down.
      try { hctx.logger?.warn?.('[dsh-token-usage-sidebar] init failed', e); } catch { /* noop */ }
      console.error('[dsh-token-usage-sidebar] init failed', e);
      return () => { void agg.close(); };
    }
  }, 'dsh-token-usage-sidebar: host');
}