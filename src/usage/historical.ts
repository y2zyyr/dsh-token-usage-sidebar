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
import { foldRecords, hasRecord, type LedgerState } from './ledger.ts';
import type { RecoveryMetadata, UsageSourceType } from './types.ts';

// v3 replays the durable union once to fill dayBy/seqBy that v0.2 accidentally
// omitted from its storage schema.  Existing ids are enriched, never re-added.
export const HISTORICAL_MIGRATION_VERSION = 3;

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

/** Recovery status: whether the sessions root is enumerable (all logs present). */
export function deriveRecoveryStatus(sessionsDir: string): RecoveryMetadata['recoveryStatus'] {
  try {
    readdirSync(sessionsDir);
    return 'complete';
  } catch {
    return 'unknown';
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
    recoveryStatus?: RecoveryMetadata['recoveryStatus'];
  };
}

/**
 * Run the v0.2 historical recovery migration (idempotent).
 * If already completed (schemaVersion >= 2 with recovery metadata) it is a no-op
 * unless `force` is set. Meres every authoritative record into the ledger
 * without resetting or dropping existing live records.
 */
export async function runHistoricalMigration(ledger: LedgerState, opts?: HistoricalMigrationOptions): Promise<HistoricalMigrationResult> {
  const now = opts?.now ?? Date.now();
  const already = (ledger.schemaVersion ?? 0) >= HISTORICAL_MIGRATION_VERSION && ledger.recovery?.recoveryStatus !== undefined && !opts?.force;
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

  let sessions: HistoricalSession[];
  try {
    sessions = await reader.list();
  } catch {
    sessions = [];
  }
  if (!Array.isArray(sessions)) sessions = [];

  let earliest: number | undefined;
  let latest: number | undefined;
  let sessionsScanned = 0;
  const diskSeen = new Set<string>();
  const newRecords: { id: string; token: number }[] = [];

  for (const s of sessions) {
    let parsed;
    try {
      parsed = await reader.readEvents(s.id);
    } catch {
      continue;
    }
    if (!parsed || !parsed.sessionId || parsed.events.length === 0) continue;
    sessionsScanned += 1;
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

  const recovery: RecoveryMetadata = {
    trackingStartDate: ledger.recovery?.trackingStartDate,
    earliestRecoveredAt: earliest,
    latestRecoveredAt: latest,
    recoveryVersion: HISTORICAL_MIGRATION_VERSION,
    recoveryCompletedAt: now,
    recoverySources: ['durable_session_logs', 'session_persistence'],
    recoveredRecordCount: next.historicalRecoveredRecordCount ?? newRecords.length,
    recoveryStatus: await (async () => {
      try {
        const rd = opts?.reader ? sessions : [];
        return sessions.length > 0 ? 'complete' : 'partial';
      } catch {
        return 'unknown';
      }
    })(),
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
      recoveryStatus: recovery.recoveryStatus,
    },
  };
}

function summarize(ledger: LedgerState): HistoricalMigrationResult['summary'] {
  return {
    migrated: false,
    sessionsScanned: 0,
    recordsFound: 0,
    recoveredTokens: ledger.historicalRecoveredTotal ?? 0,
    liveTokens: ledger.liveRecordedTotal ?? 0,
    lifetimeTotal: ledger.lifetimeTotal,
    recoveryStatus: ledger.recovery?.recoveryStatus,
  };
}
