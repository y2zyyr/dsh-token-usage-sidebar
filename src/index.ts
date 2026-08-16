// src/index.ts
// Host half of dsh-token-usage-sidebar.
//
//   Authoritative source : durable session-log events assistant/message.usage
//                          and assistant/chunk{type:'usage'}.usage
//                          (exactly-once, framework-committed, restart-safe).
//   Exactly-once         : a (sessionId, turn, step) invocation is recorded at
//                          its final authoritative total once; replays/retries
//                          are ignored by the ledger's byId dedup.
//   Persistence          : domain-KV ledger (ctx.storageDomain), atomic
//                          ~/.dsh/storages/<unit>.json, versioned.
//   Client channel       : POST /token-usage/api/summary (browser-trust fence).
//
import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import {
  UsageAggregator,
} from './usage/aggregator';
import { collectSessionUsage, type SessionEventLike } from './usage/collector';
import { currentLocalDate } from './usage/types';
import { totalForOffset } from './usage/ledger';
import type { InsightRange } from './usage/insights';
import type { UsageStore, LedgerState } from './usage/store';

export const name = 'dsh-token-usage-sidebar';

/** Services required to mount.
 * sessionPersistence lets us enumerate/read ALL persisted session logs the
 * DSH-blessed way (multi-frame zstd, cold/archived included). */
export const inject = ['webServer', 'sessions', 'storageDomain', 'webRuntime', 'sessionPersistence'];

// ── durable ledger domain ──────────────────────────────────────────────────
const LedgerSchema = z.object({
  lifetimeTotal: z.number().int().nonnegative(),
  todayTotal: z.number().int().nonnegative(),
  todayDate: z.string(),
  byId: z.record(z.string(), z.number().int().nonnegative()),
  recordCount: z.number().int().nonnegative(),
  src: z.record(z.string(), z.enum(['live_event','session_log','provider_record','legacy_store','other'])).optional(),
  liveRecordedTotal: z.number().int().nonnegative().optional(),
  historicalRecoveredTotal: z.number().int().nonnegative().optional(),
  historicalRecoveredRecordCount: z.number().int().nonnegative().optional(),
  schemaVersion: z.number().int().nonnegative().optional(),
  // Per-record fields are optional for backwards-compatible v0.1/v0.2 reads.
  // They must be part of the domain schema, though: Zod strips unknown keys
  // before storage and an omitted declaration would lose daily accounting on
  // every restart.
  dayBy: z.record(z.string(), z.string()).optional(),
  seqBy: z.record(z.string(), z.number().int().nonnegative()).optional(),
  detailBy: z.record(z.string(), z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    provider: z.string().optional(),
    model: z.string().optional(),
  })).optional(),
  recovery: z.object({
    trackingStartDate: z.string().optional(),
    earliestRecoveredAt: z.number().optional(),
    latestRecoveredAt: z.number().optional(),
    recoveryVersion: z.number().optional(),
    recoveryCompletedAt: z.number().optional(),
    recoverySources: z.array(z.string()).optional(),
    recoveredRecordCount: z.number().optional(),
    recoveryStatus: z.enum(['complete','partial','unknown']).optional(),
  }).optional(),
});

const ledgerSpec = defineDomain({
  name: 'dsh_token_usage_sidebar',
  version: 1,
  tables: {
    ledger: domainTable<never, z.infer<typeof LedgerSchema>>(LedgerSchema),
  },
});

type LedgerTable = ReturnType<Domain<typeof ledgerSpec>['table']>;

class DomainLedgerStore implements UsageStore {
  private table: LedgerTable | undefined;
  private domain: Domain<typeof ledgerSpec> | undefined;
  private key = 'root';

  async open(facility: { open(s: typeof ledgerSpec): Promise<Domain<typeof ledgerSpec>> }): Promise<void> {
    this.domain = await facility.open(ledgerSpec);
    this.table = this.domain.table('ledger');
  }
  async load(): Promise<LedgerState | undefined> {
    const row = this.table?.get(this.key);
    if (!row) return undefined;
    const parsed = LedgerSchema.safeParse(row);
    if (!parsed.success) return undefined;
    return parsed.data as unknown as LedgerState;
  }
  async save(ledger: LedgerState): Promise<void> {
    if (!this.table) throw new Error('ledger domain not open');
    await this.table.put(this.key, ledger);
  }
  async close(): Promise<void> {
    if (this.domain) await (this.domain as unknown as { close?(): Promise<void> }).close?.();
  }
}

// ── browser-trust fence (behavior-identical to the /api gateway fence) ─────
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

export function apply(ctx: Context): void {
  const store = new DomainLedgerStore();
  // Historical reader backed by DSH session-persistence: list() enumerates every
  // persisted session (cold/archived included); readEvents() decodes the durable
  // log correctly (multi-frame zstd) via readFrom(id, 0).
  const historicalReader = {
    async list(): Promise<Array<{ id: string }>> {
      try {
        const headers = await (ctx.sessionPersistence as any).list();
        return Array.isArray(headers)
          ? headers.map((h: any) => ({ id: String(h?.id ?? '') })).filter((x: any) => x.id)
          : [];
      } catch {
        return [];
      }
    },
    async readEvents(id: string) {
      try {
        const out = await (ctx.sessionPersistence as any).readFrom(id, 0);
        const meta = out?.meta ?? {};
        return { sessionId: String(meta?.id ?? id), events: out?.events ?? [], path: undefined };
      } catch {
        return null;
      }
    },
  };
  const agg = new UsageAggregator({ store, historicalReader: historicalReader as any });

  // Own the route + session drive + durable store on one effect; dispose closes.
  ctx.effect(async () => {
    try {
      await store.open(ctx.storageDomain as any);
      await agg.start();

      // v0.2 historical recovery: enumerate ALL durable session logs on disk and
      // merge every authoritative record once. Idempotent (migrationVersion=2),
      // preserves existing live records, and sets the tracking start date so the
      // recovery window is defined and the plugin never double-adds.
      const mig = await agg.migrateHistorical();
      if (mig.migrated) {
        console.log('[dsh-token-usage-sidebar] v0.2 historical recovery ran:', JSON.stringify(mig.summary));
      } else {
        console.log('[dsh-token-usage-sidebar] historical recovery already complete (schemaVersion=' +
          agg.diagnostics().schemaVersion + '), skipping re-scan');
      }

      // Light reconciliation: fold *live* sessions for any invocation not already
      // in the ledger (e.g. a mid-write/locked log the scan skipped). Idempotent.
      let sessions: Array<{ id: string; events?: readonly SessionEventLike[] }> = [];
      try {
        sessions = (ctx.sessions as any).list ? [...(ctx.sessions as any).list()] : [];
      } catch {
        sessions = [];
      }
      for (const s of sessions) {
        const events = s.events ?? [];
        if (events.length === 0) continue;
        agg.apply(collectSessionUsage({ sessionId: String(s.id), events }));
      }

      // Live drive: commit each session event exactly once (framework).
      ctx.on('session/event', (session: any, event: SessionEventLike) => {
        const recs = collectSessionUsage({ sessionId: String(session?.id ?? ''), events: [event] });
        if (recs.length > 0) agg.apply(recs);
      });

      const trustedHosts = () => {
        const rt = (ctx as any).webRuntime?.trustedHosts;
        return Array.isArray(rt) ? rt : [];
      };
      const fence = (req: any): boolean => {
        try {
          return isTrustedApiRequest(req, trustedHosts());
        } catch {
          return false;
        }
      };

      const dispose = ctx.webServer.register({
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
              const a = agg.aggregate;
              const yesterday = totalForOffset(agg.ledgerSnapshot(), 1);
              writeJson(res, 200, {
                ok: true,
                value: {
                  todayTotal: a.todayTotal,
                  todayDate: a.todayDate,
                  yesterdayTotal: yesterday.total,
                  yesterdayDate: yesterday.date,
                  lifetimeTotal: a.lifetimeTotal,
                  recordCount: a.recordCount,
                  serverNow: currentLocalDate(),
                },
              });
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

      return () => {
        try { dispose?.(); } catch { /* noop */ }
        void agg.close();
      };
    } catch (e) {
      // Contain failures: the plugin must never take the host down.
      try { ctx.logger?.warn?.('[dsh-token-usage-sidebar] init failed', e); } catch { /* noop */ }
      console.error('[dsh-token-usage-sidebar] init failed', e);
      return () => { void agg.close(); };
    }
  }, 'dsh-token-usage-sidebar: host');
}
