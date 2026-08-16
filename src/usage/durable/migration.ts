// src/usage/durable/migration.ts — v1.0.1 (root JSON ledger) -> v1.1 (SQLite) migration
// Idempotent, crash-safe, verifiable, rollback-safe, no token loss, no double count.
// v1 JSON is READ-ONLY; SQLite written transactionally; cut over only after verify.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

export function readV1Root(v1Path: string): V1LedgerState | undefined {
  let text: string; try { text = readFileSync(v1Path, 'utf8'); } catch { return undefined; }
  try { const doc = JSON.parse(text) as { tables?: { ledger?: { root?: V1LedgerState } } }; return doc?.tables?.ledger?.root; } catch { return undefined; }
}
export function backupV1Ledger(v1Path: string | undefined, backupDir?: string): string | undefined {
  if (!v1Path || !existsSync(v1Path)) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = backupDir ?? dirname(v1Path); mkdirSync(dir, { recursive: true });
  const dest = join(dir, `dsh_token_usage_sidebar.json.pre-v1.1-${stamp}.bak`);
  copyFileSync(v1Path, dest); return dest;
}
export function migrateV1Ledger(dest: DurableStore, opts: MigrationOptions): MigrationResult {
  const t0 = Date.now();
  const existing = dest.readMeta();
  if (existing?.migrationStatus === 'done' && existing.migrationVersion >= V1_MIGRATION_VERSION) {
    const total = (existing.liveRecordedTotal ?? 0) + (existing.historicalRecoveredTotal ?? 0);
    return { migrated: false, status: 'done', sourceFound: false, migratedRecords: 0, v1LifetimeTotal: total, v11LifetimeTotal: total, durationMs: 0, verification: [], skippedBecauseDone: true };
  }
  let v1 = opts.v1Root;
  if (!v1 && opts.v1Path) v1 = readV1Root(opts.v1Path);
  if (!v1) return { migrated: false, status: 'not_started', sourceFound: false, migratedRecords: 0, v1LifetimeTotal: 0, v11LifetimeTotal: 0, durationMs: 0, verification: [] };
  const backupPath = opts.noBackup ? undefined : backupV1Ledger(opts.v1Path, opts.backupDir);
  { const m = dest.readMeta(); dest.writeMeta({ ...(m ?? dest.newMeta()), migrationStatus: 'in_progress', migrationVersion: V1_MIGRATION_VERSION }); }
  const records = buildRecordsFromV1(v1);
  dest.apply(records);
  dest.rebuildAggregates();
  const verification = verifyV1ToV11(dest, v1, records);
  const v11LifetimeTotal = dest.globalAggregate()?.total_tokens ?? 0;
  const v1LifetimeTotal = v1.lifetimeTotal ?? 0;
  const finalMeta = dest.readMeta()!;
  if (verification.length > 0) {
    // FAIL-CLOSED: do not cut over. Remove exactly the records this migration
    // introduced (they must never become visible unverified), rebuild aggregates
    // from whatever remains (pre-existing live records), then mark failed.
    dest.removeRecords(records.map((r) => r.id));
    dest.writeMeta({ ...dest.readMeta() ?? finalMeta, migrationStatus: 'failed' });
    return { migrated: false, status: 'failed', sourceFound: true, migratedRecords: records.length, v1LifetimeTotal, v11LifetimeTotal, durationMs: Date.now() - t0, verification, backupPath };
  }
  dest.writeMeta({ ...finalMeta, migrationStatus: 'done', migrationVersion: V1_MIGRATION_VERSION, earliestRecordAt: dest.earliestRecordAt(), latestRecordAt: dest.latestRecordAt(), recoveryJson: v1.recovery ? JSON.stringify(v1.recovery) : null });
  return { migrated: true, status: 'done', sourceFound: true, migratedRecords: records.length, v1LifetimeTotal, v11LifetimeTotal, durationMs: Date.now() - t0, verification, backupPath };
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
export function verifyV1ToV11(dest: DurableStore, v1: V1LedgerState, records: UsageRecord[]): string[] {
  const failures: string[] = [];
  const v1Lifetime = v1.lifetimeTotal ?? 0; const v1Count = v1.recordCount ?? Object.keys(v1.byId ?? {}).length;
  const v11Lifetime = dest.globalAggregate()?.total_tokens ?? 0; const v11Count = dest.recordCount();
  if (v1Lifetime !== v11Lifetime) failures.push(`lifetimeTotal mismatch: v1=${v1Lifetime} v1.1=${v11Lifetime}`);
  if (v1Count !== v11Count) failures.push(`recordCount mismatch: v1=${v1Count} v1.1=${v11Count}`);
  const sumRecords = records.reduce((a, r) => a + r.totalTokens, 0);
  if (sumRecords !== v11Lifetime) failures.push(`sum(records)=${sumRecords} != v1.1 global=${v11Lifetime}`);
  return failures;
}
