// src/index.ts
// Host half of dsh-token-usage-sidebar (v1.1 — scalable durable ledger).
//
//   Authoritative source : provider-reported assistant/message/attempt usage
//                          (including stream fallback) and legacy chunk usage.
//   Exactly-once         : highest-seq usage sample per attempt; explicit retry
//                          boundaries create separate attempts. Forks count only
//                          events owned by the child. Legacy corrections are audited.
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
  readV1RootResult,
  type MigrationResult,
} from './usage/durable/migration.ts';
import {
  discoverTokenSources,
  importTokenSources,
  type SourceDiscoveryResult,
} from './usage/durable/sourceDiscovery.ts';
import { SessionUsageCollector, type SessionEventLike } from './usage/collector.ts';
import { snapshotLiveSession, recoverPersistedSessions, type LiveSessionLike, type PersistenceLike, type SessionRecoveryResult } from './usage/durable/sessionRecovery.ts';
import type { UsageHealth } from './usage/health.ts';
import { defaultDbPath, ensureDbDir } from './usage/durable/wrapper.ts';
import type { InsightRange } from './usage/insights.ts';
import type { ProviderAliasGroupInput } from './usage/durable/durableStore.ts';
import type { UsageFilters } from './usage/providerAliases.ts';

export const name = 'dsh-token-usage-sidebar';

/** Services required to mount. */
export const inject = ['webServer', 'sessions', 'webRuntime', 'sessionPersistence'];

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
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 65_536) throw new Error('request-body-too-large');
    chunks.push(bytes);
  }
  if (size === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('request-body-invalid-json'); }
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
  return message.startsWith('provider-alias-') || message.startsWith('alias ') || message.startsWith('filters.') || message.startsWith('request-body-');
}

/** Migration source is the v1 (or no) JSON ledger that shared the storages dir. */
function v1LedgerPath(dbPath: string): string {
  return join(dirname(dbPath), 'dsh_token_usage_sidebar.json');
}

interface HostCtx {
  sessions: { list(): LiveSessionLike[] };
  sessionPersistence?: PersistenceLike;
  webRuntime: { trustedHosts?: unknown };
  webServer: { register(opts: unknown): unknown };
  on(event: string, listener: (...args: any[]) => void): unknown;
  logger?: { warn?: (...args: unknown[]) => void };
}

export function apply(ctx: Context): void {
  const host = ctx as unknown as HostCtx;
  ctx.effect(() => {
    const abort = new AbortController();
    let disposed = false;
    let store: DurableStore | undefined;
    let aggregator: DurableAggregator | undefined;
    let phase: UsageHealth['status'] = 'loading';
    let failureCode: string | undefined;
    let sourceDiscovery: SourceDiscoveryResult | undefined;
    let sourceDiscoveryApplied = 0;
    let migration: MigrationResult | undefined;
    let recovery: SessionRecoveryResult | undefined;
    let liveDiscovered = 0, liveRead = 0, liveListFailed = false, invalidUsageEvents = 0;
    let accounting = { accountingVersion: 2, legacyRecordCount: 0, accountingAdjustment: 0, accountingChangeCount: 0 };
    let updatedAt = Date.now();
    const collectors = new Map<string, SessionUsageCollector>();
    const incompleteSessions = new Set<string>();
    const liveFailures = new Set<string>();
    const liveFailed = () => liveFailures.size + (liveListFailed ? 1 : 0);
    const disposers: (() => void)[] = [];
    const health = (): UsageHealth => {
      const global = store?.globalAggregate();
      const scan = recovery?.sourceScanStatus ?? (phase === 'loading' ? 'unknown' : liveFailed() > 0 ? liveRead > 0 ? 'partial' : 'failed' : 'unknown');
      const partial = scan !== 'complete' || liveFailed() > 0 || invalidUsageEvents > 0
        || accounting.legacyRecordCount > 0 || sourceDiscovery?.status === 'partial' || sourceDiscovery?.status === 'failed';
      return {
        status: phase === 'ready' && partial ? 'partial' : phase,
        sourceScanStatus: liveFailed() > 0 && scan === 'complete' ? 'partial' : scan,
        historicalCoverage: (global?.calls ?? 0) + (global?.unknown_calls ?? 0) > 0 ? 'partial' : 'unknown',
        sessionsDiscovered: recovery?.sessionsDiscovered ?? liveDiscovered,
        sessionsReadSuccessfully: recovery?.sessionsReadSuccessfully ?? liveRead,
        sessionsReadFailed: (recovery?.sessionsReadFailed ?? 0) + liveFailed(),
        invalidUsageEvents: invalidUsageEvents + (recovery?.invalidUsageEvents ?? 0),
        ...accounting, updatedAt,
      };
    };
    const trustedHosts = () => Array.isArray(host.webRuntime?.trustedHosts) ? host.webRuntime.trustedHosts as string[] : [];
    const routeDisposer = host.webServer.register({
      kind: 'prefix', path: '/token-usage/api',
      handler: async (req: any, res: any) => {
        if (!isTrustedApiRequest(req, trustedHosts())) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } }); return;
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } }); return;
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
        const method = pathname.startsWith('/token-usage/api/') ? pathname.slice('/token-usage/api/'.length) : undefined;
        if (!method || method.includes('/') || !['summary', 'details', 'aliases', 'debug'].includes(method)) {
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } }); return;
        }
        try {
          const body = await readJsonBody(req);
          if (method === 'debug') {
            writeJson(res, 200, { ok: true, value: {
              ...(aggregator ? aggregator.diagnostics() : { storageBackend: 'unavailable' }),
              health: health(), failureCode, migrationStatus: migration?.status ?? store?.readMeta()?.migrationStatus,
              ...health(),
              sourceDiscovery: sourceDiscovery ? {
                status: sourceDiscovery.status, sourceCount: sourceDiscovery.sources.length,
                importedRecordCount: sourceDiscovery.aggregateChecks.discoveredRecordCount, appliedRecordCount: sourceDiscoveryApplied,
                cached: sourceDiscovery.cached ?? false,
                errors: sourceDiscovery.errors, aggregateChecks: sourceDiscovery.aggregateChecks,
                sources: sourceDiscovery.sources.map((item) => ({ format: item.format, sha256: item.sha256,
                  recordCount: item.recordCount, totalTokens: item.totalTokens, imported: item.imported })),
              } : undefined,
              sessionRecovery: recovery,
            } }); return;
          }
          const currentStore = store, currentAggregator = aggregator;
          if (!currentStore || !currentAggregator || phase === 'loading' || phase === 'failed') {
            writeJson(res, 503, { ok: false, health: health(), error: {
              code: phase === 'loading' ? 'initializing' : 'recovery-failed',
              message: phase === 'loading' ? 'Usage recovery is in progress.' : 'Usage recovery failed. Existing ledger files are preserved.',
            } }); return;
          }
          if (method === 'summary') {
            writeJson(res, 200, { ok: true, value: { ...currentAggregator.summary(), health: health() } });
          } else if (method === 'details') {
            const range = insightRangeOf(body);
            const filters = usageFiltersOf(body);
            if (!range || !filters.ok) {
              writeJson(res, 400, { ok: false, error: { code: 'validation-error', message: !range ? 'invalid range' : !filters.ok ? filters.message : '' } }); return;
            }
            writeJson(res, 200, { ok: true, value: { ...currentAggregator.insights(range, filters.value), health: health() } });
          } else if (method === 'aliases') {
            const request = aliasRequestOf(body);
            if (!request.ok) {
              writeJson(res, 400, { ok: false, error: { code: 'validation-error', message: request.message } }); return;
            }
            if (request.action === 'upsert') currentStore.upsertProviderAliasGroup(request.group);
            if (request.action === 'delete') currentStore.deleteProviderAliasGroup(request.id);
            writeJson(res, 200, { ok: true, value: { groups: currentStore.listProviderAliasGroups() } });
          }
        } catch (error) {
          const message = String((error as Error).message ?? error);
          writeJson(res, message === 'request-body-too-large' ? 413 : isClientValidationError(error) ? 400 : 500,
            { ok: false, error: { code: isClientValidationError(error) ? 'validation-error' : 'internal',
              message: isClientValidationError(error) ? message : 'Usage request failed.' } });
        }
      },
    });
    if (typeof routeDisposer === 'function') disposers.push(routeDisposer as () => void);

    const invalid = () => { invalidUsageEvents += 1; };
    const allowKnownUsage = () => {
      if (failureCode !== 'history-unavailable') return;
      const global = store?.globalAggregate();
      if ((global?.calls ?? 0) + (global?.unknown_calls ?? 0) > 0) {
        failureCode = undefined; phase = 'ready';
      }
    };
    const capture = (session: LiveSessionLike, liveSeq?: number): SessionUsageCollector => {
      const replay = snapshotLiveSession(session, invalid);
      const records = liveSeq === undefined ? replay.records : replay.records.map((record) =>
        record.seq === liveSeq ? { ...record, sourceType: 'live_event' as const } : record);
      store!.reconcileSession(session.id, records, replay.inheritedIds, replay.lastSeq);
      collectors.set(session.id, replay.collector);
      incompleteSessions.delete(session.id); liveFailures.delete(session.id);
      accounting = store!.accountingDiagnostics();
      return replay.collector;
    };
    const listen = (event: string, handler: (...args: any[]) => void) => {
      const disposer = host.on(event, handler);
      if (typeof disposer === 'function') disposers.push(disposer as () => void);
    };
    async function initialize(): Promise<void> {
      try {
        const dbPath = defaultDbPath({ DSH_HOME: process.env.DSH_HOME });
        ensureDbDir(dbPath);
        store = new DurableStore({ path: dbPath });
        aggregator = new DurableAggregator(store);
        const v1Path = v1LedgerPath(dbPath);
        // A verified SQLite cutover no longer depends on rereading old JSON.
        if (store.readMeta()?.migrationStatus !== 'done') {
          const read = readV1RootResult(v1Path);
          if (read.status !== 'absent') {
            migration = migrateV1Ledger(store, { v1Path, v1Root: read.status === 'ok' ? read.root : undefined, backupDir: dirname(v1Path) });
            if (migration.status === 'failed') failureCode = 'v1-migration-failed';
          }
        }
        if (failureCode) sourceDiscovery = discoverTokenSources(dirname(dbPath));
        else {
          const imported = importTokenSources(store, dirname(dbPath), { includeLegacyRoot: store.readMeta()?.migrationStatus === 'done' });
          sourceDiscovery = imported.discovery; sourceDiscoveryApplied = imported.applied;
        }
        let sessions: LiveSessionLike[] = [];
        try { sessions = [...host.sessions.list()]; liveDiscovered = sessions.length; }
        catch { liveListFailed = true; }
        for (const session of sessions) {
          try { capture(session); liveRead += 1; } catch { liveFailures.add(session.id); incompleteSessions.add(session.id); }
        }
        // Register before the first await: persisted scans cannot miss new events.
        listen('session/created', (session: LiveSessionLike) => {
          if (disposed) return;
          try { capture(session); allowKnownUsage(); updatedAt = Date.now(); }
          catch { liveFailures.add(session.id); incompleteSessions.add(session.id); }
        });
        listen('session/event', (session: LiveSessionLike, event: SessionEventLike) => {
          if (disposed) return;
          try {
            let collector = collectors.get(session.id);
            if (!collector || incompleteSessions.has(session.id)) {
              try { collector = capture(session, event.seq); }
              catch {
                liveFailures.add(session.id); incompleteSessions.add(session.id);
                // Unknown fork ownership cannot safely identify child usage.
                if (session.inheritedEventCount === undefined && (session.header?.isSeeded || session.header?.parentSession)) return;
                collector ??= new SessionUsageCollector({ sessionId: session.id, inheritedEventCount: session.inheritedEventCount, onInvalidUsage: invalid });
                collectors.set(session.id, collector);
              }
            }
            const records = collector.collect([event], 'live_event');
            // Without a complete snapshot, earlier retry boundaries may be
            // missing. Keep these samples eligible for audited reconciliation.
            aggregator!.apply(incompleteSessions.has(session.id) ? records.map((record) => ({ ...record, accountingVersion: 1 })) : records);
            if (incompleteSessions.has(session.id)) accounting = store!.accountingDiagnostics();
            allowKnownUsage();
            updatedAt = Date.now();
          } catch { phase = 'failed'; failureCode = 'live-write-failed'; }
        });
        listen('session/disposed', (session: LiveSessionLike) => { collectors.delete(session.id); });
        recovery = await recoverPersistedSessions(store, host.sessionPersistence, abort.signal);
        if (disposed) return;
        accounting = store.accountingDiagnostics();
        const verification = store.verifyAggregates();
        if (!verification.ok) { phase = 'failed'; failureCode = 'aggregate-verification-failed'; return; }
        const count = (store.globalAggregate()?.calls ?? 0) + (store.globalAggregate()?.unknown_calls ?? 0);
        if (!failureCode && count === 0 && (recovery.sourceScanStatus === 'failed' || liveFailed() > 0 || sourceDiscovery.status === 'failed')) failureCode = 'history-unavailable';
        phase = failureCode ? 'failed' : 'ready';
        updatedAt = Date.now();
      } catch {
        if (disposed) return;
        phase = 'failed'; failureCode = 'initialization-failed';
        host.logger?.warn?.('[dsh-token-usage-sidebar] initialization failed; ledger files preserved');
      }
    }
    void initialize();
    return () => {
      disposed = true; abort.abort();
      for (const dispose of disposers.reverse()) { try { dispose(); } catch {} }
      collectors.clear();
      incompleteSessions.clear(); liveFailures.clear();
      if (aggregator) aggregator.close(); else store?.close();
    };
  }, 'dsh-token-usage-sidebar: host');
}
