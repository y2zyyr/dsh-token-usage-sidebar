// src/usage/durable/durableStore.ts — v1.1 durable ledger store (SQLite)
// usage_records = source of truth; aggregate_* = derived cache.
// v1.1 invariant: ONE_NEW_INVOCATION ~= ONE_SMALL_DURABLE_UPSERT.
// Aggregate maintenance: on insert/replace, SUBTRACT old row contribution then
// ADD new record contribution, all in ONE transaction (records + deltas atomic).

import { DatabaseSync } from 'node:sqlite';
import type { UsageRecord } from '../types.ts';
import { inTransaction, openDatabase } from './wrapper.ts';
import { STORAGE_SCHEMA_VERSION } from './schema.ts';

export type MigrationStatus = 'not_started' | 'in_progress' | 'done' | 'failed';

export interface DurableMeta {
  storageSchemaVersion: number; migrationVersion: number; recordGeneration: number;
  aggregateGeneration: number; migrationStatus: MigrationStatus;
  lastAggregateRebuild: number | null; earliestRecordAt: number | null; latestRecordAt: number | null;
  liveRecordedTotal: number; historicalRecoveredTotal: number; historicalRecoveredRecordCount: number;
  recoveryJson: string | null;
}
export interface GlobalAggRow {
  total_tokens: number; input_tokens: number; output_tokens: number; cache_read_tokens: number;
  cache_write_tokens: number; reasoning_tokens: number; calls: number;
  unknown_tokens: number; unknown_calls: number; updated_at: number;
}
export interface DailyAggRow {
  local_date: string; total_tokens: number; input_tokens: number; output_tokens: number;
  cache_read_tokens: number; cache_write_tokens: number; reasoning_tokens: number;
  calls: number; unknown_tokens: number; unknown_calls: number;
}
export interface ModelAggRow {
  provider: string; model: string; total_tokens: number; input_tokens: number; output_tokens: number;
  cache_read_tokens: number; cache_write_tokens: number; reasoning_tokens: number;
  calls: number; unknown_tokens: number; unknown_calls: number;
}
export interface DayModelAggRow {
  local_date: string; provider: string; model: string; total_tokens: number; input_tokens: number;
  output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; reasoning_tokens: number; calls: number;
}
export interface BatchOutcome { added: number; replaced: number; ignored: number; }

const BLANK_GLOBAL: GlobalAggRow = { total_tokens: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, calls: 0, unknown_tokens: 0, unknown_calls: 0, updated_at: 0 };
export interface DurableStoreOptions { path: string; now?: () => number; }

interface Contribution {
  total: number; input: number; output: number; cacheRead: number; cacheWrite: number;
  reasoning: number; isCall: number; isUnknown: number; localDate: string; provider?: string; model?: string;
}
function contributionOf(rec: UsageRecord): Contribution {
  const sum = rec.inputTokens + rec.outputTokens + rec.cacheReadTokens + rec.cacheWriteTokens;
  const unclassified = sum !== rec.totalTokens;
  return { total: rec.totalTokens, input: unclassified ? 0 : rec.inputTokens, output: unclassified ? 0 : rec.outputTokens,
    cacheRead: unclassified ? 0 : rec.cacheReadTokens, cacheWrite: unclassified ? 0 : rec.cacheWriteTokens,
    reasoning: unclassified ? 0 : rec.reasoningTokens, isCall: unclassified ? 0 : 1, isUnknown: unclassified ? 1 : 0,
    localDate: rec.localDate, provider: rec.provider, model: rec.model };
}
function contributionOfRow(r: Record<string, unknown>): Contribution {
  const unclassified = Number(r.unclassified) === 1;
  return { total: Number(r.total_tokens), input: unclassified ? 0 : Number(r.input_tokens), output: unclassified ? 0 : Number(r.output_tokens),
    cacheRead: unclassified ? 0 : Number(r.cache_read_tokens), cacheWrite: unclassified ? 0 : Number(r.cache_write_tokens),
    reasoning: unclassified ? 0 : Number(r.reasoning_tokens), isCall: unclassified ? 0 : 1, isUnknown: unclassified ? 1 : 0,
    localDate: String(r.local_date), provider: r.provider == null ? undefined : String(r.provider), model: r.model == null ? undefined : String(r.model) };
}

export class DurableStore {
  private db: DatabaseSync;
  private now: () => number;
  private closed = false;
  constructor(opts: DurableStoreOptions) { this.now = opts.now ?? (() => Date.now()); this.db = openDatabase(opts.path); this.ensureMeta(); }
  get isClosed(): boolean { return this.closed; }

  private ensureMeta(): void {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM meta').get() as { c: number };
    if (Number(row.c) > 0) return;
    this.db.prepare(`INSERT INTO meta (id, storage_schema_version, migration_version, record_generation, aggregate_generation, migration_status, last_aggregate_rebuild, earliest_record_at, latest_record_at, live_recorded_total, historical_recovered_total, historical_recovered_record_count, recovery_json)
      VALUES (1,?,?,0,0,'not_started',NULL,NULL,NULL,0,0,0,NULL)`).run(STORAGE_SCHEMA_VERSION, 0);
  }
  readMeta(): DurableMeta | null {
    const row = this.db.prepare('SELECT * FROM meta WHERE id=1').get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return { storageSchemaVersion: Number(row.storage_schema_version), migrationVersion: Number(row.migration_version),
      recordGeneration: Number(row.record_generation), aggregateGeneration: Number(row.aggregate_generation),
      migrationStatus: row.migration_status as MigrationStatus,
      lastAggregateRebuild: row.last_aggregate_rebuild == null ? null : Number(row.last_aggregate_rebuild),
      earliestRecordAt: row.earliest_record_at == null ? null : Number(row.earliest_record_at),
      latestRecordAt: row.latest_record_at == null ? null : Number(row.latest_record_at),
      liveRecordedTotal: Number(row.live_recorded_total), historicalRecoveredTotal: Number(row.historical_recovered_total),
      historicalRecoveredRecordCount: Number(row.historical_recovered_record_count),
      recoveryJson: row.recovery_json == null ? null : String(row.recovery_json) };
  }
  writeMeta(m: DurableMeta): void {
    this.db.prepare(`INSERT INTO meta (id, storage_schema_version, migration_version, record_generation, aggregate_generation, migration_status, last_aggregate_rebuild, earliest_record_at, latest_record_at, live_recorded_total, historical_recovered_total, historical_recovered_record_count, recovery_json)
      VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET storage_schema_version=excluded.storage_schema_version, migration_version=excluded.migration_version,
      record_generation=excluded.record_generation, aggregate_generation=excluded.aggregate_generation, migration_status=excluded.migration_status,
      last_aggregate_rebuild=excluded.last_aggregate_rebuild, earliest_record_at=excluded.earliest_record_at, latest_record_at=excluded.latest_record_at,
      live_recorded_total=excluded.live_recorded_total, historical_recovered_total=excluded.historical_recovered_total,
      historical_recovered_record_count=excluded.historical_recovered_record_count, recovery_json=excluded.recovery_json`)
      .run(m.storageSchemaVersion, m.migrationVersion, m.recordGeneration, m.aggregateGeneration, m.migrationStatus,
        m.lastAggregateRebuild, m.earliestRecordAt, m.latestRecordAt, m.liveRecordedTotal, m.historicalRecoveredTotal,
        m.historicalRecoveredRecordCount, m.recoveryJson);
  }
  newMeta(): DurableMeta {
    return { storageSchemaVersion: STORAGE_SCHEMA_VERSION, migrationVersion: 0, recordGeneration: 0, aggregateGeneration: 0,
      migrationStatus: 'not_started', lastAggregateRebuild: null, earliestRecordAt: null, latestRecordAt: null,
      liveRecordedTotal: 0, historicalRecoveredTotal: 0, historicalRecoveredRecordCount: 0, recoveryJson: null };
  }

  recordCount(): number { return Number((this.db.prepare('SELECT COUNT(*) AS c FROM usage_records').get() as { c: number }).c); }
  hasRecord(id: string): boolean { return this.db.prepare('SELECT 1 AS x FROM usage_records WHERE canonical_id=?').get(id) !== undefined; }
  getRecord(id: string): Record<string, unknown> | undefined { return this.db.prepare('SELECT * FROM usage_records WHERE canonical_id=?').get(id) as Record<string, unknown> | undefined; }
  listRecords(): UsageRecord[] { return (this.db.prepare('SELECT * FROM usage_records').all() as Array<Record<string, unknown>>).map(rowToRecord); }
  provenanceSplit(): { live: number; historical: number; historicalCount: number } {
    const rows = this.db.prepare('SELECT source_type, COUNT(*) AS c, SUM(total_tokens) AS s FROM usage_records GROUP BY source_type').all() as Array<{ source_type: string | null; c: number; s: number }>;
    let live = 0, historical = 0, historicalCount = 0;
    for (const r of rows) { const isLive = r.source_type === 'live_event' || r.source_type === 'other' || r.source_type == null; if (isLive) live += Number(r.s); else { historical += Number(r.s); historicalCount += Number(r.c); } }
    return { live, historical, historicalCount };
  }
  globalAggregate(): GlobalAggRow | null { const g = this.db.prepare('SELECT * FROM aggregate_global WHERE id=1').get() as unknown as GlobalAggRow | undefined; return g ? { ...BLANK_GLOBAL, ...g } : null; }
  dailyTotals(): DailyAggRow[] { return this.db.prepare('SELECT * FROM aggregate_daily').all() as unknown as DailyAggRow[]; }
  daily(date: string): DailyAggRow | undefined { return this.db.prepare('SELECT * FROM aggregate_daily WHERE local_date=?').get(date) as unknown as DailyAggRow | undefined; }
  modelTotals(): ModelAggRow[] { return this.db.prepare('SELECT * FROM aggregate_model').all() as unknown as ModelAggRow[]; }
  dayModelTotals(date?: string): DayModelAggRow[] {
    if (date !== undefined) return this.db.prepare('SELECT * FROM aggregate_day_model WHERE local_date=?').all(date) as unknown as DayModelAggRow[];
    return this.db.prepare('SELECT * FROM aggregate_day_model').all() as unknown as DayModelAggRow[];
  }

  apply(records: readonly UsageRecord[]): BatchOutcome {
    const outcome: BatchOutcome = { added: 0, replaced: 0, ignored: 0 };
    if (records.length === 0) return outcome;
    const now = this.now();
    return inTransaction(this.db, () => {
      const meta = this.readMeta() ?? this.newMeta();
      let live = Number(meta.liveRecordedTotal ?? 0);
      let historical = Number(meta.historicalRecoveredTotal ?? 0);
      let historicalCount = Number(meta.historicalRecoveredRecordCount ?? 0);
      const histOrLiveOf = (st: string | null | undefined): 'live' | 'historical' =>
        (st === 'live_event' || st === 'other' || st == null) ? 'live' : 'historical';
      const getRow = this.db.prepare('SELECT * FROM usage_records WHERE canonical_id=?');
      for (const rec of records) {
        const oldRow = getRow.get(rec.id) as Record<string, unknown> | undefined;
        const knownSeq = oldRow === undefined ? undefined : Number(oldRow.seq);
        if (knownSeq !== undefined && rec.seq <= knownSeq) { outcome.ignored += 1; continue; }
        const isNew = oldRow === undefined;
        if (!isNew) this.subtractContribution(contributionOfRow(oldRow));
        const c = contributionOf(rec);
        this.addContribution(c);
        const sourceType = rec.sourceType ?? 'live_event';
        const histOrLive = histOrLiveOf(sourceType);
        const oldCreated = oldRow?.created_at;
        const createdAt = isNew ? now : (typeof oldCreated === 'number' ? oldCreated : now);
        this.db.prepare(upsertSql()).run(rec.id, rec.sessionId, rec.turn, rec.step, rec.seq, rec.timestamp, rec.localDate,
          rec.provider ?? null, rec.model ?? null, rec.inputTokens, rec.outputTokens, rec.cacheReadTokens, rec.cacheWriteTokens,
          rec.reasoningTokens, rec.totalTokens, c.isUnknown, sourceType, histOrLive, rec.migrationVersion ?? null, createdAt, now, STORAGE_SCHEMA_VERSION);
        // Incremental provenance split (O(1), never a full scan).
        if (isNew) {
          if (histOrLive === 'historical') { historical += rec.totalTokens; historicalCount += 1; }
          else live += rec.totalTokens;
        } else {
          // source_type is FIRST-SEEN: the upsert never overwrites it on conflict,
          // so a replaced row stays in its original bucket (v1 attribution). Only
          // its total changes within that bucket.
          const bucket = histOrLiveOf(oldRow.source_type as string | null);
          const oldTotal = Number(oldRow.total_tokens);
          const delta = rec.totalTokens - oldTotal;
          if (bucket === 'historical') historical += delta; else live += delta;
        }
        if (isNew) outcome.added += 1; else outcome.replaced += 1;
      }
      this.bumpRecordGeneration(now, { live, historical, historicalCount });
      return outcome;
    });
  }

  private addContribution(c: Contribution): void {
    this.db.prepare(`INSERT INTO aggregate_global (id, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls, unknown_tokens, unknown_calls, updated_at)
      VALUES (1,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
      output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
      reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls, unknown_tokens=unknown_tokens+excluded.unknown_tokens,
      unknown_calls=unknown_calls+excluded.unknown_calls, updated_at=excluded.updated_at`)
      .run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.isUnknown === 1 ? c.total : 0, c.isUnknown, this.now());
    this.db.prepare(`INSERT INTO aggregate_daily (local_date, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls, unknown_tokens, unknown_calls)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(local_date) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
      output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
      reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls, unknown_tokens=unknown_tokens+excluded.unknown_tokens, unknown_calls=unknown_calls+excluded.unknown_calls`)
      .run(c.localDate, c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.isUnknown === 1 ? c.total : 0, c.isUnknown);
    if (c.isUnknown !== 1) {
      this.db.prepare(`INSERT INTO aggregate_model (provider, model, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(provider, model) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
        output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
        reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls`).run(c.provider ?? 'Unknown provider', c.model ?? 'Unknown model', c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, 1);
      this.db.prepare(`INSERT INTO aggregate_day_model (local_date, provider, model, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(local_date, provider, model) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
        output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
        reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls`).run(c.localDate, c.provider ?? 'Unknown provider', c.model ?? 'Unknown model', c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, 1);
    }
  }

  private subtractContribution(c: Contribution): void {
    this.db.prepare('UPDATE aggregate_global SET total_tokens=MAX(0,total_tokens-?), input_tokens=MAX(0,input_tokens-?), output_tokens=MAX(0,output_tokens-?), cache_read_tokens=MAX(0,cache_read_tokens-?), cache_write_tokens=MAX(0,cache_write_tokens-?), reasoning_tokens=MAX(0,reasoning_tokens-?), calls=MAX(0,calls-?), unknown_tokens=MAX(0,unknown_tokens-?), unknown_calls=MAX(0,unknown_calls-?), updated_at=? WHERE id=1')
      .run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.isUnknown === 1 ? c.total : 0, c.isUnknown, this.now());
    this.db.prepare('UPDATE aggregate_daily SET total_tokens=MAX(0,total_tokens-?), input_tokens=MAX(0,input_tokens-?), output_tokens=MAX(0,output_tokens-?), cache_read_tokens=MAX(0,cache_read_tokens-?), cache_write_tokens=MAX(0,cache_write_tokens-?), reasoning_tokens=MAX(0,reasoning_tokens-?), calls=MAX(0,calls-?), unknown_tokens=MAX(0,unknown_tokens-?), unknown_calls=MAX(0,unknown_calls-?) WHERE local_date=?')
      .run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.isUnknown === 1 ? c.total : 0, c.isUnknown, c.localDate);
    if (c.isUnknown !== 1) {
      this.db.prepare('UPDATE aggregate_model SET total_tokens=MAX(0,total_tokens-?), input_tokens=MAX(0,input_tokens-?), output_tokens=MAX(0,output_tokens-?), cache_read_tokens=MAX(0,cache_read_tokens-?), cache_write_tokens=MAX(0,cache_write_tokens-?), reasoning_tokens=MAX(0,reasoning_tokens-?), calls=MAX(0,calls-?) WHERE provider=? AND model=?')
        .run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.provider ?? 'Unknown provider', c.model ?? 'Unknown model');
      this.db.prepare('UPDATE aggregate_day_model SET total_tokens=MAX(0,total_tokens-?), input_tokens=MAX(0,input_tokens-?), output_tokens=MAX(0,output_tokens-?), cache_read_tokens=MAX(0,cache_read_tokens-?), cache_write_tokens=MAX(0,cache_write_tokens-?), reasoning_tokens=MAX(0,reasoning_tokens-?), calls=MAX(0,calls-?) WHERE local_date=? AND provider=? AND model=?')
        .run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.localDate, c.provider ?? 'Unknown provider', c.model ?? 'Unknown model');
    }
  }

  /** Cheap meta bump: generation, latest timestamp, and the precomputed split. */
  private bumpRecordGeneration(now: number, split: { live: number; historical: number; historicalCount: number }): void {
    const m = this.readMeta() ?? this.newMeta();
    m.recordGeneration += 1; m.latestRecordAt = now;
    m.liveRecordedTotal = split.live; m.historicalRecoveredTotal = split.historical; m.historicalRecoveredRecordCount = split.historicalCount;
    this.writeMeta(m);
  }

  rebuildAggregates(): GlobalAggRow {
    return inTransaction(this.db, () => {
      this.db.exec('DELETE FROM aggregate_global'); this.db.exec('DELETE FROM aggregate_daily');
      this.db.exec('DELETE FROM aggregate_model'); this.db.exec('DELETE FROM aggregate_day_model');
      const rows = this.db.prepare('SELECT * FROM usage_records').all() as Array<Record<string, unknown>>;
      const global = { ...BLANK_GLOBAL };
      for (const raw of rows) {
        const c = contributionOfRow(raw);
        global.total_tokens += c.total;
        if (c.isUnknown === 1) { global.unknown_tokens += c.total; global.unknown_calls += c.isUnknown; continue; }
        global.input_tokens += c.input; global.output_tokens += c.output; global.cache_read_tokens += c.cacheRead;
        global.cache_write_tokens += c.cacheWrite; global.reasoning_tokens += c.reasoning; global.calls += c.isCall;
        this.db.prepare(`INSERT INTO aggregate_daily (local_date, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(local_date) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
          output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
          reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls`).run(c.localDate, c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall);
        this.db.prepare(`INSERT INTO aggregate_model (provider, model, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(provider, model) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
          output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
          reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls`).run(c.provider ?? 'Unknown provider', c.model ?? 'Unknown model', c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, 1);
        this.db.prepare(`INSERT INTO aggregate_day_model (local_date, provider, model, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls)
          VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(local_date, provider, model) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
          output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
          reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls`).run(c.localDate, c.provider ?? 'Unknown provider', c.model ?? 'Unknown model', c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, 1);
      }
      const now = this.now();
      this.db.prepare(`INSERT INTO aggregate_global (id, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls, unknown_tokens, unknown_calls, updated_at)
        VALUES (1,?,?,?,?,?,?,?,?,?,?)`).run(global.total_tokens, global.input_tokens, global.output_tokens, global.cache_read_tokens, global.cache_write_tokens, global.reasoning_tokens, global.calls, global.unknown_tokens, global.unknown_calls, now);
      const m = this.readMeta() ?? this.newMeta();
      m.aggregateGeneration = m.recordGeneration; m.lastAggregateRebuild = now;
      const split = this.provenanceSplit();
      m.liveRecordedTotal = split.live; m.historicalRecoveredTotal = split.historical; m.historicalRecoveredRecordCount = split.historicalCount;
      this.writeMeta(m);
      return global;
    });
  }

  earliestRecordAt(): number | null { const r = this.db.prepare('SELECT MIN(timestamp) AS v FROM usage_records').get() as { v: number | null }; return r.v == null ? null : Number(r.v); }
  latestRecordAt(): number | null { const r = this.db.prepare('SELECT MAX(timestamp) AS v FROM usage_records').get() as { v: number | null }; return r.v == null ? null : Number(r.v); }
  verifyAggregates(): { ok: boolean; recordTotal: number; globalTotal: number; details: string[] } {
    const recordTotal = Number((this.db.prepare('SELECT COALESCE(SUM(total_tokens),0) AS s FROM usage_records').get() as { s: number }).s);
    const global = this.globalAggregate(); const globalTotal = global?.total_tokens ?? 0;
    const calls = global?.calls ?? 0; const recordCalls = this.recordCount();
    const details: string[] = [];
    if (recordTotal !== globalTotal) details.push(`total mismatch: records=${recordTotal} global=${globalTotal}`);
    if (recordCalls !== calls) details.push(`calls mismatch: records=${recordCalls} global=${calls}`);
    return { ok: details.length === 0, recordTotal, globalTotal, details };
  }
  /** Expose the live handle for migration/test integration that must call raw SQL. */
  get database(): DatabaseSync { return this.db; }
  /** Delete the given canonical ids and rebuild all aggregates in ONE transaction.
   *  Used by migration rollback (fail-closed: unverified v1 records are removed so
   *  they never become visible before a verified cut-over). Idempotent. */
  removeRecords(ids: readonly string[]): void {
    if (ids.length === 0) return;
    inTransaction(this.db, () => {
      const del = this.db.prepare('DELETE FROM usage_records WHERE canonical_id=?');
      for (const id of ids) del.run(id);
    });
    this.rebuildAggregates();
  }
  close(): void { if (this.closed) return; this.closed = true; try { this.db.close(); } catch {} }
}

function rowToRecord(r: Record<string, unknown>): UsageRecord {
  return { id: String(r.canonical_id), source: 'assistant/message' as const, sessionId: String(r.session_id),
    turn: Number(r.turn), step: Number(r.step), seq: Number(r.seq), timestamp: Number(r.timestamp),
    localDate: String(r.local_date), provider: r.provider == null ? undefined : String(r.provider),
    model: r.model == null ? undefined : String(r.model), inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens), cacheWriteTokens: Number(r.cache_write_tokens), reasoningTokens: Number(r.reasoning_tokens),
    totalTokens: Number(r.total_tokens), accounting: 'exact' as const, sourceType: (r.source_type as UsageRecord['sourceType']) ?? 'live_event' };
}
function upsertSql(): string {
  return `INSERT INTO usage_records (canonical_id, session_id, turn, step, seq, timestamp, local_date, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, unclassified, source_type, historical_or_live, migration_version, created_at, updated_at, schema_version)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(canonical_id) DO UPDATE SET seq=excluded.seq, timestamp=excluded.timestamp, local_date=excluded.local_date, provider=excluded.provider, model=excluded.model,
  input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens, cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens,
  reasoning_tokens=excluded.reasoning_tokens, total_tokens=excluded.total_tokens, unclassified=excluded.unclassified, historical_or_live=excluded.historical_or_live, updated_at=excluded.updated_at`;
}
