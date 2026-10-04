// src/usage/durable/durableStore.ts — v1.1 durable ledger store (SQLite)
// usage_records = source of truth; aggregate_* = derived cache.
// v1.1 invariant: ONE_NEW_INVOCATION ~= ONE_SMALL_DURABLE_UPSERT.
// Aggregate maintenance: on insert/replace, SUBTRACT old row contribution then
// ADD new record contribution, all in ONE transaction (records + deltas atomic).

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { UsageRecord } from '../types.ts';
import type { ProviderAliasGroup } from '../providerAliases.ts';
import { inTransaction, openDatabase, backupDatabaseTo } from './wrapper.ts';
import { STORAGE_SCHEMA_VERSION } from './schema.ts';
import { assertUsageRecord, isLocalDate } from '../validation.ts';

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

export interface ProviderAliasGroupInput {
  id?: string;
  label: string;
  rawValues: readonly string[];
}

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
  if (r.excluded_reason != null) return { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, isCall: 0, isUnknown: 0, localDate: String(r.local_date) };
  const unclassified = Number(r.input_tokens) + Number(r.output_tokens) + Number(r.cache_read_tokens) + Number(r.cache_write_tokens) !== Number(r.total_tokens);
  return { total: Number(r.total_tokens), input: unclassified ? 0 : Number(r.input_tokens), output: unclassified ? 0 : Number(r.output_tokens),
    cacheRead: unclassified ? 0 : Number(r.cache_read_tokens), cacheWrite: unclassified ? 0 : Number(r.cache_write_tokens),
    reasoning: unclassified ? 0 : Number(r.reasoning_tokens), isCall: unclassified ? 0 : 1, isUnknown: unclassified ? 1 : 0,
    localDate: String(r.local_date), provider: r.provider == null ? undefined : String(r.provider), model: r.model == null ? undefined : String(r.model) };
}

export class DurableStore {
  private db: DatabaseSync;
  private now: () => number;
  private closed = false;
  private statements = new Map<string, StatementSync>();
  private path: string;
  private accountingBackup?: string;
  readonly repairedOnOpen: boolean;
  constructor(opts: DurableStoreOptions) {
    this.path = opts.path;
    this.now = opts.now ?? (() => Date.now());
    this.db = openDatabase(opts.path);
    try {
      this.ensureMeta();
      const verification = this.verifyAggregates();
      if (verification.invalidRecords > 0) throw new Error('invalid-usage-ledger-records');
      this.repairedOnOpen = !verification.ok;
      if (!verification.ok) this.rebuildAggregates();
      else {
        const meta = this.readMeta()!;
        if (meta.aggregateGeneration !== meta.recordGeneration) this.writeMeta({ ...meta, aggregateGeneration: meta.recordGeneration });
      }
    } catch (error) { this.db.close(); throw error; }
  }
  get isClosed(): boolean { return this.closed; }
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }

  private ensureMeta(): void {
    const row = this.statement('SELECT COUNT(*) AS c FROM meta').get() as { c: number };
    if (Number(row.c) > 0) {
      // Adding the local alias table (schema 3) and the session scan-failure
      // cache (schema 4) are additive changes. Existing ledgers keep all records
      // and aggregates; only the metadata version is advanced so diagnostics can
      // identify the new schema.
      this.statement('UPDATE meta SET storage_schema_version=? WHERE id=1 AND storage_schema_version<?')
        .run(STORAGE_SCHEMA_VERSION, STORAGE_SCHEMA_VERSION);
      return;
    }
    this.statement(`INSERT INTO meta (id, storage_schema_version, migration_version, record_generation, aggregate_generation, migration_status, last_aggregate_rebuild, earliest_record_at, latest_record_at, live_recorded_total, historical_recovered_total, historical_recovered_record_count, recovery_json)
      VALUES (1,?,?,0,0,'not_started',NULL,NULL,NULL,0,0,0,NULL)`).run(STORAGE_SCHEMA_VERSION, 0);
  }
  readMeta(): DurableMeta | null {
    const row = this.statement('SELECT * FROM meta WHERE id=1').get() as Record<string, unknown> | undefined;
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
    this.statement(`INSERT INTO meta (id, storage_schema_version, migration_version, record_generation, aggregate_generation, migration_status, last_aggregate_rebuild, earliest_record_at, latest_record_at, live_recorded_total, historical_recovered_total, historical_recovered_record_count, recovery_json)
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

  recordCount(): number { return Number((this.statement('SELECT COUNT(*) AS c FROM usage_records WHERE excluded_reason IS NULL').get() as { c: number }).c); }
  hasRecord(id: string): boolean { return this.statement('SELECT 1 AS x FROM usage_records WHERE canonical_id=?').get(id) !== undefined; }
  getRecord(id: string): Record<string, unknown> | undefined { return this.statement('SELECT * FROM usage_records WHERE canonical_id=?').get(id) as Record<string, unknown> | undefined; }
  listRecords(): UsageRecord[] { return (this.statement('SELECT * FROM usage_records WHERE excluded_reason IS NULL').all() as Array<Record<string, unknown>>).map(rowToRecord); }
  provenanceSplit(): { live: number; historical: number; historicalCount: number } {
    const rows = this.statement('SELECT source_type, COUNT(*) AS c, SUM(total_tokens) AS s FROM usage_records WHERE excluded_reason IS NULL GROUP BY source_type').all() as Array<{ source_type: string | null; c: number; s: number }>;
    let live = 0, historical = 0, historicalCount = 0;
    for (const r of rows) { const isLive = r.source_type === 'live_event' || r.source_type === 'other' || r.source_type == null; if (isLive) live += Number(r.s); else { historical += Number(r.s); historicalCount += Number(r.c); } }
    return { live, historical, historicalCount };
  }
  globalAggregate(): GlobalAggRow | null { const g = this.statement('SELECT * FROM aggregate_global WHERE id=1').get() as unknown as GlobalAggRow | undefined; return g ? { ...BLANK_GLOBAL, ...g } : null; }
  dailyTotals(start?: string, end?: string): DailyAggRow[] {
    return start === undefined ? this.statement('SELECT * FROM aggregate_daily ORDER BY local_date').all() as unknown as DailyAggRow[]
      : this.statement('SELECT * FROM aggregate_daily WHERE local_date BETWEEN ? AND ? ORDER BY local_date').all(start, end ?? start) as unknown as DailyAggRow[];
  }
  daily(date: string): DailyAggRow | undefined { return this.statement('SELECT * FROM aggregate_daily WHERE local_date=?').get(date) as unknown as DailyAggRow | undefined; }
  modelTotals(): ModelAggRow[] { return this.statement('SELECT * FROM aggregate_model').all() as unknown as ModelAggRow[]; }
  dayModelTotals(date?: string, end?: string): DayModelAggRow[] {
    if (date !== undefined) return this.statement('SELECT * FROM aggregate_day_model WHERE local_date BETWEEN ? AND ?').all(date, end ?? date) as unknown as DayModelAggRow[];
    return this.statement('SELECT * FROM aggregate_day_model').all() as unknown as DayModelAggRow[];
  }

  listProviderAliasGroups(): ProviderAliasGroup[] {
    const rows = this.statement('SELECT id, label, raw_values_json FROM provider_alias_groups ORDER BY label COLLATE NOCASE, id').all() as Array<Record<string, unknown>>;
    const groups: ProviderAliasGroup[] = [];
    for (const row of rows) {
      try {
        const values = JSON.parse(String(row.raw_values_json));
        if (!Array.isArray(values)) continue;
        const rawValues = [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))];
        const id = String(row.id);
        const label = String(row.label);
        if (id.length === 0 || label.length === 0 || rawValues.length === 0) continue;
        groups.push({ id, label, rawValues });
      } catch {
        // A malformed optional alias row must not prevent the usage ledger
        // from opening. It is ignored until the user replaces/removes it.
      }
    }
    return groups;
  }

  upsertProviderAliasGroup(input: ProviderAliasGroupInput): ProviderAliasGroup {
    const id = input.id?.trim() || 'provider-group-' + randomUUID();
    const label = input.label.trim();
    const rawValues = [...new Set(input.rawValues.map((value) => value.trim()).filter((value) => value.length > 0))].sort((a, b) => a.localeCompare(b));
    if (label.length === 0) throw new Error('provider-alias-label-required');
    if (rawValues.length === 0) throw new Error('provider-alias-values-required');
    if (id.length > 160 || label.length > 200 || rawValues.some((value) => value.length > 300)) {
      throw new Error('provider-alias-value-too-long');
    }

    const groups = this.listProviderAliasGroups();
    const conflict = groups.find((group) => group.id !== id && group.rawValues.some((value) => rawValues.includes(value)));
    if (conflict) throw new Error('provider-alias-overlap:' + conflict.label);

    const now = this.now();
    const existing = this.statement('SELECT created_at FROM provider_alias_groups WHERE id=?').get(id) as { created_at?: number } | undefined;
    const createdAt = existing?.created_at == null ? now : Number(existing.created_at);
    this.statement(`INSERT INTO provider_alias_groups (id, label, raw_values_json, created_at, updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label, raw_values_json=excluded.raw_values_json, updated_at=excluded.updated_at`)
      .run(id, label, JSON.stringify(rawValues), createdAt, now);
    return { id, label, rawValues };
  }

  deleteProviderAliasGroup(id: string): boolean {
    const result = this.statement('DELETE FROM provider_alias_groups WHERE id=?').run(id);
    return Number(result.changes ?? 0) > 0;
  }

  apply(records: readonly UsageRecord[], options: { reconcile?: boolean } = {}): BatchOutcome {
    const outcome: BatchOutcome = { added: 0, replaced: 0, ignored: 0 };
    if (records.length === 0) return outcome;
    for (const record of records) assertUsageRecord(record);
    const now = this.now();
    return inTransaction(this.db, () => {
      const meta = this.readMeta() ?? this.newMeta();
      let live = Number(meta.liveRecordedTotal ?? 0);
      let historical = Number(meta.historicalRecoveredTotal ?? 0);
      let historicalCount = Number(meta.historicalRecoveredRecordCount ?? 0);
      const histOrLiveOf = (st: string | null | undefined): 'live' | 'historical' =>
        (st === 'live_event' || st === 'other' || st == null) ? 'live' : 'historical';
      const getRow = this.statement('SELECT * FROM usage_records WHERE canonical_id=?');
      for (let rec of records) {
        const oldRow = getRow.get(rec.id) as Record<string, unknown> | undefined;
        const knownSeq = oldRow === undefined ? undefined : Number(oldRow.seq);
        const oldVersion = Number(oldRow?.accounting_version ?? 1);
        const version = rec.accountingVersion ?? 1;
        const upgrade = options.reconcile === true && oldRow !== undefined && version > oldVersion;
        if (oldRow && version < oldVersion) { outcome.ignored += 1; continue; }
        if (oldRow && !upgrade && (rec.seq <= knownSeq! || version > oldVersion)) {
          const enriched = enrichEqualSequence(oldRow, rec);
          if (!enriched) { outcome.ignored += 1; continue; }
          rec = enriched;
        }
        if (!oldRow && version >= 2 && rec.id.includes(':retry:')) {
          const base = getRow.get(rec.sessionId + ':' + rec.turn + ':' + rec.step) as Record<string, unknown> | undefined;
          if (!options.reconcile && base && Number(base.accounting_version) < 2 && rec.seq <= Number(base.seq)) {
            outcome.ignored += 1; continue;
          }
        }
        const isNew = oldRow === undefined;
        if (!isNew) this.subtractContribution(contributionOfRow(oldRow));
        const c = contributionOf(rec);
        this.addContribution(c);
        const sourceType = rec.sourceType ?? 'live_event';
        const histOrLive = histOrLiveOf(sourceType);
        const oldCreated = oldRow?.created_at;
        const createdAt = isNew ? now : (typeof oldCreated === 'number' ? oldCreated : now);
        this.statement(upsertSql()).run(rec.id, rec.sessionId, rec.turn, rec.step, rec.seq, rec.timestamp, rec.localDate,
          rec.provider ?? null, rec.model ?? null, rec.inputTokens, rec.outputTokens, rec.cacheReadTokens, rec.cacheWriteTokens,
          rec.reasoningTokens, rec.totalTokens, c.isUnknown, sourceType, String(oldRow?.historical_or_live ?? histOrLive), rec.migrationVersion ?? null, createdAt, now, STORAGE_SCHEMA_VERSION,
          rec.accountingVersion ?? 1);
        // An older source can introduce previously unseen inherited/retry rows
        // after a session checkpoint was saved. They require a full replay.
        if ((rec.accountingVersion ?? 1) < 2) this.statement('DELETE FROM session_recovery WHERE session_id=?').run(rec.sessionId);
        // Incremental provenance split (O(1), never a full scan).
        if (isNew) {
          if (histOrLive === 'historical') { historical += rec.totalTokens; historicalCount += 1; }
          else live += rec.totalTokens;
        } else {
          // source_type is FIRST-SEEN: the upsert never overwrites it on conflict,
          // so a replaced row stays in its original bucket (v1 attribution). Only
          // its total changes within that bucket.
          const bucket = histOrLiveOf(oldRow.source_type as string | null);
          const oldTotal = oldRow.excluded_reason == null ? Number(oldRow.total_tokens) : 0;
          const delta = rec.totalTokens - oldTotal;
          if (bucket === 'historical') { historical += delta; if (oldRow.excluded_reason != null) historicalCount += 1; } else live += delta;
        }
        if (isNew) outcome.added += 1; else outcome.replaced += 1;
      }
      if (outcome.added + outcome.replaced > 0) this.bumpRecordGeneration(now, { live, historical, historicalCount });
      return outcome;
    });
  }

  private addContribution(c: Contribution): void {
    if (c.isCall === 0 && c.isUnknown === 0) return;
    const current = this.globalAggregate();
    const additions: Record<string, number> = { total_tokens: c.total, input_tokens: c.input,
      output_tokens: c.output, cache_read_tokens: c.cacheRead, cache_write_tokens: c.cacheWrite,
      reasoning_tokens: c.reasoning, calls: c.isCall,
      unknown_tokens: c.isUnknown === 1 ? c.total : 0, unknown_calls: c.isUnknown };
    if (Object.entries(additions).some(([field, value]) => !Number.isSafeInteger(Number(current?.[field as keyof GlobalAggRow] ?? 0) + value))) {
      throw new Error('invalid-usage-record: aggregate overflow');
    }
    this.statement(`INSERT INTO aggregate_global (id, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls, unknown_tokens, unknown_calls, updated_at)
      VALUES (1,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
      output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
      reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls, unknown_tokens=unknown_tokens+excluded.unknown_tokens,
      unknown_calls=unknown_calls+excluded.unknown_calls, updated_at=excluded.updated_at`)
      .run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.isUnknown === 1 ? c.total : 0, c.isUnknown, this.now());
    if (isLocalDate(c.localDate)) this.statement(`INSERT INTO aggregate_daily (local_date, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls, unknown_tokens, unknown_calls)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(local_date) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
      output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
      reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls, unknown_tokens=unknown_tokens+excluded.unknown_tokens, unknown_calls=unknown_calls+excluded.unknown_calls`)
      .run(c.localDate, c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.isUnknown === 1 ? c.total : 0, c.isUnknown);
    if (c.isUnknown !== 1) {
      this.statement(`INSERT INTO aggregate_model (provider, model, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(provider, model) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
        output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
        reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls`).run(c.provider ?? 'Unknown provider', c.model ?? 'Unknown model', c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, 1);
      if (isLocalDate(c.localDate)) this.statement(`INSERT INTO aggregate_day_model (local_date, provider, model, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(local_date, provider, model) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
        output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
        reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls`).run(c.localDate, c.provider ?? 'Unknown provider', c.model ?? 'Unknown model', c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, 1);
    }
  }

  private subtractContribution(c: Contribution): void {
    if (c.isCall === 0 && c.isUnknown === 0) return;
    this.statement('UPDATE aggregate_global SET total_tokens=MAX(0,total_tokens-?), input_tokens=MAX(0,input_tokens-?), output_tokens=MAX(0,output_tokens-?), cache_read_tokens=MAX(0,cache_read_tokens-?), cache_write_tokens=MAX(0,cache_write_tokens-?), reasoning_tokens=MAX(0,reasoning_tokens-?), calls=MAX(0,calls-?), unknown_tokens=MAX(0,unknown_tokens-?), unknown_calls=MAX(0,unknown_calls-?), updated_at=? WHERE id=1')
      .run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.isUnknown === 1 ? c.total : 0, c.isUnknown, this.now());
    this.statement('UPDATE aggregate_daily SET total_tokens=MAX(0,total_tokens-?), input_tokens=MAX(0,input_tokens-?), output_tokens=MAX(0,output_tokens-?), cache_read_tokens=MAX(0,cache_read_tokens-?), cache_write_tokens=MAX(0,cache_write_tokens-?), reasoning_tokens=MAX(0,reasoning_tokens-?), calls=MAX(0,calls-?), unknown_tokens=MAX(0,unknown_tokens-?), unknown_calls=MAX(0,unknown_calls-?) WHERE local_date=?')
      .run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.isUnknown === 1 ? c.total : 0, c.isUnknown, c.localDate);
    if (c.isUnknown !== 1) {
      this.statement('UPDATE aggregate_model SET total_tokens=MAX(0,total_tokens-?), input_tokens=MAX(0,input_tokens-?), output_tokens=MAX(0,output_tokens-?), cache_read_tokens=MAX(0,cache_read_tokens-?), cache_write_tokens=MAX(0,cache_write_tokens-?), reasoning_tokens=MAX(0,reasoning_tokens-?), calls=MAX(0,calls-?) WHERE provider=? AND model=?')
        .run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.provider ?? 'Unknown provider', c.model ?? 'Unknown model');
      this.statement('UPDATE aggregate_day_model SET total_tokens=MAX(0,total_tokens-?), input_tokens=MAX(0,input_tokens-?), output_tokens=MAX(0,output_tokens-?), cache_read_tokens=MAX(0,cache_read_tokens-?), cache_write_tokens=MAX(0,cache_write_tokens-?), reasoning_tokens=MAX(0,reasoning_tokens-?), calls=MAX(0,calls-?) WHERE local_date=? AND provider=? AND model=?')
        .run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.localDate, c.provider ?? 'Unknown provider', c.model ?? 'Unknown model');
    }
  }

  /** Cheap meta bump: generation, latest timestamp, and the precomputed split. */
  private bumpRecordGeneration(now: number, split: { live: number; historical: number; historicalCount: number }): void {
    const m = this.readMeta() ?? this.newMeta();
    m.recordGeneration += 1; m.aggregateGeneration = m.recordGeneration; m.latestRecordAt = now;
    m.liveRecordedTotal = split.live; m.historicalRecoveredTotal = split.historical; m.historicalRecoveredRecordCount = split.historicalCount;
    this.writeMeta(m);
  }

  private expectedAggregates(): Map<string, { keys: string[]; rows: Record<string, unknown>[] }> {
    const known = '(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens = total_tokens)';
    const metrics = [
      'COALESCE(SUM(total_tokens),0) AS total_tokens',
      ...['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens']
        .map((field) => 'COALESCE(SUM(CASE WHEN ' + known + ' THEN ' + field + ' ELSE 0 END),0) AS ' + field),
      'COALESCE(SUM(CASE WHEN ' + known + ' THEN 1 ELSE 0 END),0) AS calls',
      'COALESCE(SUM(CASE WHEN ' + known + ' THEN 0 ELSE total_tokens END),0) AS unknown_tokens',
      'COALESCE(SUM(CASE WHEN ' + known + ' THEN 0 ELSE 1 END),0) AS unknown_calls',
    ].join(',');
    const active = ' FROM usage_records WHERE excluded_reason IS NULL';
    const dated = " AND local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";
    const provider = "COALESCE(provider,'Unknown provider')";
    const model = "COALESCE(model,'Unknown model')";
    return new Map([
      ['aggregate_global', { keys: ['id'], rows: this.statement('SELECT 1 AS id,' + metrics + active).all() as Record<string, unknown>[] }],
      ['aggregate_daily', { keys: ['local_date'], rows: this.statement('SELECT local_date,' + metrics + active + dated + ' GROUP BY local_date').all() as Record<string, unknown>[] }],
      ['aggregate_model', { keys: ['provider', 'model'], rows: this.statement('SELECT ' + provider + ' AS provider,' + model + ' AS model,' + metrics + active + ' AND ' + known + ' GROUP BY ' + provider + ',' + model).all() as Record<string, unknown>[] }],
      ['aggregate_day_model', { keys: ['local_date', 'provider', 'model'], rows: this.statement('SELECT local_date,' + provider + ' AS provider,' + model + ' AS model,' + metrics + active + dated + ' AND ' + known + ' GROUP BY local_date,' + provider + ',' + model).all() as Record<string, unknown>[] }],
    ]);
  }

  private invalidRecordCount(): number {
    const numeric = ['turn', 'step', 'seq', 'timestamp', 'input_tokens', 'output_tokens',
      'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'total_tokens', 'accounting_version'];
    const invalid = numeric.map((field) => "(typeof(" + field + ")!='integer' OR " + field + '<0 OR ' + field + '>9007199254740991)');
    invalid.push('accounting_version<1', 'input_tokens+output_tokens+cache_read_tokens+cache_write_tokens>9007199254740991',
      "canonical_id='' OR session_id=''",
      "(local_date NOT IN ('','unclassified') AND (date(local_date,'+0 days') IS NULL OR date(local_date,'+0 days')!=local_date))");
    return Number((this.statement('SELECT COUNT(*) AS c FROM usage_records WHERE ' + invalid.join(' OR ')).get() as { c: number }).c);
  }

  rebuildAggregates(): GlobalAggRow {
    return inTransaction(this.db, () => {
      if (this.invalidRecordCount() > 0) throw new Error('invalid-usage-ledger-records');
      const expected = this.expectedAggregates();
      for (const [table, state] of expected) {
        this.db.exec('DELETE FROM ' + table);
        const metrics = table === 'aggregate_day_model' ? METRIC_COLUMNS.slice(0, 7) : METRIC_COLUMNS;
        const columns = [...state.keys, ...metrics, ...(table === 'aggregate_global' ? ['updated_at'] : [])];
        const insert = this.statement('INSERT INTO ' + table + ' (' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')');
        for (const row of state.rows) insert.run(...columns.map((column) => column === 'updated_at' ? this.now() : row[column] as string | number));
      }
      // This flag is derived from the buckets, not an independent authority.
      this.db.exec('UPDATE usage_records SET unclassified=CASE WHEN input_tokens+output_tokens+cache_read_tokens+cache_write_tokens=total_tokens THEN 0 ELSE 1 END');
      const meta = this.readMeta() ?? this.newMeta();
      meta.aggregateGeneration = meta.recordGeneration;
      meta.lastAggregateRebuild = this.now();
      const split = this.provenanceSplit();
      meta.liveRecordedTotal = split.live;
      meta.historicalRecoveredTotal = split.historical;
      meta.historicalRecoveredRecordCount = split.historicalCount;
      this.writeMeta(meta);
      return this.globalAggregate()!;
    });
  }

  earliestRecordAt(): number | null { const r = this.statement('SELECT MIN(timestamp) AS v FROM usage_records WHERE excluded_reason IS NULL').get() as { v: number | null }; return r.v == null ? null : Number(r.v); }
  latestRecordAt(): number | null { const r = this.statement('SELECT MAX(timestamp) AS v FROM usage_records WHERE excluded_reason IS NULL').get() as { v: number | null }; return r.v == null ? null : Number(r.v); }

  verifyAggregates(): { ok: boolean; recordTotal: number; globalTotal: number; details: string[]; invalidRecords: number } {
    const invalidRecords = this.invalidRecordCount();
    const globalTotal = this.globalAggregate()?.total_tokens ?? 0;
    if (invalidRecords > 0) return { ok: false, recordTotal: 0, globalTotal, invalidRecords, details: ['invalid authoritative records'] };
    const expected = this.expectedAggregates();
    const details: string[] = [];
    for (const [table, state] of expected) {
      const keyOf = (row: Record<string, unknown>) => JSON.stringify(state.keys.map((key) => row[key]));
      const actual = new Map((this.statement('SELECT * FROM ' + table).all() as Record<string, unknown>[]).map((row) => [keyOf(row), row]));
      for (const row of state.rows) {
        const key = keyOf(row);
        const found = actual.get(key);
        if (METRIC_COLUMNS.some((field) => Number(found?.[field] ?? 0) !== Number(row[field] ?? 0))) details.push(table + ' mismatch: ' + key);
        actual.delete(key);
      }
      for (const [key, row] of actual) if (METRIC_COLUMNS.some((field) => Number(row[field] ?? 0) !== 0)) details.push(table + ' unexpected row: ' + key);
    }
    const split = this.provenanceSplit();
    const meta = this.readMeta();
    if (meta && (meta.liveRecordedTotal !== split.live || meta.historicalRecoveredTotal !== split.historical || meta.historicalRecoveredRecordCount !== split.historicalCount)) {
      details.push('provenance metadata mismatch');
    }
    return { ok: details.length === 0, recordTotal: Number(expected.get('aggregate_global')!.rows[0].total_tokens), globalTotal, details, invalidRecords };
  }

  readSessionCheckpoint<T>(sessionId: string): T | undefined {
    const row = this.statement('SELECT checkpoint_json FROM session_recovery WHERE session_id=? AND accounting_version=2').get(sessionId) as { checkpoint_json: string } | undefined;
    try { return row ? JSON.parse(row.checkpoint_json) as T : undefined; } catch { return undefined; }
  }

  writeSessionCheckpoint(sessionId: string, checkpoint: unknown): void {
    this.statement('INSERT INTO session_recovery (session_id,accounting_version,checkpoint_json) VALUES (?,2,?) ON CONFLICT(session_id) DO UPDATE SET accounting_version=2,checkpoint_json=excluded.checkpoint_json')
      .run(sessionId, JSON.stringify(checkpoint));
  }

  /** Remembered failed scan attempt for one session at one source revision. */
  readSessionScanFailure(sessionId: string): { revision: string; failureCode: string; attemptedAt: number } | undefined {
    const row = this.statement('SELECT revision,failure_code,attempted_at FROM session_scan_failures WHERE session_id=?')
      .get(sessionId) as { revision: string; failure_code: string; attempted_at: number } | undefined;
    if (!row) return undefined;
    return { revision: String(row.revision), failureCode: String(row.failure_code), attemptedAt: Number(row.attempted_at) };
  }

  writeSessionScanFailure(sessionId: string, revision: string, failureCode: string, attemptedAt: number): void {
    this.statement('INSERT INTO session_scan_failures (session_id,revision,failure_code,attempted_at) VALUES (?,?,?,?) ' +
      'ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision, failure_code=excluded.failure_code, attempted_at=excluded.attempted_at')
      .run(sessionId, revision, failureCode, attemptedAt);
  }

  clearSessionScanFailure(sessionId: string): void {
    this.statement('DELETE FROM session_scan_failures WHERE session_id=?').run(sessionId);
  }

  sessionScanFailureCount(): number {
    return Number((this.statement('SELECT COUNT(*) AS c FROM session_scan_failures').get() as { c: number }).c);
  }

  readSourceDiscoveryCache<T>(): T | undefined {
    const row = this.statement('SELECT cache_json FROM source_discovery_cache WHERE id=1').get() as { cache_json: string } | undefined;
    try { return row ? JSON.parse(row.cache_json) as T : undefined; } catch { return undefined; }
  }

  writeSourceDiscoveryCache(cache: unknown): void {
    this.statement('INSERT INTO source_discovery_cache (id,cache_json) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET cache_json=excluded.cache_json')
      .run(JSON.stringify(cache));
  }

  /** Only a complete, validated session replay may upgrade legacy attempt identities. */
  reconcileSession(sessionId: string, records: readonly UsageRecord[], inheritedIds: readonly string[], lastSeq: number, checkpoint?: unknown): void {
    for (const record of records) {
      assertUsageRecord(record);
      if (record.sessionId !== sessionId || record.accountingVersion !== 2) throw new Error('invalid-session-reconciliation');
    }
    if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error('duplicate-session-reconciliation');
    const readRows = () => this.statement('SELECT * FROM usage_records WHERE session_id=?').all(sessionId) as Record<string, unknown>[];
    let old = readRows();
    if (old.some((row) => row.excluded_reason == null && Number(row.accounting_version) < 2 && Number(row.seq) > lastSeq)) throw new Error('session-snapshot-behind-ledger');
    const ids = new Set(records.map((record) => record.id));
    const inheritedOf = () => {
      if (inheritedIds.length === 0) return new Set<string>();
      const sequenceById = new Map(old.map((row) => [String(row.canonical_id), Number(row.seq)]));
      return new Set(inheritedIds.filter((id) => !ids.has(id) && (sequenceById.get(id) ?? -1) <= lastSeq));
    };
    let inherited = inheritedOf();
    const hasLegacyChanges = () => old.some((row) => row.excluded_reason == null &&
      ((Number(row.accounting_version) < 2 && ids.has(String(row.canonical_id))) || inherited.has(String(row.canonical_id))));
    if (hasLegacyChanges() && !this.accountingBackup) {
      this.accountingBackup = backupDatabaseTo(this.db, this.path + '.pre-accounting-v2-' + randomUUID() + '.bak');
    }
    inTransaction(this.db, () => {
      // Re-read after taking the write lock: another process may have written
      // between the preflight/backup and BEGIN IMMEDIATE.
      old = readRows();
      if (old.some((row) => row.excluded_reason == null && Number(row.accounting_version) < 2 && Number(row.seq) > lastSeq)) throw new Error('session-snapshot-behind-ledger');
      inherited = inheritedOf();
      const legacyChanges = hasLegacyChanges();
      if (legacyChanges && !this.accountingBackup) throw new Error('session-ledger-changed-during-backup');
      const beforeGlobal = this.globalAggregate()?.total_tokens ?? 0;
      const sessionTotal = () => Number((this.statement('SELECT COALESCE(SUM(total_tokens),0) AS s FROM usage_records WHERE session_id=? AND excluded_reason IS NULL').get(sessionId) as { s: number }).s);
      const before = sessionTotal();
      this.apply(records, { reconcile: true });
      for (const row of old) {
        if (row.excluded_reason == null && inherited.has(String(row.canonical_id))) {
          this.subtractContribution(contributionOfRow(row));
          this.statement("UPDATE usage_records SET excluded_reason='fork_inherited', accounting_version=2, updated_at=? WHERE canonical_id=?").run(this.now(), String(row.canonical_id));
        }
      }
      if (inherited.size > 0) {
        const split = this.provenanceSplit();
        this.bumpRecordGeneration(this.now(), { live: split.live, historical: split.historical, historicalCount: split.historicalCount });
      }
      const after = sessionTotal();
      if ((this.globalAggregate()?.total_tokens ?? 0) !== beforeGlobal + after - before) throw new Error('accounting-reconciliation-verification-failed');
      if (legacyChanges) this.statement('INSERT INTO accounting_changes (session_id,accounting_version,before_total,after_total,before_records_json,reason,verified_at) VALUES (?,2,?,?,?,?,?)')
        .run(sessionId, before, after, JSON.stringify(old), 'retry attempts and fork ownership verified from complete session log', this.now());
      if (checkpoint !== undefined) this.writeSessionCheckpoint(sessionId, checkpoint);
    });
  }

  accountingDiagnostics(): { accountingVersion: number; legacyRecordCount: number; accountingAdjustment: number; accountingChangeCount: number } {
    const legacyRecordCount = Number((this.statement('SELECT COUNT(*) AS c FROM usage_records WHERE accounting_version<2 AND excluded_reason IS NULL').get() as { c: number }).c);
    const changes = this.statement('SELECT COUNT(*) AS c,COALESCE(SUM(after_total-before_total),0) AS delta FROM accounting_changes').get() as { c: number; delta: number };
    return { accountingVersion: 2, legacyRecordCount, accountingAdjustment: Number(changes.delta), accountingChangeCount: Number(changes.c) };
  }

  /** Expose the live handle for migration/test integration that must call raw SQL. */
  get database(): DatabaseSync { return this.db; }
  /** Maintenance helper. Migration rollback uses transactions, never deletion. */
  removeRecords(ids: readonly string[]): void {
    if (ids.length === 0) return;
    inTransaction(this.db, () => {
      const del = this.statement('DELETE FROM usage_records WHERE canonical_id=?');
      for (const id of ids) del.run(id);
      this.rebuildAggregates();
    });
  }
  close(): void { if (this.closed) return; this.closed = true; try { this.db.close(); } catch {} }
}

function rowToRecord(r: Record<string, unknown>): UsageRecord {
  return { id: String(r.canonical_id), source: 'assistant/message' as const, sessionId: String(r.session_id),
    turn: Number(r.turn), step: Number(r.step), seq: Number(r.seq), timestamp: Number(r.timestamp),
    localDate: String(r.local_date), provider: r.provider == null ? undefined : String(r.provider),
    model: r.model == null ? undefined : String(r.model), inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens), cacheWriteTokens: Number(r.cache_write_tokens), reasoningTokens: Number(r.reasoning_tokens),
    totalTokens: Number(r.total_tokens), accounting: 'exact' as const, sourceType: (r.source_type as UsageRecord['sourceType']) ?? 'live_event', accountingVersion: Number(r.accounting_version ?? 1) };
}
function upsertSql(): string {
  return `INSERT INTO usage_records (canonical_id, session_id, turn, step, seq, timestamp, local_date, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, unclassified, source_type, historical_or_live, migration_version, created_at, updated_at, schema_version, accounting_version)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(canonical_id) DO UPDATE SET seq=excluded.seq, timestamp=excluded.timestamp, local_date=excluded.local_date, provider=excluded.provider, model=excluded.model,
  input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens, cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens,
  reasoning_tokens=excluded.reasoning_tokens, total_tokens=excluded.total_tokens, unclassified=excluded.unclassified, historical_or_live=excluded.historical_or_live, updated_at=excluded.updated_at, accounting_version=excluded.accounting_version, excluded_reason=NULL`;
}

const METRIC_COLUMNS = ['total_tokens', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'calls', 'unknown_tokens', 'unknown_calls'];

function enrichEqualSequence(old: Record<string, unknown>, incoming: UsageRecord): UsageRecord | undefined {
  if (Number(old.seq) !== incoming.seq || Number(old.total_tokens) !== incoming.totalTokens || old.excluded_reason != null) return undefined;
  const previous = rowToRecord(old);
  const oldUnknown = contributionOfRow(old).isUnknown === 1;
  const newKnown = contributionOf(incoming).isUnknown === 0;
  const enriched: UsageRecord = {
    ...previous,
    ...(oldUnknown && newKnown ? {
      inputTokens: incoming.inputTokens, outputTokens: incoming.outputTokens,
      cacheReadTokens: incoming.cacheReadTokens, cacheWriteTokens: incoming.cacheWriteTokens, reasoningTokens: incoming.reasoningTokens,
    } : {}),
    provider: previous.provider ?? incoming.provider,
    model: previous.model ?? incoming.model,
    ...(isLocalDate(previous.localDate) ? {} : { localDate: incoming.localDate, timestamp: incoming.timestamp }),
  };
  return JSON.stringify(previous) === JSON.stringify(enriched) ? undefined : enriched;
}
