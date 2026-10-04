// src/index.ts
import "node:fs";
import { dirname as dirname3, join as join4 } from "node:path";

// src/usage/durable/durableStore.ts
import "node:sqlite";
import { randomUUID } from "node:crypto";

// src/usage/durable/wrapper.ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// src/usage/durable/schema.ts
var STORAGE_SCHEMA_VERSION = 4;
var SCHEMA_SQL = [
  "CREATE TABLE IF NOT EXISTS usage_records (canonical_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn INTEGER NOT NULL, step INTEGER NOT NULL, seq INTEGER NOT NULL, timestamp INTEGER NOT NULL, local_date TEXT NOT NULL, provider TEXT, model TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL, unclassified INTEGER NOT NULL DEFAULT 0, source_type TEXT, historical_or_live TEXT, migration_version INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, schema_version INTEGER NOT NULL, accounting_version INTEGER NOT NULL DEFAULT 1, excluded_reason TEXT)",
  "CREATE TABLE IF NOT EXISTS aggregate_global (id INTEGER PRIMARY KEY CHECK (id=1), total_tokens INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, calls INTEGER NOT NULL, unknown_tokens INTEGER NOT NULL DEFAULT 0, unknown_calls INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS aggregate_daily (local_date TEXT PRIMARY KEY, total_tokens INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, calls INTEGER NOT NULL, unknown_tokens INTEGER NOT NULL DEFAULT 0, unknown_calls INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS aggregate_model (provider TEXT NOT NULL, model TEXT NOT NULL, total_tokens INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, calls INTEGER NOT NULL, unknown_tokens INTEGER NOT NULL DEFAULT 0, unknown_calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (provider, model))",
  "CREATE TABLE IF NOT EXISTS aggregate_day_model (local_date TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, total_tokens INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY (local_date, provider, model))",
  "CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id=1), storage_schema_version INTEGER NOT NULL, migration_version INTEGER NOT NULL, record_generation INTEGER NOT NULL, aggregate_generation INTEGER NOT NULL, migration_status TEXT NOT NULL, last_aggregate_rebuild INTEGER, earliest_record_at INTEGER, latest_record_at INTEGER, live_recorded_total INTEGER NOT NULL DEFAULT 0, historical_recovered_total INTEGER NOT NULL DEFAULT 0, historical_recovered_record_count INTEGER NOT NULL DEFAULT 0, recovery_json TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_usage_records_date ON usage_records(local_date)",
  "CREATE INDEX IF NOT EXISTS idx_usage_records_provider_model ON usage_records(provider, model)",
  "CREATE INDEX IF NOT EXISTS idx_usage_records_session ON usage_records(session_id)",
  "CREATE TABLE IF NOT EXISTS accounting_changes (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, accounting_version INTEGER NOT NULL, before_total INTEGER NOT NULL, after_total INTEGER NOT NULL, before_records_json TEXT NOT NULL, reason TEXT NOT NULL, verified_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS session_recovery (session_id TEXT PRIMARY KEY, accounting_version INTEGER NOT NULL, checkpoint_json TEXT NOT NULL)",
  // Additive (schema 4): remembered failed scan attempts. Purely a cache — it
  // never holds usage data, and dropping it only costs a full re-read.
  "CREATE TABLE IF NOT EXISTS session_scan_failures (session_id TEXT PRIMARY KEY, revision TEXT NOT NULL, failure_code TEXT NOT NULL, attempted_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS source_discovery_cache (id INTEGER PRIMARY KEY CHECK (id=1), cache_json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS provider_alias_groups (id TEXT PRIMARY KEY, label TEXT NOT NULL, raw_values_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
];

// src/usage/durable/wrapper.ts
var DB_FILE_NAME = "dsh_token_usage_sidebar.sqlite";
function defaultDbPath(env, home = homedir()) {
  const base = env && env.DSH_HOME && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(home, ".dsh");
  return join(base, "storages", DB_FILE_NAME);
}
function ensureDbDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}
function openDatabase(path) {
  const db = new DatabaseSync(path);
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()) {
      const meta = db.prepare("SELECT storage_schema_version FROM meta WHERE id=1").get();
      if (Number(meta?.storage_schema_version ?? 0) > STORAGE_SCHEMA_VERSION) throw new Error("unsupported-storage-schema");
    }
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec("PRAGMA temp_store = MEMORY");
    inTransaction(db, () => {
      for (const sql of SCHEMA_SQL) db.exec(sql);
      const columns = db.prepare("PRAGMA table_info(usage_records)").all();
      if (!columns.some((column) => column.name === "accounting_version")) db.exec("ALTER TABLE usage_records ADD COLUMN accounting_version INTEGER NOT NULL DEFAULT 1");
      if (!columns.some((column) => column.name === "excluded_reason")) db.exec("ALTER TABLE usage_records ADD COLUMN excluded_reason TEXT");
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
var depths = /* @__PURE__ */ new WeakMap();
var savepointNumber = 0;
function inTransaction(db, fn) {
  const depth = depths.get(db) ?? 0;
  const savepoint = "usage_tx_" + ++savepointNumber;
  db.exec(depth === 0 ? "BEGIN IMMEDIATE" : "SAVEPOINT " + savepoint);
  depths.set(db, depth + 1);
  try {
    const out = fn({ exec: (sql) => db.exec(sql), prepare: (sql) => db.prepare(sql) });
    db.exec(depth === 0 ? "COMMIT" : "RELEASE SAVEPOINT " + savepoint);
    return out;
  } catch (error) {
    if (depth === 0) db.exec("ROLLBACK");
    else {
      db.exec("ROLLBACK TO SAVEPOINT " + savepoint);
      db.exec("RELEASE SAVEPOINT " + savepoint);
    }
    throw error;
  } finally {
    depths.set(db, depth);
  }
}
function backupDatabaseTo(src, destPath) {
  src.exec("PRAGMA wal_checkpoint(FULL)");
  src.exec("VACUUM INTO '" + destPath.replaceAll("'", "''") + "'");
  return destPath;
}

// src/usage/validation.ts
function isTokenCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isLocalDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = /* @__PURE__ */ new Date(value + "T12:00:00");
  return Number.isFinite(date.getTime()) && date.getFullYear() === Number(value.slice(0, 4)) && date.getMonth() + 1 === Number(value.slice(5, 7)) && date.getDate() === Number(value.slice(8, 10));
}
function assertUsageRecord(record) {
  if (!record.id || !record.sessionId) throw new Error("invalid-usage-record: identity");
  for (const field of [
    "turn",
    "step",
    "seq",
    "timestamp",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "totalTokens"
  ]) {
    if (!isTokenCount(record[field])) throw new Error("invalid-usage-record: " + field);
  }
  if (!isTokenCount(record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens)) {
    throw new Error("invalid-usage-record: bucket sum");
  }
  if (!isLocalDate(record.localDate) && record.localDate !== "" && record.localDate !== "unclassified") {
    throw new Error("invalid-usage-record: localDate");
  }
  if (record.accountingVersion !== void 0 && (!isTokenCount(record.accountingVersion) || record.accountingVersion < 1)) {
    throw new Error("invalid-usage-record: accountingVersion");
  }
}

// src/usage/durable/durableStore.ts
var BLANK_GLOBAL = { total_tokens: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, calls: 0, unknown_tokens: 0, unknown_calls: 0, updated_at: 0 };
function contributionOf(rec) {
  const sum = rec.inputTokens + rec.outputTokens + rec.cacheReadTokens + rec.cacheWriteTokens;
  const unclassified = sum !== rec.totalTokens;
  return {
    total: rec.totalTokens,
    input: unclassified ? 0 : rec.inputTokens,
    output: unclassified ? 0 : rec.outputTokens,
    cacheRead: unclassified ? 0 : rec.cacheReadTokens,
    cacheWrite: unclassified ? 0 : rec.cacheWriteTokens,
    reasoning: unclassified ? 0 : rec.reasoningTokens,
    isCall: unclassified ? 0 : 1,
    isUnknown: unclassified ? 1 : 0,
    localDate: rec.localDate,
    provider: rec.provider,
    model: rec.model
  };
}
function contributionOfRow(r) {
  if (r.excluded_reason != null) return { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, isCall: 0, isUnknown: 0, localDate: String(r.local_date) };
  const unclassified = Number(r.input_tokens) + Number(r.output_tokens) + Number(r.cache_read_tokens) + Number(r.cache_write_tokens) !== Number(r.total_tokens);
  return {
    total: Number(r.total_tokens),
    input: unclassified ? 0 : Number(r.input_tokens),
    output: unclassified ? 0 : Number(r.output_tokens),
    cacheRead: unclassified ? 0 : Number(r.cache_read_tokens),
    cacheWrite: unclassified ? 0 : Number(r.cache_write_tokens),
    reasoning: unclassified ? 0 : Number(r.reasoning_tokens),
    isCall: unclassified ? 0 : 1,
    isUnknown: unclassified ? 1 : 0,
    localDate: String(r.local_date),
    provider: r.provider == null ? void 0 : String(r.provider),
    model: r.model == null ? void 0 : String(r.model)
  };
}
var DurableStore = class {
  db;
  now;
  closed = false;
  statements = /* @__PURE__ */ new Map();
  path;
  accountingBackup;
  repairedOnOpen;
  constructor(opts) {
    this.path = opts.path;
    this.now = opts.now ?? (() => Date.now());
    this.db = openDatabase(opts.path);
    try {
      this.ensureMeta();
      const verification = this.verifyAggregates();
      if (verification.invalidRecords > 0) throw new Error("invalid-usage-ledger-records");
      this.repairedOnOpen = !verification.ok;
      if (!verification.ok) this.rebuildAggregates();
      else {
        const meta = this.readMeta();
        if (meta.aggregateGeneration !== meta.recordGeneration) this.writeMeta({ ...meta, aggregateGeneration: meta.recordGeneration });
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  get isClosed() {
    return this.closed;
  }
  statement(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  ensureMeta() {
    const row = this.statement("SELECT COUNT(*) AS c FROM meta").get();
    if (Number(row.c) > 0) {
      this.statement("UPDATE meta SET storage_schema_version=? WHERE id=1 AND storage_schema_version<?").run(STORAGE_SCHEMA_VERSION, STORAGE_SCHEMA_VERSION);
      return;
    }
    this.statement(`INSERT INTO meta (id, storage_schema_version, migration_version, record_generation, aggregate_generation, migration_status, last_aggregate_rebuild, earliest_record_at, latest_record_at, live_recorded_total, historical_recovered_total, historical_recovered_record_count, recovery_json)
      VALUES (1,?,?,0,0,'not_started',NULL,NULL,NULL,0,0,0,NULL)`).run(STORAGE_SCHEMA_VERSION, 0);
  }
  readMeta() {
    const row = this.statement("SELECT * FROM meta WHERE id=1").get();
    if (!row) return null;
    return {
      storageSchemaVersion: Number(row.storage_schema_version),
      migrationVersion: Number(row.migration_version),
      recordGeneration: Number(row.record_generation),
      aggregateGeneration: Number(row.aggregate_generation),
      migrationStatus: row.migration_status,
      lastAggregateRebuild: row.last_aggregate_rebuild == null ? null : Number(row.last_aggregate_rebuild),
      earliestRecordAt: row.earliest_record_at == null ? null : Number(row.earliest_record_at),
      latestRecordAt: row.latest_record_at == null ? null : Number(row.latest_record_at),
      liveRecordedTotal: Number(row.live_recorded_total),
      historicalRecoveredTotal: Number(row.historical_recovered_total),
      historicalRecoveredRecordCount: Number(row.historical_recovered_record_count),
      recoveryJson: row.recovery_json == null ? null : String(row.recovery_json)
    };
  }
  writeMeta(m) {
    this.statement(`INSERT INTO meta (id, storage_schema_version, migration_version, record_generation, aggregate_generation, migration_status, last_aggregate_rebuild, earliest_record_at, latest_record_at, live_recorded_total, historical_recovered_total, historical_recovered_record_count, recovery_json)
      VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET storage_schema_version=excluded.storage_schema_version, migration_version=excluded.migration_version,
      record_generation=excluded.record_generation, aggregate_generation=excluded.aggregate_generation, migration_status=excluded.migration_status,
      last_aggregate_rebuild=excluded.last_aggregate_rebuild, earliest_record_at=excluded.earliest_record_at, latest_record_at=excluded.latest_record_at,
      live_recorded_total=excluded.live_recorded_total, historical_recovered_total=excluded.historical_recovered_total,
      historical_recovered_record_count=excluded.historical_recovered_record_count, recovery_json=excluded.recovery_json`).run(
      m.storageSchemaVersion,
      m.migrationVersion,
      m.recordGeneration,
      m.aggregateGeneration,
      m.migrationStatus,
      m.lastAggregateRebuild,
      m.earliestRecordAt,
      m.latestRecordAt,
      m.liveRecordedTotal,
      m.historicalRecoveredTotal,
      m.historicalRecoveredRecordCount,
      m.recoveryJson
    );
  }
  newMeta() {
    return {
      storageSchemaVersion: STORAGE_SCHEMA_VERSION,
      migrationVersion: 0,
      recordGeneration: 0,
      aggregateGeneration: 0,
      migrationStatus: "not_started",
      lastAggregateRebuild: null,
      earliestRecordAt: null,
      latestRecordAt: null,
      liveRecordedTotal: 0,
      historicalRecoveredTotal: 0,
      historicalRecoveredRecordCount: 0,
      recoveryJson: null
    };
  }
  recordCount() {
    return Number(this.statement("SELECT COUNT(*) AS c FROM usage_records WHERE excluded_reason IS NULL").get().c);
  }
  hasRecord(id) {
    return this.statement("SELECT 1 AS x FROM usage_records WHERE canonical_id=?").get(id) !== void 0;
  }
  getRecord(id) {
    return this.statement("SELECT * FROM usage_records WHERE canonical_id=?").get(id);
  }
  listRecords() {
    return this.statement("SELECT * FROM usage_records WHERE excluded_reason IS NULL").all().map(rowToRecord);
  }
  provenanceSplit() {
    const rows = this.statement("SELECT source_type, COUNT(*) AS c, SUM(total_tokens) AS s FROM usage_records WHERE excluded_reason IS NULL GROUP BY source_type").all();
    let live = 0, historical = 0, historicalCount = 0;
    for (const r of rows) {
      const isLive = r.source_type === "live_event" || r.source_type === "other" || r.source_type == null;
      if (isLive) live += Number(r.s);
      else {
        historical += Number(r.s);
        historicalCount += Number(r.c);
      }
    }
    return { live, historical, historicalCount };
  }
  globalAggregate() {
    const g = this.statement("SELECT * FROM aggregate_global WHERE id=1").get();
    return g ? { ...BLANK_GLOBAL, ...g } : null;
  }
  dailyTotals(start, end) {
    return start === void 0 ? this.statement("SELECT * FROM aggregate_daily ORDER BY local_date").all() : this.statement("SELECT * FROM aggregate_daily WHERE local_date BETWEEN ? AND ? ORDER BY local_date").all(start, end ?? start);
  }
  daily(date) {
    return this.statement("SELECT * FROM aggregate_daily WHERE local_date=?").get(date);
  }
  modelTotals() {
    return this.statement("SELECT * FROM aggregate_model").all();
  }
  dayModelTotals(date, end) {
    if (date !== void 0) return this.statement("SELECT * FROM aggregate_day_model WHERE local_date BETWEEN ? AND ?").all(date, end ?? date);
    return this.statement("SELECT * FROM aggregate_day_model").all();
  }
  listProviderAliasGroups() {
    const rows = this.statement("SELECT id, label, raw_values_json FROM provider_alias_groups ORDER BY label COLLATE NOCASE, id").all();
    const groups = [];
    for (const row of rows) {
      try {
        const values = JSON.parse(String(row.raw_values_json));
        if (!Array.isArray(values)) continue;
        const rawValues = [...new Set(values.filter((v) => typeof v === "string" && v.length > 0))];
        const id = String(row.id);
        const label = String(row.label);
        if (id.length === 0 || label.length === 0 || rawValues.length === 0) continue;
        groups.push({ id, label, rawValues });
      } catch {
      }
    }
    return groups;
  }
  upsertProviderAliasGroup(input) {
    const id = input.id?.trim() || "provider-group-" + randomUUID();
    const label = input.label.trim();
    const rawValues = [...new Set(input.rawValues.map((value) => value.trim()).filter((value) => value.length > 0))].sort((a, b) => a.localeCompare(b));
    if (label.length === 0) throw new Error("provider-alias-label-required");
    if (rawValues.length === 0) throw new Error("provider-alias-values-required");
    if (id.length > 160 || label.length > 200 || rawValues.some((value) => value.length > 300)) {
      throw new Error("provider-alias-value-too-long");
    }
    const groups = this.listProviderAliasGroups();
    const conflict = groups.find((group) => group.id !== id && group.rawValues.some((value) => rawValues.includes(value)));
    if (conflict) throw new Error("provider-alias-overlap:" + conflict.label);
    const now = this.now();
    const existing = this.statement("SELECT created_at FROM provider_alias_groups WHERE id=?").get(id);
    const createdAt = existing?.created_at == null ? now : Number(existing.created_at);
    this.statement(`INSERT INTO provider_alias_groups (id, label, raw_values_json, created_at, updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label, raw_values_json=excluded.raw_values_json, updated_at=excluded.updated_at`).run(id, label, JSON.stringify(rawValues), createdAt, now);
    return { id, label, rawValues };
  }
  deleteProviderAliasGroup(id) {
    const result = this.statement("DELETE FROM provider_alias_groups WHERE id=?").run(id);
    return Number(result.changes ?? 0) > 0;
  }
  apply(records, options = {}) {
    const outcome = { added: 0, replaced: 0, ignored: 0 };
    if (records.length === 0) return outcome;
    for (const record of records) assertUsageRecord(record);
    const now = this.now();
    return inTransaction(this.db, () => {
      const meta = this.readMeta() ?? this.newMeta();
      let live = Number(meta.liveRecordedTotal ?? 0);
      let historical = Number(meta.historicalRecoveredTotal ?? 0);
      let historicalCount = Number(meta.historicalRecoveredRecordCount ?? 0);
      const histOrLiveOf = (st) => st === "live_event" || st === "other" || st == null ? "live" : "historical";
      const getRow = this.statement("SELECT * FROM usage_records WHERE canonical_id=?");
      for (let rec of records) {
        const oldRow = getRow.get(rec.id);
        const knownSeq = oldRow === void 0 ? void 0 : Number(oldRow.seq);
        const oldVersion = Number(oldRow?.accounting_version ?? 1);
        const version = rec.accountingVersion ?? 1;
        const upgrade = options.reconcile === true && oldRow !== void 0 && version > oldVersion;
        if (oldRow && version < oldVersion) {
          outcome.ignored += 1;
          continue;
        }
        if (oldRow && !upgrade && (rec.seq <= knownSeq || version > oldVersion)) {
          const enriched = enrichEqualSequence(oldRow, rec);
          if (!enriched) {
            outcome.ignored += 1;
            continue;
          }
          rec = enriched;
        }
        if (!oldRow && version >= 2 && rec.id.includes(":retry:")) {
          const base = getRow.get(rec.sessionId + ":" + rec.turn + ":" + rec.step);
          if (!options.reconcile && base && Number(base.accounting_version) < 2 && rec.seq <= Number(base.seq)) {
            outcome.ignored += 1;
            continue;
          }
        }
        const isNew = oldRow === void 0;
        if (!isNew) this.subtractContribution(contributionOfRow(oldRow));
        const c = contributionOf(rec);
        this.addContribution(c);
        const sourceType2 = rec.sourceType ?? "live_event";
        const histOrLive = histOrLiveOf(sourceType2);
        const oldCreated = oldRow?.created_at;
        const createdAt = isNew ? now : typeof oldCreated === "number" ? oldCreated : now;
        this.statement(upsertSql()).run(
          rec.id,
          rec.sessionId,
          rec.turn,
          rec.step,
          rec.seq,
          rec.timestamp,
          rec.localDate,
          rec.provider ?? null,
          rec.model ?? null,
          rec.inputTokens,
          rec.outputTokens,
          rec.cacheReadTokens,
          rec.cacheWriteTokens,
          rec.reasoningTokens,
          rec.totalTokens,
          c.isUnknown,
          sourceType2,
          String(oldRow?.historical_or_live ?? histOrLive),
          rec.migrationVersion ?? null,
          createdAt,
          now,
          STORAGE_SCHEMA_VERSION,
          rec.accountingVersion ?? 1
        );
        if ((rec.accountingVersion ?? 1) < 2) this.statement("DELETE FROM session_recovery WHERE session_id=?").run(rec.sessionId);
        if (isNew) {
          if (histOrLive === "historical") {
            historical += rec.totalTokens;
            historicalCount += 1;
          } else live += rec.totalTokens;
        } else {
          const bucket = histOrLiveOf(oldRow.source_type);
          const oldTotal = oldRow.excluded_reason == null ? Number(oldRow.total_tokens) : 0;
          const delta = rec.totalTokens - oldTotal;
          if (bucket === "historical") {
            historical += delta;
            if (oldRow.excluded_reason != null) historicalCount += 1;
          } else live += delta;
        }
        if (isNew) outcome.added += 1;
        else outcome.replaced += 1;
      }
      if (outcome.added + outcome.replaced > 0) this.bumpRecordGeneration(now, { live, historical, historicalCount });
      return outcome;
    });
  }
  addContribution(c) {
    if (c.isCall === 0 && c.isUnknown === 0) return;
    const current = this.globalAggregate();
    const additions = {
      total_tokens: c.total,
      input_tokens: c.input,
      output_tokens: c.output,
      cache_read_tokens: c.cacheRead,
      cache_write_tokens: c.cacheWrite,
      reasoning_tokens: c.reasoning,
      calls: c.isCall,
      unknown_tokens: c.isUnknown === 1 ? c.total : 0,
      unknown_calls: c.isUnknown
    };
    if (Object.entries(additions).some(([field, value]) => !Number.isSafeInteger(Number(current?.[field] ?? 0) + value))) {
      throw new Error("invalid-usage-record: aggregate overflow");
    }
    this.statement(`INSERT INTO aggregate_global (id, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls, unknown_tokens, unknown_calls, updated_at)
      VALUES (1,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
      output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
      reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls, unknown_tokens=unknown_tokens+excluded.unknown_tokens,
      unknown_calls=unknown_calls+excluded.unknown_calls, updated_at=excluded.updated_at`).run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.isUnknown === 1 ? c.total : 0, c.isUnknown, this.now());
    if (isLocalDate(c.localDate)) this.statement(`INSERT INTO aggregate_daily (local_date, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls, unknown_tokens, unknown_calls)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(local_date) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
      output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
      reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls, unknown_tokens=unknown_tokens+excluded.unknown_tokens, unknown_calls=unknown_calls+excluded.unknown_calls`).run(c.localDate, c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.isUnknown === 1 ? c.total : 0, c.isUnknown);
    if (c.isUnknown !== 1) {
      this.statement(`INSERT INTO aggregate_model (provider, model, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(provider, model) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
        output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
        reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls`).run(c.provider ?? "Unknown provider", c.model ?? "Unknown model", c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, 1);
      if (isLocalDate(c.localDate)) this.statement(`INSERT INTO aggregate_day_model (local_date, provider, model, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(local_date, provider, model) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
        output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
        reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls`).run(c.localDate, c.provider ?? "Unknown provider", c.model ?? "Unknown model", c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, 1);
    }
  }
  subtractContribution(c) {
    if (c.isCall === 0 && c.isUnknown === 0) return;
    this.statement("UPDATE aggregate_global SET total_tokens=MAX(0,total_tokens-?), input_tokens=MAX(0,input_tokens-?), output_tokens=MAX(0,output_tokens-?), cache_read_tokens=MAX(0,cache_read_tokens-?), cache_write_tokens=MAX(0,cache_write_tokens-?), reasoning_tokens=MAX(0,reasoning_tokens-?), calls=MAX(0,calls-?), unknown_tokens=MAX(0,unknown_tokens-?), unknown_calls=MAX(0,unknown_calls-?), updated_at=? WHERE id=1").run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.isUnknown === 1 ? c.total : 0, c.isUnknown, this.now());
    this.statement("UPDATE aggregate_daily SET total_tokens=MAX(0,total_tokens-?), input_tokens=MAX(0,input_tokens-?), output_tokens=MAX(0,output_tokens-?), cache_read_tokens=MAX(0,cache_read_tokens-?), cache_write_tokens=MAX(0,cache_write_tokens-?), reasoning_tokens=MAX(0,reasoning_tokens-?), calls=MAX(0,calls-?), unknown_tokens=MAX(0,unknown_tokens-?), unknown_calls=MAX(0,unknown_calls-?) WHERE local_date=?").run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.isUnknown === 1 ? c.total : 0, c.isUnknown, c.localDate);
    if (c.isUnknown !== 1) {
      this.statement("UPDATE aggregate_model SET total_tokens=MAX(0,total_tokens-?), input_tokens=MAX(0,input_tokens-?), output_tokens=MAX(0,output_tokens-?), cache_read_tokens=MAX(0,cache_read_tokens-?), cache_write_tokens=MAX(0,cache_write_tokens-?), reasoning_tokens=MAX(0,reasoning_tokens-?), calls=MAX(0,calls-?) WHERE provider=? AND model=?").run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.provider ?? "Unknown provider", c.model ?? "Unknown model");
      this.statement("UPDATE aggregate_day_model SET total_tokens=MAX(0,total_tokens-?), input_tokens=MAX(0,input_tokens-?), output_tokens=MAX(0,output_tokens-?), cache_read_tokens=MAX(0,cache_read_tokens-?), cache_write_tokens=MAX(0,cache_write_tokens-?), reasoning_tokens=MAX(0,reasoning_tokens-?), calls=MAX(0,calls-?) WHERE local_date=? AND provider=? AND model=?").run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.localDate, c.provider ?? "Unknown provider", c.model ?? "Unknown model");
    }
  }
  /** Cheap meta bump: generation, latest timestamp, and the precomputed split. */
  bumpRecordGeneration(now, split) {
    const m = this.readMeta() ?? this.newMeta();
    m.recordGeneration += 1;
    m.aggregateGeneration = m.recordGeneration;
    m.latestRecordAt = now;
    m.liveRecordedTotal = split.live;
    m.historicalRecoveredTotal = split.historical;
    m.historicalRecoveredRecordCount = split.historicalCount;
    this.writeMeta(m);
  }
  expectedAggregates() {
    const known = "(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens = total_tokens)";
    const metrics = [
      "COALESCE(SUM(total_tokens),0) AS total_tokens",
      ...["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"].map((field) => "COALESCE(SUM(CASE WHEN " + known + " THEN " + field + " ELSE 0 END),0) AS " + field),
      "COALESCE(SUM(CASE WHEN " + known + " THEN 1 ELSE 0 END),0) AS calls",
      "COALESCE(SUM(CASE WHEN " + known + " THEN 0 ELSE total_tokens END),0) AS unknown_tokens",
      "COALESCE(SUM(CASE WHEN " + known + " THEN 0 ELSE 1 END),0) AS unknown_calls"
    ].join(",");
    const active = " FROM usage_records WHERE excluded_reason IS NULL";
    const dated = " AND local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";
    const provider = "COALESCE(provider,'Unknown provider')";
    const model = "COALESCE(model,'Unknown model')";
    return /* @__PURE__ */ new Map([
      ["aggregate_global", { keys: ["id"], rows: this.statement("SELECT 1 AS id," + metrics + active).all() }],
      ["aggregate_daily", { keys: ["local_date"], rows: this.statement("SELECT local_date," + metrics + active + dated + " GROUP BY local_date").all() }],
      ["aggregate_model", { keys: ["provider", "model"], rows: this.statement("SELECT " + provider + " AS provider," + model + " AS model," + metrics + active + " AND " + known + " GROUP BY " + provider + "," + model).all() }],
      ["aggregate_day_model", { keys: ["local_date", "provider", "model"], rows: this.statement("SELECT local_date," + provider + " AS provider," + model + " AS model," + metrics + active + dated + " AND " + known + " GROUP BY local_date," + provider + "," + model).all() }]
    ]);
  }
  invalidRecordCount() {
    const numeric = [
      "turn",
      "step",
      "seq",
      "timestamp",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "reasoning_tokens",
      "total_tokens",
      "accounting_version"
    ];
    const invalid = numeric.map((field) => "(typeof(" + field + ")!='integer' OR " + field + "<0 OR " + field + ">9007199254740991)");
    invalid.push(
      "accounting_version<1",
      "input_tokens+output_tokens+cache_read_tokens+cache_write_tokens>9007199254740991",
      "canonical_id='' OR session_id=''",
      "(local_date NOT IN ('','unclassified') AND (date(local_date,'+0 days') IS NULL OR date(local_date,'+0 days')!=local_date))"
    );
    return Number(this.statement("SELECT COUNT(*) AS c FROM usage_records WHERE " + invalid.join(" OR ")).get().c);
  }
  rebuildAggregates() {
    return inTransaction(this.db, () => {
      if (this.invalidRecordCount() > 0) throw new Error("invalid-usage-ledger-records");
      const expected = this.expectedAggregates();
      for (const [table, state] of expected) {
        this.db.exec("DELETE FROM " + table);
        const metrics = table === "aggregate_day_model" ? METRIC_COLUMNS.slice(0, 7) : METRIC_COLUMNS;
        const columns = [...state.keys, ...metrics, ...table === "aggregate_global" ? ["updated_at"] : []];
        const insert = this.statement("INSERT INTO " + table + " (" + columns.join(",") + ") VALUES (" + columns.map(() => "?").join(",") + ")");
        for (const row of state.rows) insert.run(...columns.map((column) => column === "updated_at" ? this.now() : row[column]));
      }
      this.db.exec("UPDATE usage_records SET unclassified=CASE WHEN input_tokens+output_tokens+cache_read_tokens+cache_write_tokens=total_tokens THEN 0 ELSE 1 END");
      const meta = this.readMeta() ?? this.newMeta();
      meta.aggregateGeneration = meta.recordGeneration;
      meta.lastAggregateRebuild = this.now();
      const split = this.provenanceSplit();
      meta.liveRecordedTotal = split.live;
      meta.historicalRecoveredTotal = split.historical;
      meta.historicalRecoveredRecordCount = split.historicalCount;
      this.writeMeta(meta);
      return this.globalAggregate();
    });
  }
  earliestRecordAt() {
    const r = this.statement("SELECT MIN(timestamp) AS v FROM usage_records WHERE excluded_reason IS NULL").get();
    return r.v == null ? null : Number(r.v);
  }
  latestRecordAt() {
    const r = this.statement("SELECT MAX(timestamp) AS v FROM usage_records WHERE excluded_reason IS NULL").get();
    return r.v == null ? null : Number(r.v);
  }
  verifyAggregates() {
    const invalidRecords = this.invalidRecordCount();
    const globalTotal = this.globalAggregate()?.total_tokens ?? 0;
    if (invalidRecords > 0) return { ok: false, recordTotal: 0, globalTotal, invalidRecords, details: ["invalid authoritative records"] };
    const expected = this.expectedAggregates();
    const details = [];
    for (const [table, state] of expected) {
      const keyOf = (row) => JSON.stringify(state.keys.map((key) => row[key]));
      const actual = new Map(this.statement("SELECT * FROM " + table).all().map((row) => [keyOf(row), row]));
      for (const row of state.rows) {
        const key = keyOf(row);
        const found = actual.get(key);
        if (METRIC_COLUMNS.some((field) => Number(found?.[field] ?? 0) !== Number(row[field] ?? 0))) details.push(table + " mismatch: " + key);
        actual.delete(key);
      }
      for (const [key, row] of actual) if (METRIC_COLUMNS.some((field) => Number(row[field] ?? 0) !== 0)) details.push(table + " unexpected row: " + key);
    }
    const split = this.provenanceSplit();
    const meta = this.readMeta();
    if (meta && (meta.liveRecordedTotal !== split.live || meta.historicalRecoveredTotal !== split.historical || meta.historicalRecoveredRecordCount !== split.historicalCount)) {
      details.push("provenance metadata mismatch");
    }
    return { ok: details.length === 0, recordTotal: Number(expected.get("aggregate_global").rows[0].total_tokens), globalTotal, details, invalidRecords };
  }
  readSessionCheckpoint(sessionId) {
    const row = this.statement("SELECT checkpoint_json FROM session_recovery WHERE session_id=? AND accounting_version=2").get(sessionId);
    try {
      return row ? JSON.parse(row.checkpoint_json) : void 0;
    } catch {
      return void 0;
    }
  }
  writeSessionCheckpoint(sessionId, checkpoint) {
    this.statement("INSERT INTO session_recovery (session_id,accounting_version,checkpoint_json) VALUES (?,2,?) ON CONFLICT(session_id) DO UPDATE SET accounting_version=2,checkpoint_json=excluded.checkpoint_json").run(sessionId, JSON.stringify(checkpoint));
  }
  /** Remembered failed scan attempt for one session at one source revision. */
  readSessionScanFailure(sessionId) {
    const row = this.statement("SELECT revision,failure_code,attempted_at FROM session_scan_failures WHERE session_id=?").get(sessionId);
    if (!row) return void 0;
    return { revision: String(row.revision), failureCode: String(row.failure_code), attemptedAt: Number(row.attempted_at) };
  }
  writeSessionScanFailure(sessionId, revision, failureCode, attemptedAt) {
    this.statement("INSERT INTO session_scan_failures (session_id,revision,failure_code,attempted_at) VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision, failure_code=excluded.failure_code, attempted_at=excluded.attempted_at").run(sessionId, revision, failureCode, attemptedAt);
  }
  clearSessionScanFailure(sessionId) {
    this.statement("DELETE FROM session_scan_failures WHERE session_id=?").run(sessionId);
  }
  sessionScanFailureCount() {
    return Number(this.statement("SELECT COUNT(*) AS c FROM session_scan_failures").get().c);
  }
  readSourceDiscoveryCache() {
    const row = this.statement("SELECT cache_json FROM source_discovery_cache WHERE id=1").get();
    try {
      return row ? JSON.parse(row.cache_json) : void 0;
    } catch {
      return void 0;
    }
  }
  writeSourceDiscoveryCache(cache) {
    this.statement("INSERT INTO source_discovery_cache (id,cache_json) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET cache_json=excluded.cache_json").run(JSON.stringify(cache));
  }
  /** Only a complete, validated session replay may upgrade legacy attempt identities. */
  reconcileSession(sessionId, records, inheritedIds, lastSeq, checkpoint) {
    for (const record of records) {
      assertUsageRecord(record);
      if (record.sessionId !== sessionId || record.accountingVersion !== 2) throw new Error("invalid-session-reconciliation");
    }
    if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error("duplicate-session-reconciliation");
    const readRows = () => this.statement("SELECT * FROM usage_records WHERE session_id=?").all(sessionId);
    let old = readRows();
    if (old.some((row) => row.excluded_reason == null && Number(row.accounting_version) < 2 && Number(row.seq) > lastSeq)) throw new Error("session-snapshot-behind-ledger");
    const ids = new Set(records.map((record) => record.id));
    const inheritedOf = () => {
      if (inheritedIds.length === 0) return /* @__PURE__ */ new Set();
      const sequenceById = new Map(old.map((row) => [String(row.canonical_id), Number(row.seq)]));
      return new Set(inheritedIds.filter((id) => !ids.has(id) && (sequenceById.get(id) ?? -1) <= lastSeq));
    };
    let inherited = inheritedOf();
    const hasLegacyChanges = () => old.some((row) => row.excluded_reason == null && (Number(row.accounting_version) < 2 && ids.has(String(row.canonical_id)) || inherited.has(String(row.canonical_id))));
    if (hasLegacyChanges() && !this.accountingBackup) {
      this.accountingBackup = backupDatabaseTo(this.db, this.path + ".pre-accounting-v2-" + randomUUID() + ".bak");
    }
    inTransaction(this.db, () => {
      old = readRows();
      if (old.some((row) => row.excluded_reason == null && Number(row.accounting_version) < 2 && Number(row.seq) > lastSeq)) throw new Error("session-snapshot-behind-ledger");
      inherited = inheritedOf();
      const legacyChanges = hasLegacyChanges();
      if (legacyChanges && !this.accountingBackup) throw new Error("session-ledger-changed-during-backup");
      const beforeGlobal = this.globalAggregate()?.total_tokens ?? 0;
      const sessionTotal = () => Number(this.statement("SELECT COALESCE(SUM(total_tokens),0) AS s FROM usage_records WHERE session_id=? AND excluded_reason IS NULL").get(sessionId).s);
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
      if ((this.globalAggregate()?.total_tokens ?? 0) !== beforeGlobal + after - before) throw new Error("accounting-reconciliation-verification-failed");
      if (legacyChanges) this.statement("INSERT INTO accounting_changes (session_id,accounting_version,before_total,after_total,before_records_json,reason,verified_at) VALUES (?,2,?,?,?,?,?)").run(sessionId, before, after, JSON.stringify(old), "retry attempts and fork ownership verified from complete session log", this.now());
      if (checkpoint !== void 0) this.writeSessionCheckpoint(sessionId, checkpoint);
    });
  }
  accountingDiagnostics() {
    const legacyRecordCount = Number(this.statement("SELECT COUNT(*) AS c FROM usage_records WHERE accounting_version<2 AND excluded_reason IS NULL").get().c);
    const changes = this.statement("SELECT COUNT(*) AS c,COALESCE(SUM(after_total-before_total),0) AS delta FROM accounting_changes").get();
    return { accountingVersion: 2, legacyRecordCount, accountingAdjustment: Number(changes.delta), accountingChangeCount: Number(changes.c) };
  }
  /** Expose the live handle for migration/test integration that must call raw SQL. */
  get database() {
    return this.db;
  }
  /** Maintenance helper. Migration rollback uses transactions, never deletion. */
  removeRecords(ids) {
    if (ids.length === 0) return;
    inTransaction(this.db, () => {
      const del = this.statement("DELETE FROM usage_records WHERE canonical_id=?");
      for (const id of ids) del.run(id);
      this.rebuildAggregates();
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
    }
  }
};
function rowToRecord(r) {
  return {
    id: String(r.canonical_id),
    source: "assistant/message",
    sessionId: String(r.session_id),
    turn: Number(r.turn),
    step: Number(r.step),
    seq: Number(r.seq),
    timestamp: Number(r.timestamp),
    localDate: String(r.local_date),
    provider: r.provider == null ? void 0 : String(r.provider),
    model: r.model == null ? void 0 : String(r.model),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
    cacheWriteTokens: Number(r.cache_write_tokens),
    reasoningTokens: Number(r.reasoning_tokens),
    totalTokens: Number(r.total_tokens),
    accounting: "exact",
    sourceType: r.source_type ?? "live_event",
    accountingVersion: Number(r.accounting_version ?? 1)
  };
}
function upsertSql() {
  return `INSERT INTO usage_records (canonical_id, session_id, turn, step, seq, timestamp, local_date, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, unclassified, source_type, historical_or_live, migration_version, created_at, updated_at, schema_version, accounting_version)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(canonical_id) DO UPDATE SET seq=excluded.seq, timestamp=excluded.timestamp, local_date=excluded.local_date, provider=excluded.provider, model=excluded.model,
  input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens, cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens,
  reasoning_tokens=excluded.reasoning_tokens, total_tokens=excluded.total_tokens, unclassified=excluded.unclassified, historical_or_live=excluded.historical_or_live, updated_at=excluded.updated_at, accounting_version=excluded.accounting_version, excluded_reason=NULL`;
}
var METRIC_COLUMNS = ["total_tokens", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "calls", "unknown_tokens", "unknown_calls"];
function enrichEqualSequence(old, incoming) {
  if (Number(old.seq) !== incoming.seq || Number(old.total_tokens) !== incoming.totalTokens || old.excluded_reason != null) return void 0;
  const previous = rowToRecord(old);
  const oldUnknown = contributionOfRow(old).isUnknown === 1;
  const newKnown = contributionOf(incoming).isUnknown === 0;
  const enriched = {
    ...previous,
    ...oldUnknown && newKnown ? {
      inputTokens: incoming.inputTokens,
      outputTokens: incoming.outputTokens,
      cacheReadTokens: incoming.cacheReadTokens,
      cacheWriteTokens: incoming.cacheWriteTokens,
      reasoningTokens: incoming.reasoningTokens
    } : {},
    provider: previous.provider ?? incoming.provider,
    model: previous.model ?? incoming.model,
    ...isLocalDate(previous.localDate) ? {} : { localDate: incoming.localDate, timestamp: incoming.timestamp }
  };
  return JSON.stringify(previous) === JSON.stringify(enriched) ? void 0 : enriched;
}

// src/usage/ledger.ts
function localDateOf(now) {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}
function localDate(now) {
  return localDateOf(now);
}

// src/usage/durable/durableAggregator.ts
function emptyMetrics() {
  return { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, callCount: 0 };
}
function datesEnding(now, days) {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  const dates = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const cursor = new Date(d);
    cursor.setDate(cursor.getDate() - i);
    dates.push(localDate(cursor.getTime()));
  }
  return dates;
}
function datesForRange(range, now) {
  if (range === "all") return void 0;
  if (range === "today") return datesEnding(now, 1);
  if (range === "yesterday") return [datesEnding(now, 2)[0]];
  return datesEnding(now, 7);
}
function metricsOf(g) {
  return { totalTokens: (g.total_tokens ?? 0) - (g.unknown_tokens ?? 0), inputTokens: g.input_tokens ?? 0, outputTokens: g.output_tokens ?? 0, cacheReadTokens: g.cache_read_tokens ?? 0, cacheWriteTokens: g.cache_write_tokens ?? 0, reasoningTokens: g.reasoning_tokens ?? 0, callCount: g.calls ?? 0 };
}
function metricsOfModel(row) {
  return { totalTokens: row.total_tokens, inputTokens: row.input_tokens, outputTokens: row.output_tokens, cacheReadTokens: row.cache_read_tokens, cacheWriteTokens: row.cache_write_tokens, reasoningTokens: row.reasoning_tokens, callCount: row.calls };
}
function addMetrics(target, source) {
  target.totalTokens += source.totalTokens;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.callCount += source.callCount;
}
function sumModelMetrics(rows) {
  const out = emptyMetrics();
  for (const row of rows) addMetrics(out, metricsOfModel(row));
  return out;
}
function sumCategories(rows) {
  return rows.reduce((acc, d) => ({ totalTokens: acc.totalTokens + d.total_tokens - (d.unknown_tokens ?? 0), inputTokens: acc.inputTokens + d.input_tokens, outputTokens: acc.outputTokens + d.output_tokens, cacheReadTokens: acc.cacheReadTokens + d.cache_read_tokens, cacheWriteTokens: acc.cacheWriteTokens + d.cache_write_tokens, reasoningTokens: acc.reasoningTokens + d.reasoning_tokens, callCount: acc.callCount + d.calls }), emptyMetrics());
}
function dailyToDetails(rows) {
  return rows.map((d) => ({ date: d.local_date, totalTokens: d.total_tokens, inputTokens: d.input_tokens, outputTokens: d.output_tokens, cacheReadTokens: d.cache_read_tokens, cacheWriteTokens: d.cache_write_tokens, reasoningTokens: d.reasoning_tokens, callCount: d.calls, unknownTokens: d.unknown_tokens ?? 0 }));
}
function sortModels(rows) {
  return rows.sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}
function modelDetailsOf(rows, scope, group) {
  const displayProvider = scope?.type === "group" && group ? group.label : void 0;
  const map = /* @__PURE__ */ new Map();
  const breakdowns = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const provider = displayProvider ?? row.provider;
    const key = provider + "\0" + row.model;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        provider,
        model: row.model,
        ...metricsOfModel(row),
        providerScope: scope ?? { type: "raw", value: row.provider },
        ...group ? { rawProviders: [] } : {}
      });
    } else {
      addMetrics(existing, metricsOfModel(row));
    }
    if (group) {
      let byProvider = breakdowns.get(key);
      if (!byProvider) {
        byProvider = /* @__PURE__ */ new Map();
        breakdowns.set(key, byProvider);
      }
      const raw = byProvider.get(row.provider);
      if (raw) addMetrics(raw, metricsOfModel(row));
      else byProvider.set(row.provider, { provider: row.provider, ...metricsOfModel(row) });
    }
  }
  for (const [key, byProvider] of breakdowns) {
    const detail = map.get(key);
    if (detail) detail.rawProviders = [...byProvider.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider));
  }
  return sortModels([...map.values()]);
}
function dailyFromModelRows(rows, dates) {
  const map = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const current = map.get(row.local_date) ?? emptyMetrics();
    addMetrics(current, metricsOfModel(row));
    map.set(row.local_date, current);
  }
  const keys = dates ? [...dates] : [...map.keys()].sort();
  return keys.map((date) => {
    const m = map.get(date) ?? emptyMetrics();
    return { date, ...m, unknownTokens: 0 };
  });
}
function buildFacets(rows, groups) {
  const rawProviders = [...new Set(rows.map((row) => row.provider))].sort((a, b) => a.localeCompare(b));
  const models = [...new Set(rows.map((row) => row.model))].sort((a, b) => a.localeCompare(b));
  const pairMap = /* @__PURE__ */ new Map();
  for (const row of rows) pairMap.set(row.provider + "\0" + row.model, { provider: row.provider, model: row.model });
  const groupOptions = groups.map((group) => ({ type: "group", value: group.id, label: group.label, rawValues: [...group.rawValues] }));
  const rawOptions = rawProviders.map((provider) => ({ type: "raw", value: provider, label: provider, rawValues: [provider] }));
  return {
    providers: [...groupOptions, ...rawOptions],
    models,
    pairs: [...pairMap.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)),
    groups: groups.map((group) => ({ id: group.id, label: group.label, rawValues: [...group.rawValues] }))
  };
}
function selectedProviderValues(scope, groups) {
  if (scope === null) return void 0;
  if (scope.type === "raw") return [scope.value];
  const group = groups.find((candidate) => candidate.id === scope.id);
  if (!group) throw new Error("provider-alias-not-found");
  return group.rawValues;
}
function normalizedFilters(input, groups) {
  const provider = input?.provider ?? null;
  const model = input?.model == null || input.model.length === 0 ? null : input.model;
  const group = provider?.type === "group" ? groups.find((candidate) => candidate.id === provider.id) : void 0;
  if (provider?.type === "group" && !group) throw new Error("provider-alias-not-found");
  const filters = { provider, model };
  return { filters, providerValues: selectedProviderValues(provider, groups), group, active: provider !== null || model !== null };
}
var DurableAggregator = class {
  store;
  now;
  listeners = /* @__PURE__ */ new Set();
  closed = false;
  constructor(store, opts = {}) {
    this.store = store;
    this.now = opts.now ?? (() => Date.now());
  }
  summary() {
    const now = this.now();
    const global = this.store.globalAggregate();
    const todayDate = localDate(now);
    const yesterdayDate = datesEnding(now, 2)[0];
    const today = this.store.daily(todayDate);
    const yesterday = this.store.daily(yesterdayDate);
    return { todayTotal: today?.total_tokens ?? 0, todayDate, yesterdayTotal: yesterday?.total_tokens ?? 0, yesterdayDate, lifetimeTotal: global?.total_tokens ?? 0, recordCount: (global?.calls ?? 0) + (global?.unknown_calls ?? 0), serverNow: todayDate };
  }
  insights(range, inputFilters = {}) {
    const now = this.now();
    const groups = this.store.listProviderAliasGroups();
    const parsed = normalizedFilters(inputFilters, groups);
    const rangeDates = datesForRange(range, now);
    const start = rangeDates?.[0], end = rangeDates?.[rangeDates.length - 1];
    const dayModels = rangeDates || parsed.active ? this.store.dayModelTotals(start, end) : [];
    const rawModels = rangeDates ? mergeDayModelRows(dayModels) : this.store.modelTotals();
    const dailyRows = this.store.dailyTotals(start, end);
    const facets = buildFacets(rawModels, groups);
    if (parsed.active) {
      const matches = (row) => (parsed.providerValues === void 0 || parsed.providerValues.includes(row.provider)) && (parsed.filters.model === null || row.model === parsed.filters.model);
      const selectedModels = rawModels.filter(matches);
      const categories2 = sumModelMetrics(selectedModels);
      const selectedDaily = dayModels.filter(matches);
      const global2 = range === "all" ? this.store.globalAggregate() : void 0;
      const excludedUnclassified = range === "all" ? { tokens: global2?.unknown_tokens ?? 0, calls: global2?.unknown_calls ?? 0 } : dailyRows.reduce((out, row) => ({ tokens: out.tokens + row.unknown_tokens, calls: out.calls + row.unknown_calls }), { tokens: 0, calls: 0 });
      return {
        range,
        ...rangeDates ? { rangeStartDate: rangeDates[0], rangeEndDate: rangeDates[rangeDates.length - 1] } : {},
        totalTokens: categories2.totalTokens,
        categories: categories2,
        unknownTokens: 0,
        unknownCallCount: 0,
        daily: dailyFromModelRows(selectedDaily, rangeDates),
        models: modelDetailsOf(selectedModels, parsed.filters.provider ?? void 0, parsed.group),
        filters: parsed.filters,
        facets,
        excludedUnclassified
      };
    }
    const global = this.store.globalAggregate() ?? {};
    const categories = range === "all" ? metricsOf(global) : sumCategories(dailyRows);
    const unknownTokens = range === "all" ? global.unknown_tokens ?? 0 : dailyRows.reduce((sum, row) => sum + row.unknown_tokens, 0);
    const unknownCallCount = range === "all" ? global.unknown_calls ?? 0 : dailyRows.reduce((sum, row) => sum + row.unknown_calls, 0);
    const byDate = new Map(dailyToDetails(dailyRows).map((row) => [row.date, row]));
    const daily = rangeDates ? rangeDates.map((date) => byDate.get(date) ?? { date, ...emptyMetrics(), unknownTokens: 0 }) : [...byDate.values()];
    return {
      range,
      ...rangeDates ? { rangeStartDate: start, rangeEndDate: end } : {},
      totalTokens: categories.totalTokens + unknownTokens,
      categories,
      unknownTokens,
      unknownCallCount,
      daily,
      models: modelDetailsOf(rawModels),
      filters: parsed.filters,
      facets,
      excludedUnclassified: { tokens: 0, calls: 0 }
    };
  }
  apply(records) {
    if (this.closed) return 0;
    const o = this.store.apply(records);
    if (o.added + o.replaced > 0) this.notify();
    return o.added + o.replaced;
  }
  get ready() {
    return !this.closed;
  }
  rebuildAggregates() {
    this.store.rebuildAggregates();
  }
  verifyAggregates() {
    return this.store.verifyAggregates();
  }
  subscribe(l) {
    this.listeners.add(l);
    try {
      l(this.summary());
    } catch {
    }
    return () => {
      this.listeners.delete(l);
    };
  }
  notify() {
    if (this.listeners.size === 0) return;
    const s = this.summary();
    for (const l of [...this.listeners]) {
      try {
        l(s);
      } catch {
      }
    }
  }
  diagnostics() {
    const meta = this.store.readMeta();
    const global = this.store.globalAggregate();
    const split = this.store.provenanceSplit();
    return { storageBackend: "sqlite", repairedOnOpen: this.store.repairedOnOpen, ...this.store.accountingDiagnostics(), storageSchemaVersion: meta?.storageSchemaVersion, migrationVersion: meta?.migrationVersion, migrationStatus: meta?.migrationStatus, recordGeneration: meta?.recordGeneration, aggregateGeneration: meta?.aggregateGeneration, lastAggregateRebuild: meta?.lastAggregateRebuild ?? void 0, recordCount: this.store.recordCount(), aggregateStatus: this.store.verifyAggregates().ok ? "consistent" : "stale", lifetimeTotal: global?.total_tokens ?? 0, liveRecordedTotal: split.live, historicalRecoveredTotal: split.historical, historicalRecoveredRecordCount: split.historicalCount, providerAliasGroupCount: this.store.listProviderAliasGroups().length, earliestRecordAt: this.store.earliestRecordAt() ?? void 0, latestRecordAt: this.store.latestRecordAt() ?? void 0 };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.store.close();
  }
};
function mergeDayModelRows(rows) {
  const map = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const key = row.provider + "\0" + row.model;
    const current = map.get(key);
    if (!current) map.set(key, { provider: row.provider, model: row.model, total_tokens: row.total_tokens, input_tokens: row.input_tokens, output_tokens: row.output_tokens, cache_read_tokens: row.cache_read_tokens, cache_write_tokens: row.cache_write_tokens, reasoning_tokens: row.reasoning_tokens, calls: row.calls });
    else {
      current.total_tokens += row.total_tokens;
      current.input_tokens += row.input_tokens;
      current.output_tokens += row.output_tokens;
      current.cache_read_tokens += row.cache_read_tokens;
      current.cache_write_tokens += row.cache_write_tokens;
      current.reasoning_tokens += row.reasoning_tokens;
      current.calls += row.calls;
    }
  }
  return [...map.values()];
}

// src/usage/durable/migration.ts
import { copyFileSync, existsSync, mkdirSync as mkdirSync2, readFileSync, constants } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
var V1_MIGRATION_VERSION = 1;
function readV1RootResult(v1Path) {
  if (!existsSync(v1Path)) return { status: "absent" };
  try {
    const document = JSON.parse(readFileSync(v1Path, "utf8"));
    const root = document?.tables?.ledger?.root;
    if (!root || typeof root !== "object" || Array.isArray(root)) return { status: "invalid", message: "invalid v1 ledger root" };
    validateV1(root);
    return { status: "ok", root };
  } catch {
    return { status: "invalid", message: "unreadable or invalid v1 ledger" };
  }
}
function validateV1(v1) {
  if (!v1 || typeof v1 !== "object" || Array.isArray(v1)) throw new Error("invalid v1 ledger root");
  if (v1.byId !== void 0 && (!v1.byId || typeof v1.byId !== "object" || Array.isArray(v1.byId))) throw new Error("invalid v1 byId");
  const records = buildRecordsFromV1(v1);
  for (const record of records) assertUsageRecord(record);
  const total = records.reduce((sum, record) => sum + record.totalTokens, 0);
  if (!isTokenCount(total) || !isTokenCount(v1.lifetimeTotal ?? 0) || total !== (v1.lifetimeTotal ?? 0)) throw new Error("v1 lifetimeTotal mismatch");
  if (!isTokenCount(v1.recordCount ?? records.length) || (v1.recordCount ?? records.length) !== records.length) throw new Error("v1 recordCount mismatch");
  return records;
}
function backupV1Ledger(v1Path, backupDir) {
  if (!v1Path || !existsSync(v1Path)) return void 0;
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const dir = backupDir ?? dirname2(v1Path);
  mkdirSync2(dir, { recursive: true });
  const dest = join2(dir, "dsh_token_usage_sidebar.json.pre-v1.1-" + stamp + "-" + randomUUID2() + ".bak");
  copyFileSync(v1Path, dest, constants.COPYFILE_EXCL);
  return dest;
}
function migrateV1Ledger(dest, opts) {
  const started = Date.now();
  const existing = dest.readMeta();
  const currentTotal = () => dest.globalAggregate()?.total_tokens ?? 0;
  const result = (status, extra = {}) => ({
    migrated: status === "done",
    status,
    sourceFound: false,
    migratedRecords: 0,
    v1LifetimeTotal: 0,
    v11LifetimeTotal: currentTotal(),
    durationMs: Date.now() - started,
    verification: [],
    ...extra
  });
  if (existing.migrationStatus === "done" && existing.migrationVersion >= V1_MIGRATION_VERSION) {
    return result("done", { migrated: false, skippedBecauseDone: true });
  }
  let v1 = opts.v1Root;
  let backupPath;
  let records = [];
  try {
    if (!v1 && opts.v1Path) {
      const read = readV1RootResult(opts.v1Path);
      if (read.status === "absent") return result("not_started");
      if (read.status === "invalid") throw new Error(read.message);
      v1 = read.root;
    }
    if (!v1) return result("not_started");
    records = validateV1(v1);
    backupPath = opts.noBackup ? void 0 : backupV1Ledger(opts.v1Path, opts.backupDir);
    inTransaction(dest.database, () => {
      const before = currentTotal();
      const prior = new Map(records.map((record) => [record.id, dest.getRecord(record.id)]));
      dest.writeMeta({ ...dest.readMeta(), migrationStatus: "in_progress", migrationVersion: V1_MIGRATION_VERSION });
      dest.apply(records);
      dest.rebuildAggregates();
      const failures = verifyV1ToV11(dest, v1, records, { total: before, rows: prior });
      if (failures.length > 0) throw new Error(failures.join("; "));
      dest.writeMeta({
        ...dest.readMeta(),
        migrationStatus: "done",
        migrationVersion: V1_MIGRATION_VERSION,
        earliestRecordAt: dest.earliestRecordAt(),
        latestRecordAt: dest.latestRecordAt(),
        recoveryJson: v1.recovery ? JSON.stringify(v1.recovery) : null
      });
    });
    return result("done", { sourceFound: true, migratedRecords: records.length, v1LifetimeTotal: v1.lifetimeTotal ?? 0, backupPath });
  } catch (error) {
    dest.writeMeta({ ...dest.readMeta(), migrationStatus: "failed" });
    return result("failed", {
      migrated: false,
      sourceFound: !!v1 || !!opts.v1Path,
      v1LifetimeTotal: v1?.lifetimeTotal ?? 0,
      backupPath,
      verification: [String(error.message ?? error)]
    });
  }
}
function buildRecordsFromV1(v1) {
  const byId = v1.byId ?? {};
  const detailBy = v1.detailBy ?? {};
  const dayBy = v1.dayBy ?? {};
  const seqBy = v1.seqBy ?? {};
  const src = v1.src ?? {};
  const ids = Object.keys(byId).sort();
  const out = [];
  for (const id of ids) {
    const total = byId[id];
    const detail = detailBy[id] ?? {};
    const localDate2 = dayBy[id] ?? "unclassified";
    const parts = id.split(":");
    let step = 0, turn = 0, sessionId = id;
    if (parts.length >= 3) {
      step = Number(parts[parts.length - 1]) || 0;
      turn = Number(parts[parts.length - 2]) || 0;
      sessionId = parts.slice(0, parts.length - 2).join(":");
    }
    out.push({
      id,
      source: "assistant/message",
      sessionId,
      turn,
      step,
      seq: seqBy[id] ?? 0,
      timestamp: Date.parse(localDate2 + "T12:00:00") || 0,
      localDate: localDate2,
      provider: detail.provider,
      model: detail.model,
      inputTokens: detail.inputTokens ?? 0,
      outputTokens: detail.outputTokens ?? 0,
      cacheReadTokens: detail.cacheReadTokens ?? 0,
      cacheWriteTokens: detail.cacheWriteTokens ?? 0,
      reasoningTokens: detail.reasoningTokens ?? 0,
      totalTokens: total,
      accounting: "exact",
      sourceType: src[id] ?? "live_event",
      migrationVersion: V1_MIGRATION_VERSION
    });
  }
  return out;
}
function verifyV1ToV11(dest, v1, records, before = { total: 0, rows: /* @__PURE__ */ new Map() }) {
  const failures = [];
  if (records.reduce((sum, record) => sum + record.totalTokens, 0) !== (v1.lifetimeTotal ?? 0)) failures.push("v1 source total mismatch");
  let delta = 0;
  for (const record of records) {
    const previous = before.rows.get(record.id);
    const stored = dest.getRecord(record.id);
    if (!stored) {
      failures.push("missing migrated record");
      continue;
    }
    const previousTotal = previous?.excluded_reason == null ? Number(previous?.total_tokens ?? 0) : 0;
    const storedTotal = stored.excluded_reason == null ? Number(stored.total_tokens) : 0;
    delta += storedTotal - previousTotal;
    if (!previous && (storedTotal !== record.totalTokens || Number(stored.seq) !== record.seq)) failures.push("migrated record mismatch");
    if (previous && (Number(previous.seq) >= record.seq || Number(previous.accounting_version) > 1) && (storedTotal !== previousTotal || Number(stored.seq) !== Number(previous.seq))) failures.push("newer existing record changed");
  }
  if ((dest.globalAggregate()?.total_tokens ?? 0) !== before.total + delta) failures.push("migration union total mismatch");
  failures.push(...dest.verifyAggregates().details);
  return failures;
}

// src/usage/durable/sourceDiscovery.ts
import { createHash } from "node:crypto";
import { readdirSync, readFileSync as readFileSync2, statSync } from "node:fs";
import { join as join3 } from "node:path";
var SOURCE_DISCOVERY_VERSION = 3;
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function finiteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : void 0;
  }
  return void 0;
}
function nonNegativeNumber(value, field, fallback = 0) {
  if (value === void 0) return fallback;
  if (!isTokenCount(value)) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}
function text(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function sourceType(value, fallback) {
  return value === "live_event" || value === "session_log" || value === "provider_record" || value === "legacy_store" || value === "other" ? value : fallback;
}
function localDateFromName(name2) {
  const match = /^dsh_token_usage_day_(\d{4})(\d{2})(\d{2})\.json$/.exec(name2);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : void 0;
}
function splitCanonicalId(id) {
  const parts = id.split(":");
  if (parts.length < 3) return { sessionId: id, turn: 0, step: 0 };
  const step = Number(parts.at(-1));
  const turn = Number(parts.at(-2));
  return {
    sessionId: parts.slice(0, -2).join(":") || id,
    turn: Number.isFinite(turn) ? Math.trunc(turn) : 0,
    step: Number.isFinite(step) ? Math.trunc(step) : 0
  };
}
function totalOf(record) {
  return record.totalTokens;
}
function normalizeRecord(raw, fallbackId, sourcePath, defaultDate) {
  const id = text(raw.id) ?? fallbackId;
  if (id.length === 0) throw new Error("record id is empty");
  const identity = splitCanonicalId(id);
  const localDate2 = text(raw.localDate) ?? defaultDate ?? "unclassified";
  const timestamp = raw.timestamp === void 0 ? void 0 : nonNegativeNumber(raw.timestamp, "timestamp");
  const effectiveTimestamp = timestamp ?? (localDate2 !== "unclassified" ? Date.parse(`${localDate2}T12:00:00`) : 0);
  const totalTokens = nonNegativeNumber(raw.totalTokens, "totalTokens");
  if (!isTokenCount(raw.totalTokens)) throw new Error("totalTokens is missing or invalid");
  const source = raw.source === "assistant/chunk" || raw.source === "assistant/attempt" ? raw.source : "assistant/message";
  return {
    id,
    source,
    sessionId: text(raw.sessionId) ?? identity.sessionId,
    turn: nonNegativeNumber(raw.turn, "turn", identity.turn),
    step: nonNegativeNumber(raw.step, "step", identity.step),
    seq: nonNegativeNumber(raw.seq, "seq"),
    timestamp: Number.isFinite(effectiveTimestamp) ? effectiveTimestamp : 0,
    localDate: localDate2,
    provider: text(raw.provider),
    model: text(raw.model),
    inputTokens: nonNegativeNumber(raw.inputTokens, "inputTokens"),
    outputTokens: nonNegativeNumber(raw.outputTokens, "outputTokens"),
    cacheReadTokens: nonNegativeNumber(raw.cacheReadTokens, "cacheReadTokens"),
    cacheWriteTokens: nonNegativeNumber(raw.cacheWriteTokens, "cacheWriteTokens"),
    reasoningTokens: nonNegativeNumber(raw.reasoningTokens, "reasoningTokens"),
    totalTokens,
    accounting: "exact",
    accountingVersion: raw.accountingVersion === void 0 ? 1 : nonNegativeNumber(raw.accountingVersion, "accountingVersion"),
    sourceType: sourceType(raw.sourceType, "legacy_store"),
    sourcePath,
    migrationVersion: SOURCE_DISCOVERY_VERSION
  };
}
function sumRecords(records) {
  return records.reduce((sum, record) => sum + totalOf(record), 0);
}
function aggregateTotal(value) {
  if (!isObject(value)) return null;
  const fields = ["input", "output", "cacheRead", "cacheWrite"];
  const values = fields.map((field) => finiteNumber(value[field]));
  return values.every((field) => field !== void 0) ? values.reduce((sum, field) => sum + field, 0) : null;
}
function readJson(path) {
  let bytes;
  try {
    bytes = readFileSync2(path);
  } catch (error) {
    return { bytes: Buffer.alloc(0), error: `read failed: ${String(error)}` };
  }
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    return isObject(value) ? { bytes, value } : { bytes, error: "root is not an object" };
  } catch (error) {
    return { bytes, error: "JSON parse failed" };
  }
}
function hashOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function parseRecordTable(table, sourcePath, defaultDate) {
  const records = [];
  const errors = [];
  for (const [key, value] of Object.entries(table)) {
    if (!isObject(value)) {
      errors.push(`${sourcePath}: record ${key} is not an object`);
      continue;
    }
    try {
      const record = normalizeRecord(value, key, sourcePath, defaultDate);
      assertUsageRecord(record);
      records.push(record);
    } catch (error) {
      errors.push(`${sourcePath}: record ${key} invalid: ${String(error)}`);
    }
  }
  return { records, errors };
}
function parseLegacyRoot(root, sourcePath) {
  try {
    const records = buildRecordsFromV1(root).map((record) => ({
      ...record,
      sourcePath
    }));
    for (const record of records) assertUsageRecord(record);
    if (!isTokenCount(root.lifetimeTotal ?? 0) || sumRecords(records) !== (root.lifetimeTotal ?? 0) || !isTokenCount(root.recordCount ?? records.length) || (root.recordCount ?? records.length) !== records.length) throw new Error("legacy root totals mismatch");
    return { records, errors: [] };
  } catch (error) {
    return { records: [], errors: [`${sourcePath}: legacy root invalid: ${String(error)}`] };
  }
}
function sourceSignature(storageDir, options) {
  try {
    const files = readdirSync(storageDir).filter((name2) => name2.startsWith("dsh_token_usage") && name2.endsWith(".json")).sort();
    const fingerprint = files.map((name2) => {
      const stat = statSync(join3(storageDir, name2), { bigint: true });
      return [name2, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    });
    return hashOf(Buffer.from(JSON.stringify([SOURCE_DISCOVERY_VERSION, !!options.includeLegacyRoot, fingerprint])));
  } catch {
    return void 0;
  }
}
function importTokenSources(store, storageDir, options = {}) {
  const signature = sourceSignature(storageDir, options);
  const cached = store.readSourceDiscoveryCache();
  if (signature && !store.repairedOnOpen && cached?.signature === signature && isTokenCount(cached.appliedGeneration) && cached.appliedGeneration <= (store.readMeta()?.recordGeneration ?? 0) && (cached.result?.status === "complete" || cached.result?.status === "none") && Array.isArray(cached.result.sources) && Array.isArray(cached.result.errors) && cached.result.aggregateChecks) {
    return { discovery: { ...cached.result, records: [], cached: true }, applied: 0 };
  }
  const discovery = discoverTokenSources(storageDir, options);
  const applied = inTransaction(store.database, () => {
    const result = store.apply(discovery.records);
    if (signature && signature === sourceSignature(storageDir, options) && (discovery.status === "complete" || discovery.status === "none")) {
      store.writeSourceDiscoveryCache({
        signature,
        appliedGeneration: store.readMeta()?.recordGeneration ?? 0,
        result: { ...discovery, records: [] }
      });
    }
    return result.added + result.replaced;
  });
  return { discovery, applied };
}
function bestRecords(records, errors) {
  const best = /* @__PURE__ */ new Map();
  for (const record of records) {
    const existing = best.get(record.id);
    if (existing === void 0 || record.seq > existing.seq) {
      best.set(record.id, record);
    } else if (record.seq === existing.seq && record.totalTokens !== existing.totalTokens) {
      errors.push(`duplicate canonical id ${record.id} has conflicting equal-seq totals; kept ${existing.sourcePath ?? "first source"}`);
    }
  }
  return [...best.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function discoverTokenSources(storageDir, options = {}) {
  const includeLegacyRoot = options.includeLegacyRoot ?? false;
  const sources = [];
  const errors = [];
  const candidates = [];
  try {
    candidates.push(...readdirSync(storageDir).filter((name2) => name2.startsWith("dsh_token_usage") && name2.endsWith(".json")).sort());
  } catch (error) {
    return {
      storageDir,
      status: "failed",
      records: [],
      sources: [],
      errors: [`${storageDir}: directory scan failed: ${String(error)}`],
      aggregateChecks: { expectedTotal: null, expectedRecordCount: null, discoveredTotal: 0, discoveredRecordCount: 0 }
    };
  }
  const rawRecords = [];
  let expectedTotal = null;
  let expectedRecordCount = null;
  for (const name2 of candidates) {
    const path = join3(storageDir, name2);
    const loaded = readJson(path);
    const sha256 = hashOf(loaded.bytes);
    if (loaded.error || loaded.value === void 0) {
      errors.push(`${path}: ${loaded.error ?? "unreadable"}`);
      continue;
    }
    const tables = loaded.value.tables;
    const recordsTable = isObject(tables) && isObject(tables.records) ? tables.records : void 0;
    const ledgerRoot = isObject(tables) && isObject(tables.ledger) && isObject(tables.ledger.root) ? tables.ledger.root : void 0;
    const metaRoot = isObject(tables) && isObject(tables.meta) && isObject(tables.meta.root) ? tables.meta.root : void 0;
    const date = localDateFromName(name2);
    if (recordsTable !== void 0) {
      const parsed = parseRecordTable(recordsTable, path, date);
      rawRecords.push(...parsed.records);
      errors.push(...parsed.errors);
      sources.push({ path, format: "record-table", sha256, recordCount: parsed.records.length, totalTokens: sumRecords(parsed.records), imported: true });
      continue;
    }
    if (ledgerRoot !== void 0) {
      const parsed = parseLegacyRoot(ledgerRoot, path);
      if (includeLegacyRoot) rawRecords.push(...parsed.records);
      errors.push(...parsed.errors);
      sources.push({ path, format: "legacy-root", sha256, recordCount: parsed.records.length, totalTokens: sumRecords(parsed.records), imported: includeLegacyRoot });
      continue;
    }
    const aggregate = metaRoot && isObject(metaRoot.aggregate) ? metaRoot.aggregate : void 0;
    const global = aggregate && isObject(aggregate.global) ? aggregate.global : void 0;
    if (aggregate !== void 0 && global !== void 0) {
      const total = aggregateTotal(global);
      const count = finiteNumber(global.recordCount) ?? finiteNumber(global.calls) ?? null;
      if (total !== null) expectedTotal = total;
      if (count !== null) expectedRecordCount = count;
      sources.push({ path, format: "aggregate-summary", sha256, recordCount: count ?? 0, totalTokens: total ?? 0, imported: false });
      continue;
    }
    errors.push(`${path}: no recognized token-record table`);
  }
  const records = bestRecords(rawRecords, errors);
  const discoveredTotal = sumRecords(records);
  if (expectedTotal !== null && expectedTotal !== discoveredTotal) {
    errors.push(`aggregate total mismatch: expected=${expectedTotal} discovered=${discoveredTotal}`);
  }
  if (expectedRecordCount !== null && expectedRecordCount !== records.length) {
    errors.push(`aggregate record-count mismatch: expected=${expectedRecordCount} discovered=${records.length}`);
  }
  let status;
  if (candidates.length === 0) status = "none";
  else if (sources.length === 0) status = "failed";
  else if (errors.length > 0) status = "partial";
  else status = "complete";
  return {
    storageDir,
    status,
    records,
    sources,
    errors,
    aggregateChecks: { expectedTotal, expectedRecordCount, discoveredTotal, discoveredRecordCount: records.length }
  };
}

// src/usage/types.ts
function totalOf2(b) {
  return b.inputTokens + (b.cacheReadTokens ?? 0) + (b.cacheWriteTokens ?? 0) + b.outputTokens;
}
function currentLocalDate(now = Date.now()) {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
var EMPTY_AGGREGATE = Object.freeze({
  lifetimeTotal: 0,
  todayTotal: 0,
  todayDate: currentLocalDate(),
  recordCount: 0
});

// src/usage/collector.ts
var ACCOUNTING_VERSION = 2;
function bucketsOf(data) {
  const usage = data?.usage;
  if (!usage || typeof usage !== "object") return void 0;
  const fields = usage;
  if (!isTokenCount(fields.inputTokens) || !isTokenCount(fields.outputTokens)) return void 0;
  for (const key of ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"]) {
    if (fields[key] !== void 0 && !isTokenCount(fields[key])) return void 0;
  }
  const buckets = {
    inputTokens: fields.inputTokens,
    outputTokens: fields.outputTokens,
    cacheReadTokens: fields.cacheReadTokens,
    cacheWriteTokens: fields.cacheWriteTokens,
    reasoningTokens: fields.reasoningTokens
  };
  return isTokenCount(totalOf2(buckets)) ? buckets : void 0;
}
function modelSourceOf(data) {
  const message = data?.message;
  const source = message && typeof message === "object" ? message.source : void 0;
  if (!source || typeof source !== "object") return {};
  const value = source;
  return {
    provider: typeof value.provider === "string" && value.provider.length > 0 ? value.provider : void 0,
    model: typeof value.model === "string" && value.model.length > 0 ? value.model : void 0
  };
}
function streamUsage(data) {
  if (!Array.isArray(data.stream)) return void 0;
  for (let i = data.stream.length - 1; i >= 0; i -= 1) {
    const record = data.stream[i];
    if (record?.type === "chunk" && record.chunk?.type === "usage") return record.chunk;
  }
  return void 0;
}
var SessionUsageCollector = class {
  retrySlots = /* @__PURE__ */ new Map();
  lastSeq = -1;
  activeStep;
  input;
  constructor(input, checkpoint) {
    this.input = input;
    if (checkpoint) {
      this.lastSeq = checkpoint.lastSeq;
      this.activeStep = checkpoint.activeStep;
      if (checkpoint.activeStep?.retrySeq !== void 0) {
        this.retrySlots.set(checkpoint.activeStep.turn + ":" + checkpoint.activeStep.step, checkpoint.activeStep.retrySeq);
      }
    }
  }
  checkpoint() {
    return { lastSeq: this.lastSeq, activeStep: this.activeStep };
  }
  collect(events, sourceType2 = this.input.sourceType) {
    const best = /* @__PURE__ */ new Map();
    for (const event of events) {
      if (!isTokenCount(event.seq) || event.seq <= this.lastSeq) continue;
      this.lastSeq = event.seq;
      if (event.seq < (this.input.inheritedEventCount ?? 0)) continue;
      const data = event.data ?? {};
      if (event.type === "llm/retry-started") {
        if (isTokenCount(data.turn) && isTokenCount(data.step)) {
          const slot2 = data.turn + ":" + data.step;
          this.retrySlots.set(slot2, event.seq);
          this.activeStep = { turn: data.turn, step: data.step, retrySeq: event.seq };
        }
        continue;
      }
      if (event.type !== "assistant/message" && event.type !== "assistant/attempt" && event.type !== "assistant/chunk") continue;
      const sample = event.type === "assistant/chunk" ? data.chunk : data.usage !== void 0 ? data : streamUsage(data);
      if (event.type === "assistant/chunk" && sample?.type !== "usage") continue;
      if (!sample || sample.usage === void 0) continue;
      const usage = bucketsOf(sample);
      const ts = data.timestamp ?? data.createdAt ?? event.time ?? this.input.now ?? Date.now();
      if (!usage || !isTokenCount(data.turn) || !isTokenCount(data.step) || !isTokenCount(ts) || !isLocalDate(currentLocalDate(ts)) || !this.input.sessionId) {
        this.input.onInvalidUsage?.();
        continue;
      }
      const { turn, step } = data;
      const slot = turn + ":" + step;
      const retrySeq = this.retrySlots.get(slot);
      this.activeStep = { turn, step, ...retrySeq === void 0 ? {} : { retrySeq } };
      const source = modelSourceOf(data);
      const id = this.input.sessionId + ":" + slot + (retrySeq === void 0 ? "" : ":retry:" + retrySeq);
      best.set(id, {
        id,
        sessionId: this.input.sessionId,
        turn,
        step,
        seq: event.seq,
        timestamp: ts,
        localDate: currentLocalDate(ts),
        source: event.type,
        provider: source.provider ?? this.input.provider,
        model: source.model ?? this.input.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        reasoningTokens: usage.reasoningTokens ?? 0,
        totalTokens: totalOf2(usage),
        accounting: "exact",
        sourceType: sourceType2,
        sourcePath: this.input.sourcePath,
        migrationVersion: this.input.migrationVersion,
        accountingVersion: ACCOUNTING_VERSION
      });
    }
    return [...best.values()];
  }
};
function collectSessionUsage(input) {
  const collector = new SessionUsageCollector(input);
  return collector.collect([...input.events].sort((a, b) => a.seq - b.seq));
}

// src/usage/durable/sessionRecovery.ts
import { createHash as createHash2 } from "node:crypto";
var SESSION_SCAN_RETRY_TTL_MS = 24 * 60 * 60 * 1e3;
var hashEvent = (event) => createHash2("sha256").update(JSON.stringify(event)).digest("hex");
function scanFingerprint(revision, sizeBytes, backend) {
  if (revision !== void 0) {
    const historical = backend === "session-persistence-jsonl" ? /^(\d+:\d+:(\d+):\d+:\d+):[a-f0-9]{64}$/.exec(revision) : null;
    if (historical && isTokenCount(sizeBytes) && Number(historical[2]) === sizeBytes) {
      return "historical-file:" + historical[1];
    }
    return "revision:" + revision;
  }
  return isTokenCount(sizeBytes) ? "size:" + sizeBytes : void 0;
}
function rememberedFingerprint(value, sizeBytes, backend) {
  return value.startsWith("revision:") ? scanFingerprint(value.slice("revision:".length), sizeBytes, backend) : value;
}
var SAFE_ERRORS = /* @__PURE__ */ new Set([
  "invalid-session-descriptor",
  "invalid-session-read",
  "invalid-session-handle",
  "unsupported-session-persistence",
  "session-recovery-checkpoint-conflict",
  "non-contiguous-session-log",
  "invalid-session-usage-or-fork-cut",
  "fork-ownership-unavailable",
  "invalid-fork-inherited-cut",
  "invalid-session-event-order",
  "session-snapshot-behind-ledger",
  "invalid-session-usage"
]);
function validCheckpoint(value) {
  if (!value || !isTokenCount(value.offset) || !isTokenCount(value.inheritedEventCount) || value.inheritedEventCount > value.offset || !value.collector || value.collector.lastSeq !== value.offset - 1) return false;
  if (value.offset > 0 && !/^[a-f0-9]{64}$/.test(value.lastEventHash ?? "")) return false;
  if (value.revision !== void 0 && (typeof value.revision !== "string" || value.revision.length === 0)) return false;
  const step = value.collector.activeStep;
  return !step || isTokenCount(step.turn) && isTokenCount(step.step) && (step.retrySeq === void 0 || isTokenCount(step.retrySeq) && step.retrySeq < value.offset);
}
function inheritedCut(header, provided, events) {
  if (provided !== void 0) {
    if (!isTokenCount(provided)) throw new Error("invalid-fork-inherited-cut");
    return provided;
  }
  if (!header?.isSeeded && !header?.parentSession) return 0;
  const marker = [...events].reverse().find((event) => event.type === "session/end-seed" && event.data?.inherited === true);
  if (!marker) throw new Error("fork-ownership-unavailable");
  return marker.seq;
}
function inheritedUsageIds(sessionId, events, cut) {
  const records = collectSessionUsage({ sessionId, events: events.filter((event) => event.seq < cut), sourceType: "session_log" });
  return [...new Set(records.flatMap((record) => [record.id, sessionId + ":" + record.turn + ":" + record.step]))];
}
function snapshotLiveSession(session, onInvalidUsage) {
  if (!session.id) throw new Error("invalid-live-session");
  const events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : session.events;
  if (!Array.isArray(events)) throw new Error("session-events-unavailable");
  let previous = -1;
  for (const event of events) {
    if (!isTokenCount(event.seq) || event.seq !== previous + 1) throw new Error("non-contiguous-session-log");
    previous = event.seq;
  }
  const cut = inheritedCut(session.header, session.inheritedEventCount, events);
  if (cut > previous + 1) throw new Error("fork-cut-outside-session");
  let invalid = 0;
  const collector = new SessionUsageCollector({
    sessionId: session.id,
    inheritedEventCount: cut,
    sourceType: "session_log",
    onInvalidUsage: () => {
      invalid += 1;
      onInvalidUsage?.();
    }
  });
  const records = collector.collect(events);
  if (invalid > 0) throw new Error("invalid-session-usage");
  return { collector, records, inheritedIds: inheritedUsageIds(session.id, events, cut), lastSeq: previous };
}
async function recoverPersistedSessions(store, persistence, signal, options = {}) {
  const now = options.now ?? (() => Date.now());
  const retryTtlMs = options.retryTtlMs ?? SESSION_SCAN_RETRY_TTL_MS;
  const startedAt = now();
  const result = {
    sourceScanStatus: "unknown",
    sessionsDiscovered: 0,
    sessionsReadSuccessfully: 0,
    sessionsReadFailed: 0,
    sessionsSkippedUnchanged: 0,
    sessionsSkippedKnownUnreadable: 0,
    invalidUsageEvents: 0,
    errors: [],
    listMs: 0,
    durationMs: 0
  };
  if (!persistence) {
    result.durationMs = now() - startedAt;
    return result;
  }
  let snapshots;
  try {
    const listStartedAt = now();
    snapshots = persistence.open ? await persistence.list({ signal }) : persistence.listSnapshots ? await persistence.listSnapshots(signal) : await persistence.list(signal);
    result.listMs = now() - listStartedAt;
    if (!Array.isArray(snapshots)) throw new Error("invalid-session-list");
  } catch {
    if (signal.aborted) {
      result.durationMs = now() - startedAt;
      return result;
    }
    result.sourceScanStatus = "failed";
    result.errors.push("session-list-failed");
    result.durationMs = now() - startedAt;
    return result;
  }
  result.sessionsDiscovered = snapshots.length;
  for (const snapshot of snapshots) {
    if (signal.aborted) break;
    let id;
    let fingerprint;
    try {
      if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("invalid-session-descriptor");
      const value = snapshot;
      const sourceId = value.header?.id ?? value.id;
      if (typeof sourceId !== "string" || sourceId.length === 0) throw new Error("invalid-session-descriptor");
      id = sourceId;
      const revision = typeof value.revision === "string" && value.revision.length > 0 ? value.revision : void 0;
      fingerprint = scanFingerprint(revision, value.sizeBytes, persistence.name);
      const remembered = store.readSessionScanFailure(id);
      const saved = store.readSessionCheckpoint(id);
      if (!store.repairedOnOpen && validCheckpoint(saved) && revision !== void 0 && saved.revision === revision) {
        if (remembered) store.clearSessionScanFailure(id);
        result.sessionsSkippedUnchanged += 1;
        result.sessionsReadSuccessfully += 1;
        await new Promise((resolve) => setImmediate(resolve));
        continue;
      }
      const age = remembered ? now() - remembered.attemptedAt : -1;
      if (!store.repairedOnOpen && remembered && fingerprint !== void 0 && rememberedFingerprint(remembered.revision, value.sizeBytes, persistence.name) === fingerprint && age >= 0 && age < retryTtlMs) {
        result.sessionsSkippedKnownUnreadable += 1;
        result.sessionsReadFailed += 1;
        result.errors.push(SAFE_ERRORS.has(remembered.failureCode) ? remembered.failureCode : "session-read-failed");
        await new Promise((resolve) => setImmediate(resolve));
        continue;
      }
      if (persistence.open) {
        if (await recoverV2(store, persistence, id, signal, () => {
          result.invalidUsageEvents += 1;
        }, revision)) result.sessionsSkippedUnchanged += 1;
      } else if (persistence.readFrom) {
        if (await recoverV1(store, persistence, id, signal, () => {
          result.invalidUsageEvents += 1;
        }, revision)) result.sessionsSkippedUnchanged += 1;
      } else throw new Error("unsupported-session-persistence");
      result.sessionsReadSuccessfully += 1;
      if (remembered) store.clearSessionScanFailure(id);
    } catch (error) {
      if (signal.aborted) break;
      result.sessionsReadFailed += 1;
      const message = error instanceof Error ? error.message : "";
      const code = SAFE_ERRORS.has(message) ? message : "session-read-failed";
      result.errors.push(code);
      if (id !== void 0 && fingerprint !== void 0) {
        try {
          store.writeSessionScanFailure(id, fingerprint, code, now());
        } catch {
        }
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  result.sourceScanStatus = result.sessionsReadFailed > 0 ? result.sessionsReadSuccessfully > 0 ? "partial" : "failed" : signal.aborted ? "partial" : "complete";
  result.durationMs = now() - startedAt;
  return result;
}
async function recoverV1(store, persistence, id, signal, onInvalidUsage, revision) {
  const saved = store.readSessionCheckpoint(id);
  const checkpoint = !store.repairedOnOpen && validCheckpoint(saved) ? saved : void 0;
  const from = checkpoint ? Math.max(0, checkpoint.offset - 1) : 0;
  const read = await persistence.readFrom(id, from, signal);
  if (signal.aborted) throw new Error("session-recovery-aborted");
  if (read.meta.id !== id || !Array.isArray(read.events)) throw new Error("invalid-session-read");
  for (let i = 0; i < read.events.length; i += 1) if (read.events[i].seq !== from + i) throw new Error("non-contiguous-session-log");
  if (checkpoint && checkpoint.offset > 0 && (read.events.length === 0 || hashEvent(read.events[0]) !== checkpoint.lastEventHash)) throw new Error("session-recovery-checkpoint-conflict");
  const events = checkpoint && checkpoint.offset > 0 ? read.events.slice(1) : read.events;
  const cut = checkpoint?.inheritedEventCount ?? inheritedCut(read.meta, void 0, events);
  let invalid = 0;
  const collector = new SessionUsageCollector({
    sessionId: id,
    sourceType: "session_log",
    inheritedEventCount: cut,
    onInvalidUsage: () => {
      invalid += 1;
      onInvalidUsage();
    }
  }, checkpoint?.collector);
  const records = collector.collect(events);
  const offset = (checkpoint?.offset ?? 0) + events.length;
  if (invalid > 0 || cut > offset) throw new Error("invalid-session-usage-or-fork-cut");
  const next = {
    offset,
    inheritedEventCount: cut,
    collector: collector.checkpoint(),
    revision,
    lastEventHash: events.length > 0 ? hashEvent(events[events.length - 1]) : checkpoint?.lastEventHash
  };
  if (checkpoint) commitIncremental(store, id, checkpoint, records, next);
  else store.reconcileSession(id, records, inheritedUsageIds(id, events, cut), offset - 1, next);
  return checkpoint !== void 0 && events.length === 0;
}
async function recoverV2(store, persistence, id, signal, onInvalidUsage, revision) {
  const handle = await persistence.open(id, "read", { signal });
  try {
    if (handle.header.id !== id || typeof handle.read !== "function" || typeof handle.close !== "function") throw new Error("invalid-session-handle");
    const cut = inheritedCut(handle.header, handle.inheritedEventCount, []);
    const saved = store.readSessionCheckpoint(id);
    const checkpoint = !store.repairedOnOpen && validCheckpoint(saved) ? saved : void 0;
    if (checkpoint && checkpoint.inheritedEventCount !== cut) throw new Error("session-recovery-checkpoint-conflict");
    if (checkpoint && checkpoint.offset > 0) {
      const marker = (await handle.read(checkpoint.offset - 1, 1, { signal })).events;
      if (marker.length !== 1 || hashEvent(marker[0]) !== checkpoint.lastEventHash) throw new Error("session-recovery-checkpoint-conflict");
    }
    let invalid = 0;
    const collector = new SessionUsageCollector({
      sessionId: id,
      sourceType: "session_log",
      inheritedEventCount: cut,
      onInvalidUsage: () => {
        invalid += 1;
        onInvalidUsage();
      }
    }, checkpoint?.collector);
    const records = /* @__PURE__ */ new Map();
    const inherited = /* @__PURE__ */ new Set();
    const inheritedCollector = new SessionUsageCollector({ sessionId: id, sourceType: "session_log" });
    let offset = checkpoint?.offset ?? 0;
    const initialOffset = offset;
    let lastEventHash = checkpoint?.lastEventHash;
    while (!signal.aborted) {
      const events = (await handle.read(offset, 512, { signal })).events;
      if (!Array.isArray(events)) throw new Error("invalid-session-read");
      if (events.length === 0) break;
      for (let i = 0; i < events.length; i += 1) if (events[i].seq !== offset + i) throw new Error("non-contiguous-session-log");
      for (const record of collector.collect(events)) records.set(record.id, record);
      if (!checkpoint) for (const record of inheritedCollector.collect(events.filter((event) => event.seq < cut))) {
        inherited.add(record.id);
        inherited.add(id + ":" + record.turn + ":" + record.step);
      }
      offset += events.length;
      lastEventHash = hashEvent(events[events.length - 1]);
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (signal.aborted) throw new Error("session-recovery-aborted");
    if (invalid > 0 || cut > offset) throw new Error("invalid-session-usage-or-fork-cut");
    const next = { offset, inheritedEventCount: cut, lastEventHash, collector: collector.checkpoint(), revision };
    if (checkpoint) commitIncremental(store, id, checkpoint, [...records.values()], next);
    else store.reconcileSession(id, [...records.values()], [...inherited], offset - 1, next);
    return checkpoint !== void 0 && initialOffset === offset;
  } finally {
    await handle.close();
  }
}
function commitIncremental(store, id, previous, records, next) {
  inTransaction(store.database, () => {
    if (JSON.stringify(store.readSessionCheckpoint(id)) !== JSON.stringify(previous)) throw new Error("session-recovery-checkpoint-conflict");
    store.apply(records);
    store.writeSessionCheckpoint(id, next);
  });
}

// src/index.ts
var name = "dsh-token-usage-sidebar";
var inject = ["webServer", "sessions", "webRuntime", "sessionPersistence"];
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
function parseAuthority(authority) {
  try {
    return new URL("http://" + authority);
  } catch {
    return void 0;
  }
}
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== "" ? entryUrl.port : new URL("https://" + entry).port;
  return port === "" ? entryUrl.hostname : entryUrl.hostname + ":" + port;
}
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === void 0) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
  });
}
function isTrustedApiRequest(request, trustedHosts) {
  const raw = request.headers["host"];
  const host = typeof raw === "string" ? raw : void 0;
  if (host === void 0) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === void 0) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers["origin"];
  if (origin === void 0) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}
function writeJson(res, status, body) {
  if (typeof res.statusCode === "number") res.statusCode = status;
  if (typeof res.setHeader === "function") res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 65536) throw new Error("request-body-too-large");
    chunks.push(bytes);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request-body-invalid-json");
  }
}
function insightRangeOf(body) {
  const range = body && typeof body === "object" ? body.range : void 0;
  return range === "today" || range === "yesterday" || range === "7d" || range === "all" ? range : void 0;
}
function usageFiltersOf(body) {
  if (body === null || typeof body !== "object") return { ok: true, value: {} };
  const raw = body.filters;
  if (raw === void 0 || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object") return { ok: false, message: "filters must be an object" };
  const record = raw;
  let provider = null;
  if (record.provider !== void 0 && record.provider !== null) {
    if (typeof record.provider !== "object") return { ok: false, message: "filters.provider must be an object or null" };
    const scope = record.provider;
    if (scope.type === "raw" && typeof scope.value === "string" && scope.value.length > 0) {
      provider = { type: "raw", value: scope.value };
    } else if (scope.type === "group" && typeof scope.id === "string" && scope.id.length > 0) {
      provider = { type: "group", id: scope.id };
    } else {
      return { ok: false, message: "filters.provider must be a raw or group scope" };
    }
  }
  let model = null;
  if (record.model !== void 0 && record.model !== null) {
    if (typeof record.model !== "string") return { ok: false, message: "filters.model must be a string or null" };
    model = record.model.length > 0 ? record.model : null;
  }
  return { ok: true, value: { provider, model } };
}
function aliasRequestOf(body) {
  if (body === null || typeof body !== "object") return { ok: true, action: "list" };
  const record = body;
  const action = record.action;
  if (action === void 0 || action === "list") return { ok: true, action: "list" };
  if (action === "delete") {
    return typeof record.id === "string" && record.id.length > 0 ? { ok: true, action: "delete", id: record.id } : { ok: false, message: "alias id is required" };
  }
  if (action !== "upsert") return { ok: false, message: "alias action must be list, upsert, or delete" };
  if (record.group === null || typeof record.group !== "object") return { ok: false, message: "alias group is required" };
  const group = record.group;
  const id = group.id === void 0 ? void 0 : group.id;
  if (id !== void 0 && typeof id !== "string") return { ok: false, message: "alias group id must be a string" };
  if (typeof group.label !== "string") return { ok: false, message: "alias group label is required" };
  if (!Array.isArray(group.rawValues) || !group.rawValues.every((value) => typeof value === "string")) {
    return { ok: false, message: "alias group rawValues must be an array of strings" };
  }
  return { ok: true, action: "upsert", group: { id, label: group.label, rawValues: group.rawValues } };
}
function isClientValidationError(error) {
  const message = String(error?.message ?? error);
  return message.startsWith("provider-alias-") || message.startsWith("alias ") || message.startsWith("filters.") || message.startsWith("request-body-");
}
function v1LedgerPath(dbPath) {
  return join4(dirname3(dbPath), "dsh_token_usage_sidebar.json");
}
function apply(ctx) {
  const host = ctx;
  ctx.effect(() => {
    const abort = new AbortController();
    let disposed = false;
    let store;
    let aggregator;
    let phase = "loading";
    let failureCode;
    let sourceDiscovery;
    let sourceDiscoveryApplied = 0;
    let migration;
    let recovery;
    let scanInProgress = false;
    let liveDiscovered = 0, liveRead = 0, liveListFailed = false, invalidUsageEvents = 0;
    let accounting = { accountingVersion: 2, legacyRecordCount: 0, accountingAdjustment: 0, accountingChangeCount: 0 };
    let updatedAt = Date.now();
    const collectors = /* @__PURE__ */ new Map();
    const incompleteSessions = /* @__PURE__ */ new Set();
    const liveFailures = /* @__PURE__ */ new Set();
    const liveFailed = () => liveFailures.size + (liveListFailed ? 1 : 0);
    const disposers = [];
    const health = () => {
      const global = store?.globalAggregate();
      const scan = recovery?.sourceScanStatus ?? (phase === "loading" ? "unknown" : liveFailed() > 0 ? liveRead > 0 ? "partial" : "failed" : "unknown");
      const partial = scan !== "complete" || liveFailed() > 0 || invalidUsageEvents > 0 || accounting.legacyRecordCount > 0 || sourceDiscovery?.status === "partial" || sourceDiscovery?.status === "failed";
      return {
        status: phase === "ready" && partial ? "partial" : phase,
        sourceScanStatus: liveFailed() > 0 && scan === "complete" ? "partial" : scan,
        historicalCoverage: (global?.calls ?? 0) + (global?.unknown_calls ?? 0) > 0 ? "partial" : "unknown",
        sessionsDiscovered: recovery?.sessionsDiscovered ?? liveDiscovered,
        sessionsReadSuccessfully: recovery?.sessionsReadSuccessfully ?? liveRead,
        sessionsReadFailed: (recovery?.sessionsReadFailed ?? 0) + liveFailed(),
        invalidUsageEvents: invalidUsageEvents + (recovery?.invalidUsageEvents ?? 0),
        ...accounting,
        scanInProgress,
        updatedAt
      };
    };
    const trustedHosts = () => Array.isArray(host.webRuntime?.trustedHosts) ? host.webRuntime.trustedHosts : [];
    const routeDisposer = host.webServer.register({
      kind: "prefix",
      path: "/token-usage/api",
      handler: async (req, res) => {
        if (!isTrustedApiRequest(req, trustedHosts())) {
          writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
          return;
        }
        if (req.method !== "POST") {
          writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } });
          return;
        }
        const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
        const method = pathname.startsWith("/token-usage/api/") ? pathname.slice("/token-usage/api/".length) : void 0;
        if (!method || method.includes("/") || !["summary", "details", "aliases", "debug"].includes(method)) {
          writeJson(res, 404, { ok: false, error: { code: "not-found", message: "unknown method" } });
          return;
        }
        try {
          const body = await readJsonBody(req);
          if (method === "debug") {
            writeJson(res, 200, { ok: true, value: {
              ...aggregator ? aggregator.diagnostics() : { storageBackend: "unavailable" },
              health: health(),
              failureCode,
              migrationStatus: migration?.status ?? store?.readMeta()?.migrationStatus,
              ...health(),
              sourceDiscovery: sourceDiscovery ? {
                status: sourceDiscovery.status,
                sourceCount: sourceDiscovery.sources.length,
                importedRecordCount: sourceDiscovery.aggregateChecks.discoveredRecordCount,
                appliedRecordCount: sourceDiscoveryApplied,
                cached: sourceDiscovery.cached ?? false,
                errors: sourceDiscovery.errors,
                aggregateChecks: sourceDiscovery.aggregateChecks,
                sources: sourceDiscovery.sources.map((item) => ({
                  format: item.format,
                  sha256: item.sha256,
                  recordCount: item.recordCount,
                  totalTokens: item.totalTokens,
                  imported: item.imported
                }))
              } : void 0,
              sessionRecovery: recovery,
              sessionPersistenceBackend: host.sessionPersistence?.name,
              scanFailuresRemembered: store?.sessionScanFailureCount()
            } });
            return;
          }
          const currentStore = store, currentAggregator = aggregator;
          if (!currentStore || !currentAggregator || phase === "loading" || phase === "failed") {
            writeJson(res, 503, { ok: false, health: health(), error: {
              code: phase === "loading" ? "initializing" : "recovery-failed",
              message: phase === "loading" ? "Usage recovery is in progress." : "Usage recovery failed. Existing ledger files are preserved."
            } });
            return;
          }
          if (method === "summary") {
            writeJson(res, 200, { ok: true, value: { ...currentAggregator.summary(), health: health() } });
          } else if (method === "details") {
            const range = insightRangeOf(body);
            const filters = usageFiltersOf(body);
            if (!range || !filters.ok) {
              writeJson(res, 400, { ok: false, error: { code: "validation-error", message: !range ? "invalid range" : !filters.ok ? filters.message : "" } });
              return;
            }
            writeJson(res, 200, { ok: true, value: { ...currentAggregator.insights(range, filters.value), health: health() } });
          } else if (method === "aliases") {
            const request = aliasRequestOf(body);
            if (!request.ok) {
              writeJson(res, 400, { ok: false, error: { code: "validation-error", message: request.message } });
              return;
            }
            if (request.action === "upsert") currentStore.upsertProviderAliasGroup(request.group);
            if (request.action === "delete") currentStore.deleteProviderAliasGroup(request.id);
            writeJson(res, 200, { ok: true, value: { groups: currentStore.listProviderAliasGroups() } });
          }
        } catch (error) {
          const message = String(error.message ?? error);
          writeJson(
            res,
            message === "request-body-too-large" ? 413 : isClientValidationError(error) ? 400 : 500,
            { ok: false, error: {
              code: isClientValidationError(error) ? "validation-error" : "internal",
              message: isClientValidationError(error) ? message : "Usage request failed."
            } }
          );
        }
      }
    });
    if (typeof routeDisposer === "function") disposers.push(routeDisposer);
    const invalid = () => {
      invalidUsageEvents += 1;
    };
    const allowKnownUsage = () => {
      if (failureCode !== "history-unavailable") return;
      const global = store?.globalAggregate();
      if ((global?.calls ?? 0) + (global?.unknown_calls ?? 0) > 0) {
        failureCode = void 0;
        phase = "ready";
      }
    };
    const capture = (session, liveSeq) => {
      const replay = snapshotLiveSession(session, invalid);
      const records = liveSeq === void 0 ? replay.records : replay.records.map((record) => record.seq === liveSeq ? { ...record, sourceType: "live_event" } : record);
      store.reconcileSession(session.id, records, replay.inheritedIds, replay.lastSeq);
      collectors.set(session.id, replay.collector);
      incompleteSessions.delete(session.id);
      liveFailures.delete(session.id);
      accounting = store.accountingDiagnostics();
      return replay.collector;
    };
    const listen = (event, handler) => {
      const disposer = host.on(event, handler);
      if (typeof disposer === "function") disposers.push(disposer);
    };
    async function initialize() {
      try {
        const dbPath = defaultDbPath({ DSH_HOME: process.env.DSH_HOME });
        ensureDbDir(dbPath);
        store = new DurableStore({ path: dbPath });
        aggregator = new DurableAggregator(store);
        const v1Path = v1LedgerPath(dbPath);
        if (store.readMeta()?.migrationStatus !== "done") {
          const read = readV1RootResult(v1Path);
          if (read.status !== "absent") {
            migration = migrateV1Ledger(store, { v1Path, v1Root: read.status === "ok" ? read.root : void 0, backupDir: dirname3(v1Path) });
            if (migration.status === "failed") failureCode = "v1-migration-failed";
          }
        }
        if (failureCode) sourceDiscovery = discoverTokenSources(dirname3(dbPath));
        else {
          const imported = importTokenSources(store, dirname3(dbPath), { includeLegacyRoot: store.readMeta()?.migrationStatus === "done" });
          sourceDiscovery = imported.discovery;
          sourceDiscoveryApplied = imported.applied;
        }
        let sessions = [];
        try {
          sessions = [...host.sessions.list()];
          liveDiscovered = sessions.length;
        } catch {
          liveListFailed = true;
        }
        for (const session of sessions) {
          try {
            capture(session);
            liveRead += 1;
          } catch {
            liveFailures.add(session.id);
            incompleteSessions.add(session.id);
          }
        }
        listen("session/created", (session) => {
          if (disposed) return;
          try {
            capture(session);
            allowKnownUsage();
            updatedAt = Date.now();
          } catch {
            liveFailures.add(session.id);
            incompleteSessions.add(session.id);
          }
        });
        listen("session/event", (session, event) => {
          if (disposed) return;
          try {
            let collector = collectors.get(session.id);
            if (!collector || incompleteSessions.has(session.id)) {
              try {
                collector = capture(session, event.seq);
              } catch {
                liveFailures.add(session.id);
                incompleteSessions.add(session.id);
                if (session.inheritedEventCount === void 0 && (session.header?.isSeeded || session.header?.parentSession)) return;
                collector ??= new SessionUsageCollector({ sessionId: session.id, inheritedEventCount: session.inheritedEventCount, onInvalidUsage: invalid });
                collectors.set(session.id, collector);
              }
            }
            const records = collector.collect([event], "live_event");
            aggregator.apply(incompleteSessions.has(session.id) ? records.map((record) => ({ ...record, accountingVersion: 1 })) : records);
            if (incompleteSessions.has(session.id)) accounting = store.accountingDiagnostics();
            allowKnownUsage();
            updatedAt = Date.now();
          } catch {
            phase = "failed";
            failureCode = "live-write-failed";
          }
        });
        listen("session/disposed", (session) => {
          collectors.delete(session.id);
        });
        accounting = store.accountingDiagnostics();
        const global = store.globalAggregate();
        const usable = (global?.calls ?? 0) + (global?.unknown_calls ?? 0) > 0;
        if (!failureCode && usable) {
          phase = "ready";
          scanInProgress = true;
          updatedAt = Date.now();
          void finishRecovery();
          return;
        }
        recovery = await recoverPersistedSessions(store, host.sessionPersistence, abort.signal);
        if (disposed) return;
        accounting = store.accountingDiagnostics();
        const verification = store.verifyAggregates();
        if (!verification.ok) {
          phase = "failed";
          failureCode = "aggregate-verification-failed";
          return;
        }
        const count = (store.globalAggregate()?.calls ?? 0) + (store.globalAggregate()?.unknown_calls ?? 0);
        if (!failureCode && count === 0 && (recovery.sourceScanStatus === "failed" || liveFailed() > 0 || sourceDiscovery.status === "failed")) failureCode = "history-unavailable";
        phase = failureCode ? "failed" : "ready";
        updatedAt = Date.now();
      } catch {
        if (disposed) return;
        phase = "failed";
        failureCode = "initialization-failed";
        host.logger?.warn?.("[dsh-token-usage-sidebar] initialization failed; ledger files preserved");
      }
    }
    async function finishRecovery() {
      try {
        recovery = await recoverPersistedSessions(store, host.sessionPersistence, abort.signal);
        if (disposed) return;
        accounting = store.accountingDiagnostics();
        if (!store.verifyAggregates().ok) {
          failureCode = "aggregate-verification-failed";
          phase = "failed";
          return;
        }
        updatedAt = Date.now();
      } catch {
        if (!disposed) failureCode = failureCode ?? "background-recovery-failed";
      } finally {
        scanInProgress = false;
      }
    }
    void initialize();
    return () => {
      disposed = true;
      abort.abort();
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
        }
      }
      collectors.clear();
      incompleteSessions.clear();
      liveFailures.clear();
      if (aggregator) aggregator.close();
      else store?.close();
    };
  }, "dsh-token-usage-sidebar: host");
}
export {
  apply,
  inject,
  name
};
