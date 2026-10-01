// src/usage/durable/migration.ts — v1.0.1 (root JSON ledger) -> v1.1 (SQLite) migration
// Idempotent, crash-safe, verifiable, rollback-safe, no token loss, no double count.
// v1 JSON is READ-ONLY; SQLite written transactionally; cut over only after verify.

import { copyFileSync, existsSync, mkdirSync, readFileSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inTransaction } from './wrapper.ts';
import { assertUsageRecord, isTokenCount } from '../validation.ts';
import type { UsageRecord, UsageSourceType } from '../types.ts';
import { DurableStore } from './durableStore.ts';

export const V1_MIGRATION_VERSION = 1;
export interface V1Detail { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; provider?: string; model?: string; }
export interface V1LedgerState {
  lifetimeTotal?: number; todayTotal?: number; todayDate?: string; byId?: Record<string, number>; recordCount?: number;
  src?: Record<string, UsageSourceType | undefined>; liveRecordedTotal?: number; historicalRecoveredTotal?: number;
  historicalRecoveredRecordCount?: number; dayBy?: Record<string, string>; seqBy?: Record<string, number>;
  detailBy?: Record<string, V1Detail>; schemaVersion?: number; recovery?: unknown;
}
export interface MigrationResult { migrated: boolean; status: 'done' | 'failed' | 'not_started'; sourceFound: boolean; migratedRecords: number; v1LifetimeTotal: number; v11LifetimeTotal: number; durationMs: number; verification: string[]; backupPath?: string; skippedBecauseDone?: boolean; }
export interface MigrationOptions { v1Root?: V1LedgerState; v1Path?: string; backupDir?: string; now?: () => number; noBackup?: boolean; }

export type V1ReadResult = { status: 'absent' } | { status: 'invalid'; message: string } | { status: 'ok'; root: V1LedgerState };

export function readV1RootResult(v1Path: string): V1ReadResult {
  if (!existsSync(v1Path)) return { status: 'absent' };
  try {
    const document = JSON.parse(readFileSync(v1Path, 'utf8')) as { tables?: { ledger?: { root?: unknown } } };
    const root = document?.tables?.ledger?.root;
    if (!root || typeof root !== 'object' || Array.isArray(root)) return { status: 'invalid', message: 'invalid v1 ledger root' };
    validateV1(root as V1LedgerState);
    return { status: 'ok', root: root as V1LedgerState };
  } catch { return { status: 'invalid', message: 'unreadable or invalid v1 ledger' }; }
}

/** Compatibility reader. Host code uses the discriminated result above. */
export function readV1Root(v1Path: string): V1LedgerState | undefined {
  const result = readV1RootResult(v1Path);
  return result.status === 'ok' ? result.root : undefined;
}

function validateV1(v1: V1LedgerState): UsageRecord[] {
  if (!v1 || typeof v1 !== 'object' || Array.isArray(v1)) throw new Error('invalid v1 ledger root');
  if (v1.byId !== undefined && (!v1.byId || typeof v1.byId !== 'object' || Array.isArray(v1.byId))) throw new Error('invalid v1 byId');
  const records = buildRecordsFromV1(v1);
  for (const record of records) assertUsageRecord(record);
  const total = records.reduce((sum, record) => sum + record.totalTokens, 0);
  if (!isTokenCount(total) || !isTokenCount(v1.lifetimeTotal ?? 0) || total !== (v1.lifetimeTotal ?? 0)) throw new Error('v1 lifetimeTotal mismatch');
  if (!isTokenCount(v1.recordCount ?? records.length) || (v1.recordCount ?? records.length) !== records.length) throw new Error('v1 recordCount mismatch');
  return records;
}

export function backupV1Ledger(v1Path: string | undefined, backupDir?: string): string | undefined {
  if (!v1Path || !existsSync(v1Path)) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = backupDir ?? dirname(v1Path);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, 'dsh_token_usage_sidebar.json.pre-v1.1-' + stamp + '-' + randomUUID() + '.bak');
  copyFileSync(v1Path, dest, constants.COPYFILE_EXCL);
  return dest;
}

export function migrateV1Ledger(dest: DurableStore, opts: MigrationOptions): MigrationResult {
  const started = Date.now();
  const existing = dest.readMeta()!;
  const currentTotal = () => dest.globalAggregate()?.total_tokens ?? 0;
  const result = (status: MigrationResult['status'], extra: Partial<MigrationResult> = {}): MigrationResult => ({
    migrated: status === 'done', status, sourceFound: false, migratedRecords: 0,
    v1LifetimeTotal: 0, v11LifetimeTotal: currentTotal(), durationMs: Date.now() - started, verification: [], ...extra,
  });
  if (existing.migrationStatus === 'done' && existing.migrationVersion >= V1_MIGRATION_VERSION) {
    return result('done', { migrated: false, skippedBecauseDone: true });
  }
  let v1 = opts.v1Root;
  let backupPath: string | undefined;
  let records: UsageRecord[] = [];
  try {
    if (!v1 && opts.v1Path) {
      const read = readV1RootResult(opts.v1Path);
      if (read.status === 'absent') return result('not_started');
      if (read.status === 'invalid') throw new Error(read.message);
      v1 = read.root;
    }
    if (!v1) return result('not_started');
    records = validateV1(v1);
    backupPath = opts.noBackup ? undefined : backupV1Ledger(opts.v1Path, opts.backupDir);
    inTransaction(dest.database, () => {
      const before = currentTotal();
      const prior = new Map(records.map((record) => [record.id, dest.getRecord(record.id)]));
      dest.writeMeta({ ...dest.readMeta()!, migrationStatus: 'in_progress', migrationVersion: V1_MIGRATION_VERSION });
      dest.apply(records);
      dest.rebuildAggregates();
      const failures = verifyV1ToV11(dest, v1!, records, { total: before, rows: prior });
      if (failures.length > 0) throw new Error(failures.join('; '));
      dest.writeMeta({
        ...dest.readMeta()!, migrationStatus: 'done', migrationVersion: V1_MIGRATION_VERSION,
        earliestRecordAt: dest.earliestRecordAt(), latestRecordAt: dest.latestRecordAt(),
        recoveryJson: v1!.recovery ? JSON.stringify(v1!.recovery) : null,
      });
    });
    return result('done', { sourceFound: true, migratedRecords: records.length, v1LifetimeTotal: v1.lifetimeTotal ?? 0, backupPath });
  } catch (error) {
    // The enclosing transaction restores overwritten rows, aggregates and meta.
    // No record deletion by id is used as a substitute for rollback.
    dest.writeMeta({ ...dest.readMeta()!, migrationStatus: 'failed' });
    return result('failed', { migrated: false, sourceFound: !!v1 || !!opts.v1Path,
      v1LifetimeTotal: v1?.lifetimeTotal ?? 0, backupPath, verification: [String((error as Error).message ?? error)] });
  }
}
export function buildRecordsFromV1(v1: V1LedgerState): UsageRecord[] {
  const byId = v1.byId ?? {}; const detailBy = v1.detailBy ?? {}; const dayBy = v1.dayBy ?? {}; const seqBy = v1.seqBy ?? {}; const src = v1.src ?? {};
  const ids = Object.keys(byId).sort(); const out: UsageRecord[] = [];
  for (const id of ids) {
    const total = byId[id]; const detail = detailBy[id] ?? {}; const localDate = dayBy[id] ?? 'unclassified';
    const parts = id.split(':'); let step = 0, turn = 0, sessionId = id;
    if (parts.length >= 3) { step = Number(parts[parts.length - 1]) || 0; turn = Number(parts[parts.length - 2]) || 0; sessionId = parts.slice(0, parts.length - 2).join(':'); }
    out.push({ id, source: 'assistant/message' as const, sessionId, turn, step, seq: seqBy[id] ?? 0, timestamp: Date.parse(localDate + 'T12:00:00') || 0, localDate, provider: detail.provider, model: detail.model,
      inputTokens: detail.inputTokens ?? 0, outputTokens: detail.outputTokens ?? 0, cacheReadTokens: detail.cacheReadTokens ?? 0, cacheWriteTokens: detail.cacheWriteTokens ?? 0,
      reasoningTokens: detail.reasoningTokens ?? 0, totalTokens: total, accounting: 'exact' as const, sourceType: src[id] ?? 'live_event', migrationVersion: V1_MIGRATION_VERSION });
  }
  return out;
}
export function verifyV1ToV11(
  dest: DurableStore, v1: V1LedgerState, records: UsageRecord[],
  before: { total: number; rows: Map<string, Record<string, unknown> | undefined> } = { total: 0, rows: new Map() },
): string[] {
  const failures: string[] = [];
  if (records.reduce((sum, record) => sum + record.totalTokens, 0) !== (v1.lifetimeTotal ?? 0)) failures.push('v1 source total mismatch');
  let delta = 0;
  for (const record of records) {
    const previous = before.rows.get(record.id);
    const stored = dest.getRecord(record.id);
    if (!stored) { failures.push('missing migrated record'); continue; }
    const previousTotal = previous?.excluded_reason == null ? Number(previous?.total_tokens ?? 0) : 0;
    const storedTotal = stored.excluded_reason == null ? Number(stored.total_tokens) : 0;
    delta += storedTotal - previousTotal;
    if (!previous && (storedTotal !== record.totalTokens || Number(stored.seq) !== record.seq)) failures.push('migrated record mismatch');
    if (previous && (Number(previous.seq) >= record.seq || Number(previous.accounting_version) > 1)
      && (storedTotal !== previousTotal || Number(stored.seq) !== Number(previous.seq))) failures.push('newer existing record changed');
  }
  if ((dest.globalAggregate()?.total_tokens ?? 0) !== before.total + delta) failures.push('migration union total mismatch');
  failures.push(...dest.verifyAggregates().details);
  return failures;
}
