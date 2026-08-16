// src/usage/historical.ts
// v0.2 historical recovery: enumerate every persisted DSH session's durable
// events (cold/archived included) and fold each authoritative
// assistant/message.usage record into the ledger exactly once, without
// disturbing the live (post-install) records already present.
//
// Canonical identity  : (sessionId, turn, step) — identical to the live drive,
//                       so the two sources share one dedup namespace.
// Provenance          : records newly added here are attributed `session_log`;
//                       records already present keep their first-seen source so
//                       the historical/live split is additive and exactly-once.
// Idempotency         : guarded on schemaVersion/recoveryVersion; a completed
//                       migration never re-folds history on a later restart.
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'; // kept for test-only helpers
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { collectSessionUsage } from './collector.ts';
import { foldRecords, hasRecord, recomputeSourceSplit, type LedgerState } from './ledger.ts';
import type { RecoveryMetadata, UsageSourceType } from './types.ts';

// v4 replays the durable union once to fill v1.0 bucket and model metadata.
// Existing ids are enriched/replaced by higher-seq final messages, never added.
export const HISTORICAL_MIGRATION_VERSION = 4;

/** One persisted session the recovery scans. */
export interface HistoricalSession {
  /** DSH session id (session-... / bare uuid). */
  readonly id: string;
  /** Optional on-disk path (for provenance). */
  readonly path?: string;
}

/**
 * Injectable reader so the host plugin can reuse DSH's own persistence
 * (`ctx.sessionPersistence.list()` + `readFrom(id,0)` — correct multi-frame
 * zstd, archived/cold included), while tests use a file-backed reader over
 * single-frame fixtures.
 */
export interface HistoricalReader {
  list(): Promise<HistoricalSession[]>;
  readEvents(id: string): Promise<{ sessionId: string; events: { type: string; seq: number; time?: number; data?: Record<string, unknown> }[]; path?: string } | null>;
}

/** Resolve the DSH sessions root (used by the file-backed fallback reader). */
export function sessionsRoot(overrideDshHome?: string): string {
  const home = overrideDshHome ?? process.env.DSH_HOME;
  const base = home && home.length > 0 ? home : join(homedir(), '.dsh');
  return join(base, 'sessions');
}

/** Walk every `session.jsonl.zstd` on disk (skips *.corrupt-original / *.bak). */
export function enumerateSessionLogs(sessionsDir: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) visit(p);
      else if (ent.isFile() && ent.name === 'session.jsonl.zstd') out.push(p);
    }
  };
  visit(sessionsDir);
  return out.sort();
}

/** Generic file-backed reader (single-frame zstd fixtures; used by tests). */
export function fileBackedReader(sessionsDir: string): HistoricalReader {
  return {
    async list(): Promise<HistoricalSession[]> {
      return enumerateSessionLogs(sessionsDir).map((p) => ({ id: basenameOf(p), path: p }));
    },
    async readEvents(id: string) {
      const found = enumerateSessionLogs(sessionsDir).find((p) =>
        p.endsWith('/' + id + '/session.jsonl.zstd') || p.includes('/' + id + '/'));
      if (!found) return null;
      try {
        const buf = (await import('node:fs')).readFileSync(found);
        const json = zstdDecompressSync(buf).toString('utf8');
        return { ...parseSessionLog(json), path: found };
      } catch {
        return null;
      }
    },
  };
}

function basenameOf(p: string): string {
  return dirname(p).split('/').pop() ?? p;
}

/** Parse JSONL lines into a session id + events. */
export function parseSessionLog(lines: string): { sessionId: string; events: { type: string; seq: number; time?: number; data?: Record<string, unknown> }[] } {
  let sessionId = '';
  const events: { type: string; seq: number; time?: number; data?: Record<string, unknown> }[] = [];
  for (const raw of lines.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'session') sessionId = String(e.id ?? '');
    const time = Number(e.time);
    events.push({ type: String(e.type ?? ''), seq: Number(e.seq ?? 0), ...(Number.isFinite(time) && time > 0 ? { time } : {}), data: (e.data as Record<string, unknown>) ?? {} });
  }
  return { sessionId, events };
}

/**
 * v1.0.1: source-scan mechanics for the file-backed path.
 * A readable sessions root does NOT prove full lifetime coverage — it only says
 * the plugin could attempt an enumeration. Scan mechanics are reported
 * separately from coverage (recoveryStatus) so the plugin never overclaims.
 */
export function deriveRecoveryStatus(sessionsDir: string): RecoveryMetadata['sourceScanStatus'] {
  try {
    readdirSync(sessionsDir);
    return 'complete'; // the root is enumerable; read results still tracked per-session
  } catch {
    return 'unknown'; // cannot even enumerate the root
  }
}

export interface HistoricalMigrationOptions {
  reader?: HistoricalReader;
  sessionsDir?: string;
  now?: number;
  force?: boolean;
}

export interface HistoricalMigrationResult {
  migrated: boolean;
  ledger: LedgerState;
  summary: {
    migrated: boolean;
    sessionsScanned: number;
    recordsFound: number;
    recoveredTokens: number;
    liveTokens: number;
    lifetimeTotal: number;
    earliestRecoveredAt?: number;
    latestRecoveredAt?: number;
    /** v1.0.1: scan mechanics — how many sessions were enumerated/read/failed. */
    sessionsDiscovered?: number;
    sessionsReadSuccessfully?: number;
    sessionsReadFailed?: number;
    /** v1.0.1: source scan mechanics, never conflated with coverage. */
    sourceScanStatus?: RecoveryMetadata['sourceScanStatus'];
    /** v1.0.1: lifetime coverage (partial unless scan complete AND no pre-tracking gap). */
    recoveryStatus?: RecoveryMetadata['recoveryStatus'];
  };
}

/**
 * Run the v0.2 historical recovery migration (idempotent).
 * If already verified under v1.0.1 semantics (schemaVersion >= 2 with both
 * recoveryStatus AND sourceScanStatus metadata) it is a no-op unless `force`
 * is set; a legacy 'complete' recoveryStatus alone is NOT enough to skip the
 * scan (§19). Meres every authoritative record into the ledger without
 * resetting or dropping existing live records.
 */
export async function runHistoricalMigration(ledger: LedgerState, opts?: HistoricalMigrationOptions): Promise<HistoricalMigrationResult> {
  const now = opts?.now ?? Date.now();
  // v1.0.1 §19: a ledger is only "already scanned" when it carries v1.0.1 scan
  // evidence. A legacy ledger that predates sourceScanStatus may have
  // recovery.recoveryStatus = 'complete' written under the OLD coarse semantics
  // ("sessions root enumerable"), which must not be presented as proof of full
  // lifetime coverage. Requiring sourceScanStatus !== undefined forces the
  // idempotent scan to build honest v1.0.1 evidence (and heal any stale
  // live/historical split) before re-exposing 'complete'.
  const already = (ledger.schemaVersion ?? 0) >= HISTORICAL_MIGRATION_VERSION
    && ledger.recovery?.recoveryStatus !== undefined
    && ledger.recovery?.sourceScanStatus !== undefined
    && !opts?.force;
  if (already) {
    return { migrated: false, ledger, summary: summarize(ledger) };
  }

  let reader: HistoricalReader;
  if (opts?.reader) {
    reader = opts.reader;
  } else {
    const dir = opts?.sessionsDir ?? sessionsRoot();
    reader = fileBackedReader(dir);
  }

  let next = ledger;

  // v1.0.1: track scan mechanics honestly. Derived statuses never conflate
  // "all discoverable sessions read" with "full lifetime coverage".
  let sessions: HistoricalSession[];
  let listError = false;
  try {
    sessions = await reader.list();
  } catch {
    sessions = [];
    listError = true;
  }
  if (!Array.isArray(sessions)) sessions = [];

  let earliest: number | undefined;
  let latest: number | undefined;
  let sessionsScanned = 0;
  let sessionsDiscovered = sessions.length;
  let sessionsReadSuccessfully = 0;
  let sessionsReadFailed = 0;
  const diskSeen = new Set<string>();
  const newRecords: { id: string; token: number }[] = [];

  for (const s of sessions) {
    let parsed;
    try {
      parsed = await reader.readEvents(s.id);
    } catch {
      sessionsReadFailed += 1; // a discovered session that cannot be read
      continue;
    }
    if (!parsed || !parsed.sessionId || parsed.events.length === 0) {
      // Discovered but unreadable/empty — do not count as a successful scan.
      sessionsReadFailed += 1;
      continue;
    }
    sessionsScanned += 1;
    sessionsReadSuccessfully += 1;
    const recs = collectSessionUsage({
      sessionId: parsed.sessionId,
      events: parsed.events,
      now,
      sourceType: 'session_log',
      sourcePath: parsed.path ?? s.path,
      migrationVersion: HISTORICAL_MIGRATION_VERSION,
    });
    for (const r of recs) {
      if (!hasRecord(next, r.id)) newRecords.push({ id: r.id, token: r.totalTokens });
      if (!diskSeen.has(r.id)) diskSeen.add(r.id);
      if (r.timestamp) {
        if (earliest === undefined || r.timestamp < earliest) earliest = r.timestamp;
        if (latest === undefined || r.timestamp > latest) latest = r.timestamp;
      }
    }
    next = foldRecords(next, recs);
  }

  // Adopt legacy v0.1 rows: any id in byId with no provenance tag was recorded
  // live before v0.2; attribute it as `live` so the split is complete and
  // lifetimeTotal = liveRecordedTotal + historicalRecoveredTotal. Ids first
  // seen in the durable scan above were already attributed `session_log` by
  // recordUsage (new records), so they stay historical.
  {
    const src = { ...(next.src ?? {}) };
    let live = next.liveRecordedTotal ?? 0;
    let changed = false;
    for (const id of Object.keys(next.byId)) {
      if (src[id] === undefined) {
        src[id] = 'live_event';
        live += next.byId[id];
        changed = true;
      }
    }
    if (changed) next = { ...next, src, liveRecordedTotal: live };
  }

  // v1.0.1 invariant (§17): recompute the live/historical split from byId + src
  // so the cached split fields always satisfy
  // lifetimeTotal === liveRecordedTotal + historicalRecoveredTotal, healing any
  // drift a prior migration left behind.
  next = recomputeSourceSplit(next);

  // v1.0.1 status derivation (never overclaims):
  //   sourceScanStatus = whether every DISCOVERABLE source was read successfully.
  //   recoveryStatus    = whether we can ASSERT full lifetime coverage.
  let sourceScanStatus: RecoveryMetadata['sourceScanStatus'] = 'unknown';
  if (listError) {
    sourceScanStatus = 'failed';       // enumeration itself threw
  } else if (sessionsReadFailed > 0) {
    sourceScanStatus = 'partial';      // some discoverable sessions could not be read
  } else {
    sourceScanStatus = 'complete';     // enumerated set fully read (incl. empty set)
  }

  // Lifetime coverage can only be 'complete' if (a) we actually scanned every
  // discoverable source AND (b) provenance shows coverage from tracking start
  // (earliest recovered >= tracking start => no pre-tracking gap). Otherwise it
  // stays 'partial' (recovered some, cannot prove all) or 'unknown' (nothing).
  let recoveryStatus: RecoveryMetadata['recoveryStatus'] = 'unknown';
  const trackingStart = ledger.recovery?.trackingStartDate;
  if (listError && sessionsReadSuccessfully === 0 && newRecords.length === 0) {
    recoveryStatus = 'unknown';
  } else if (sourceScanStatus === 'complete' && trackingStart && earliest !== undefined) {
    const startMs = Date.parse(trackingStart + 'T00:00:00');
    recoveryStatus = !Number.isNaN(startMs) && earliest >= startMs ? 'complete' : 'partial';
  } else {
    recoveryStatus = (sessionsReadSuccessfully > 0 || newRecords.length > 0)
      ? 'partial'
      : 'unknown';
  }

  const recovery: RecoveryMetadata = {
    trackingStartDate: ledger.recovery?.trackingStartDate,
    earliestRecoveredAt: earliest,
    latestRecoveredAt: latest,
    recoveryVersion: HISTORICAL_MIGRATION_VERSION,
    recoveryCompletedAt: now,
    recoverySources: ['durable_session_logs', 'session_persistence'],
    recoveredRecordCount: next.historicalRecoveredRecordCount ?? newRecords.length,
    sourceScanStatus,
    recoveryStatus,
    sessionsDiscovered,
    sessionsReadSuccessfully,
    sessionsReadFailed,
  };
  next = { ...next, schemaVersion: HISTORICAL_MIGRATION_VERSION, recovery };

  return {
    migrated: true,
    ledger: next,
    summary: {
      migrated: true,
      sessionsScanned,
      recordsFound: newRecords.length,
      recoveredTokens: next.historicalRecoveredTotal ?? 0,
      liveTokens: next.liveRecordedTotal ?? 0,
      lifetimeTotal: next.lifetimeTotal,
      earliestRecoveredAt: earliest,
      latestRecoveredAt: latest,
      sessionsDiscovered,
      sessionsReadSuccessfully,
      sessionsReadFailed,
      sourceScanStatus,
      recoveryStatus,
    },
  };
}

function summarize(ledger: LedgerState): HistoricalMigrationResult['summary'] {
  const rec = ledger.recovery;
  return {
    migrated: false,
    sessionsScanned: rec?.sessionsReadSuccessfully ?? 0,
    recordsFound: 0,
    recoveredTokens: ledger.historicalRecoveredTotal ?? 0,
    liveTokens: ledger.liveRecordedTotal ?? 0,
    lifetimeTotal: ledger.lifetimeTotal,
    sessionsDiscovered: rec?.sessionsDiscovered ?? 0,
    sessionsReadSuccessfully: rec?.sessionsReadSuccessfully ?? 0,
    sessionsReadFailed: rec?.sessionsReadFailed ?? 0,
    sourceScanStatus: rec?.sourceScanStatus,
    recoveryStatus: rec?.recoveryStatus,
  };
}
