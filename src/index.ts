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
import {
  discoverTokenSources,
  type SourceDiscoveryResult,
} from './usage/durable/sourceDiscovery.ts';
import { collectSessionUsage, type SessionEventLike } from './usage/collector.ts';
import { defaultDbPath, ensureDbDir, DB_FILE_NAME } from './usage/durable/wrapper.ts';
import type { InsightRange } from './usage/insights.ts';
import type { ProviderAliasGroupInput } from './usage/durable/durableStore.ts';
import type { UsageFilters } from './usage/providerAliases.ts';

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

type ParsedFilters = { ok: true; value: UsageFilters } | { ok: false; message: string };

function usageFiltersOf(body: unknown): ParsedFilters {
  if (body === null || typeof body !== 'object') return { ok: true, value: {} };
  const raw = (body as { filters?: unknown }).filters;
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== 'object') return { ok: false, message: 'filters must be an object' };
  const record = raw as Record<string, unknown>;
  let provider: UsageFilters['provider'] = null;
  if (record.provider !== undefined && record.provider !== null) {
    if (typeof record.provider !== 'object') return { ok: false, message: 'filters.provider must be an object or null' };
    const scope = record.provider as Record<string, unknown>;
    if (scope.type === 'raw' && typeof scope.value === 'string' && scope.value.length > 0) {
      provider = { type: 'raw', value: scope.value };
    } else if (scope.type === 'group' && typeof scope.id === 'string' && scope.id.length > 0) {
      provider = { type: 'group', id: scope.id };
    } else {
      return { ok: false, message: 'filters.provider must be a raw or group scope' };
    }
  }
  let model: string | null = null;
  if (record.model !== undefined && record.model !== null) {
    if (typeof record.model !== 'string') return { ok: false, message: 'filters.model must be a string or null' };
    model = record.model.length > 0 ? record.model : null;
  }
  return { ok: true, value: { provider, model } };
}

type AliasRequest =
  | { ok: true; action: 'list' }
  | { ok: true; action: 'upsert'; group: ProviderAliasGroupInput }
  | { ok: true; action: 'delete'; id: string }
  | { ok: false; message: string };

function aliasRequestOf(body: unknown): AliasRequest {
  if (body === null || typeof body !== 'object') return { ok: true, action: 'list' };
  const record = body as Record<string, unknown>;
  const action = record.action;
  if (action === undefined || action === 'list') return { ok: true, action: 'list' };
  if (action === 'delete') {
    return typeof record.id === 'string' && record.id.length > 0
      ? { ok: true, action: 'delete', id: record.id }
      : { ok: false, message: 'alias id is required' };
  }
  if (action !== 'upsert') return { ok: false, message: 'alias action must be list, upsert, or delete' };
  if (record.group === null || typeof record.group !== 'object') return { ok: false, message: 'alias group is required' };
  const group = record.group as Record<string, unknown>;
  const id = group.id === undefined ? undefined : group.id;
  if (id !== undefined && typeof id !== 'string') return { ok: false, message: 'alias group id must be a string' };
  if (typeof group.label !== 'string') return { ok: false, message: 'alias group label is required' };
  if (!Array.isArray(group.rawValues) || !group.rawValues.every((value) => typeof value === 'string')) {
    return { ok: false, message: 'alias group rawValues must be an array of strings' };
  }
  return { ok: true, action: 'upsert', group: { id, label: group.label, rawValues: group.rawValues as string[] } };
}

function isClientValidationError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  return message.startsWith('provider-alias-') || message.startsWith('alias ') || message.startsWith('filters.');
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

  ensureDbDir(dbPath);
  const store = new DurableStore({ path: dbPath });
  const agg = new DurableAggregator(store);
  let sourceDiscovery: SourceDiscoveryResult | undefined;
  let sourceDiscoveryApplied = 0;

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

      // 2) Auto-discover additional plugin-owned token ledgers. The verified
      // root migration above remains the cut-over for the old single JSON
      // ledger; this pass finds record-table units (including day-partitioned
      // ledgers) that older releases wrote beside it. Aggregate-only units are
      // used for consistency checks, never converted into duplicate calls.
      sourceDiscovery = discoverTokenSources(dirname(dbPath), {
        // A failed root migration stays fail-closed. Once the root migration is
        // verified/done, re-reading it is safe and idempotent, and also catches
        // any records appended by an older release between restarts.
        includeLegacyRoot: migration?.status === 'done',
      });
      if (sourceDiscovery.records.length > 0) {
        sourceDiscoveryApplied = agg.apply(sourceDiscovery.records);
      }
      const discoveryMessage = {
        status: sourceDiscovery.status,
        sources: sourceDiscovery.sources.length,
        records: sourceDiscovery.records.length,
        applied: sourceDiscoveryApplied,
        total: sourceDiscovery.aggregateChecks.discoveredTotal,
      };
      if (sourceDiscovery.status === 'partial' || sourceDiscovery.status === 'failed') {
        console.warn('[dsh-token-usage-sidebar] token-source discovery partial/failed:', discoveryMessage);
        if (sourceDiscovery.errors.length > 0) console.warn('[dsh-token-usage-sidebar] discovery issues:', sourceDiscovery.errors);
      } else {
        console.log('[dsh-token-usage-sidebar] token-source discovery:', discoveryMessage);
      }

      // 3) Live drive: start AFTER migration and discovery so no live event
      //    races either recovery path.
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
              const filters = usageFiltersOf(body);
              if (!filters.ok) {
                writeJson(res, 400, { ok: false, error: { code: 'validation-error', message: filters.message } });
                return;
              }
              writeJson(res, 200, { ok: true, value: agg.insights(range, filters.value) });
            } else if (method === 'aliases') {
              const request = aliasRequestOf(body);
              if (!request.ok) {
                writeJson(res, 400, { ok: false, error: { code: 'validation-error', message: request.message } });
                return;
              }
              if (request.action === 'upsert') store.upsertProviderAliasGroup(request.group);
              if (request.action === 'delete') store.deleteProviderAliasGroup(request.id);
              writeJson(res, 200, { ok: true, value: { groups: store.listProviderAliasGroups() } });
            } else if (method === 'debug') {
              writeJson(res, 200, { ok: true, value: {
                ...agg.diagnostics(),
                sourceDiscovery: sourceDiscovery ? {
                  status: sourceDiscovery.status,
                  sourceCount: sourceDiscovery.sources.length,
                  importedRecordCount: sourceDiscovery.records.length,
                  appliedRecordCount: sourceDiscoveryApplied,
                  errors: sourceDiscovery.errors,
                  aggregateChecks: sourceDiscovery.aggregateChecks,
                  sources: sourceDiscovery.sources.map((source) => ({
                    format: source.format,
                    sha256: source.sha256,
                    recordCount: source.recordCount,
                    totalTokens: source.totalTokens,
                    imported: source.imported,
                  })),
                } : undefined,
              } });
            } else {
              writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method ' + method } });
            }
          } catch (e) {
            writeJson(res, isClientValidationError(e) ? 400 : 500, { ok: false, error: { code: isClientValidationError(e) ? 'validation-error' : 'internal', message: String((e as Error)?.message ?? e) } });
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
