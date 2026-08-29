// src/index.ts
import { existsSync as existsSync2 } from "node:fs";
import { dirname as dirname3, join as join3 } from "node:path";

// src/usage/durable/durableStore.ts
import "node:sqlite";
import { randomUUID } from "node:crypto";

// src/usage/durable/wrapper.ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// src/usage/durable/schema.ts
var STORAGE_SCHEMA_VERSION = 2;
var SCHEMA_SQL = [
  "CREATE TABLE IF NOT EXISTS usage_records (canonical_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn INTEGER NOT NULL, step INTEGER NOT NULL, seq INTEGER NOT NULL, timestamp INTEGER NOT NULL, local_date TEXT NOT NULL, provider TEXT, model TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL, unclassified INTEGER NOT NULL DEFAULT 0, source_type TEXT, historical_or_live TEXT, migration_version INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, schema_version INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS aggregate_global (id INTEGER PRIMARY KEY CHECK (id=1), total_tokens INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, calls INTEGER NOT NULL, unknown_tokens INTEGER NOT NULL DEFAULT 0, unknown_calls INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS aggregate_daily (local_date TEXT PRIMARY KEY, total_tokens INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, calls INTEGER NOT NULL, unknown_tokens INTEGER NOT NULL DEFAULT 0, unknown_calls INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS aggregate_model (provider TEXT NOT NULL, model TEXT NOT NULL, total_tokens INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, calls INTEGER NOT NULL, unknown_tokens INTEGER NOT NULL DEFAULT 0, unknown_calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (provider, model))",
  "CREATE TABLE IF NOT EXISTS aggregate_day_model (local_date TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, total_tokens INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY (local_date, provider, model))",
  "CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id=1), storage_schema_version INTEGER NOT NULL, migration_version INTEGER NOT NULL, record_generation INTEGER NOT NULL, aggregate_generation INTEGER NOT NULL, migration_status TEXT NOT NULL, last_aggregate_rebuild INTEGER, earliest_record_at INTEGER, latest_record_at INTEGER, live_recorded_total INTEGER NOT NULL DEFAULT 0, historical_recovered_total INTEGER NOT NULL DEFAULT 0, historical_recovered_record_count INTEGER NOT NULL DEFAULT 0, recovery_json TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_usage_records_date ON usage_records(local_date)",
  "CREATE INDEX IF NOT EXISTS idx_usage_records_provider_model ON usage_records(provider, model)",
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
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec("PRAGMA temp_store = MEMORY");
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}
function inTransaction(db, fn) {
  db.exec("BEGIN");
  try {
    const out = fn({ exec: (sql) => db.exec(sql), prepare: (sql) => db.prepare(sql) });
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
    }
    throw e;
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
  const unclassified = Number(r.unclassified) === 1;
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
  constructor(opts) {
    this.now = opts.now ?? (() => Date.now());
    this.db = openDatabase(opts.path);
    this.ensureMeta();
  }
  get isClosed() {
    return this.closed;
  }
  ensureMeta() {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM meta").get();
    if (Number(row.c) > 0) {
      this.db.prepare("UPDATE meta SET storage_schema_version=? WHERE id=1 AND storage_schema_version<?").run(STORAGE_SCHEMA_VERSION, STORAGE_SCHEMA_VERSION);
      return;
    }
    this.db.prepare(`INSERT INTO meta (id, storage_schema_version, migration_version, record_generation, aggregate_generation, migration_status, last_aggregate_rebuild, earliest_record_at, latest_record_at, live_recorded_total, historical_recovered_total, historical_recovered_record_count, recovery_json)
      VALUES (1,?,?,0,0,'not_started',NULL,NULL,NULL,0,0,0,NULL)`).run(STORAGE_SCHEMA_VERSION, 0);
  }
  readMeta() {
    const row = this.db.prepare("SELECT * FROM meta WHERE id=1").get();
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
    this.db.prepare(`INSERT INTO meta (id, storage_schema_version, migration_version, record_generation, aggregate_generation, migration_status, last_aggregate_rebuild, earliest_record_at, latest_record_at, live_recorded_total, historical_recovered_total, historical_recovered_record_count, recovery_json)
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
    return Number(this.db.prepare("SELECT COUNT(*) AS c FROM usage_records").get().c);
  }
  hasRecord(id) {
    return this.db.prepare("SELECT 1 AS x FROM usage_records WHERE canonical_id=?").get(id) !== void 0;
  }
  getRecord(id) {
    return this.db.prepare("SELECT * FROM usage_records WHERE canonical_id=?").get(id);
  }
  listRecords() {
    return this.db.prepare("SELECT * FROM usage_records").all().map(rowToRecord);
  }
  provenanceSplit() {
    const rows = this.db.prepare("SELECT source_type, COUNT(*) AS c, SUM(total_tokens) AS s FROM usage_records GROUP BY source_type").all();
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
    const g = this.db.prepare("SELECT * FROM aggregate_global WHERE id=1").get();
    return g ? { ...BLANK_GLOBAL, ...g } : null;
  }
  dailyTotals() {
    return this.db.prepare("SELECT * FROM aggregate_daily").all();
  }
  daily(date) {
    return this.db.prepare("SELECT * FROM aggregate_daily WHERE local_date=?").get(date);
  }
  modelTotals() {
    return this.db.prepare("SELECT * FROM aggregate_model").all();
  }
  dayModelTotals(date) {
    if (date !== void 0) return this.db.prepare("SELECT * FROM aggregate_day_model WHERE local_date=?").all(date);
    return this.db.prepare("SELECT * FROM aggregate_day_model").all();
  }
  listProviderAliasGroups() {
    const rows = this.db.prepare("SELECT id, label, raw_values_json FROM provider_alias_groups ORDER BY label COLLATE NOCASE, id").all();
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
    const existing = this.db.prepare("SELECT created_at FROM provider_alias_groups WHERE id=?").get(id);
    const createdAt = existing?.created_at == null ? now : Number(existing.created_at);
    this.db.prepare(`INSERT INTO provider_alias_groups (id, label, raw_values_json, created_at, updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label, raw_values_json=excluded.raw_values_json, updated_at=excluded.updated_at`).run(id, label, JSON.stringify(rawValues), createdAt, now);
    return { id, label, rawValues };
  }
  deleteProviderAliasGroup(id) {
    const result = this.db.prepare("DELETE FROM provider_alias_groups WHERE id=?").run(id);
    return Number(result.changes ?? 0) > 0;
  }
  apply(records) {
    const outcome = { added: 0, replaced: 0, ignored: 0 };
    if (records.length === 0) return outcome;
    const now = this.now();
    return inTransaction(this.db, () => {
      const meta = this.readMeta() ?? this.newMeta();
      let live = Number(meta.liveRecordedTotal ?? 0);
      let historical = Number(meta.historicalRecoveredTotal ?? 0);
      let historicalCount = Number(meta.historicalRecoveredRecordCount ?? 0);
      const histOrLiveOf = (st) => st === "live_event" || st === "other" || st == null ? "live" : "historical";
      const getRow = this.db.prepare("SELECT * FROM usage_records WHERE canonical_id=?");
      for (const rec of records) {
        const oldRow = getRow.get(rec.id);
        const knownSeq = oldRow === void 0 ? void 0 : Number(oldRow.seq);
        if (knownSeq !== void 0 && rec.seq <= knownSeq) {
          outcome.ignored += 1;
          continue;
        }
        const isNew = oldRow === void 0;
        if (!isNew) this.subtractContribution(contributionOfRow(oldRow));
        const c = contributionOf(rec);
        this.addContribution(c);
        const sourceType = rec.sourceType ?? "live_event";
        const histOrLive = histOrLiveOf(sourceType);
        const oldCreated = oldRow?.created_at;
        const createdAt = isNew ? now : typeof oldCreated === "number" ? oldCreated : now;
        this.db.prepare(upsertSql()).run(
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
          sourceType,
          histOrLive,
          rec.migrationVersion ?? null,
          createdAt,
          now,
          STORAGE_SCHEMA_VERSION
        );
        if (isNew) {
          if (histOrLive === "historical") {
            historical += rec.totalTokens;
            historicalCount += 1;
          } else live += rec.totalTokens;
        } else {
          const bucket = histOrLiveOf(oldRow.source_type);
          const oldTotal = Number(oldRow.total_tokens);
          const delta = rec.totalTokens - oldTotal;
          if (bucket === "historical") historical += delta;
          else live += delta;
        }
        if (isNew) outcome.added += 1;
        else outcome.replaced += 1;
      }
      this.bumpRecordGeneration(now, { live, historical, historicalCount });
      return outcome;
    });
  }
  addContribution(c) {
    this.db.prepare(`INSERT INTO aggregate_global (id, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls, unknown_tokens, unknown_calls, updated_at)
      VALUES (1,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
      output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
      reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls, unknown_tokens=unknown_tokens+excluded.unknown_tokens,
      unknown_calls=unknown_calls+excluded.unknown_calls, updated_at=excluded.updated_at`).run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.isUnknown === 1 ? c.total : 0, c.isUnknown, this.now());
    this.db.prepare(`INSERT INTO aggregate_daily (local_date, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls, unknown_tokens, unknown_calls)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(local_date) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
      output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
      reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls, unknown_tokens=unknown_tokens+excluded.unknown_tokens, unknown_calls=unknown_calls+excluded.unknown_calls`).run(c.localDate, c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.isUnknown === 1 ? c.total : 0, c.isUnknown);
    if (c.isUnknown !== 1) {
      this.db.prepare(`INSERT INTO aggregate_model (provider, model, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(provider, model) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
        output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
        reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls`).run(c.provider ?? "Unknown provider", c.model ?? "Unknown model", c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, 1);
      this.db.prepare(`INSERT INTO aggregate_day_model (local_date, provider, model, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(local_date, provider, model) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
        output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
        reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls`).run(c.localDate, c.provider ?? "Unknown provider", c.model ?? "Unknown model", c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, 1);
    }
  }
  subtractContribution(c) {
    this.db.prepare("UPDATE aggregate_global SET total_tokens=MAX(0,total_tokens-?), input_tokens=MAX(0,input_tokens-?), output_tokens=MAX(0,output_tokens-?), cache_read_tokens=MAX(0,cache_read_tokens-?), cache_write_tokens=MAX(0,cache_write_tokens-?), reasoning_tokens=MAX(0,reasoning_tokens-?), calls=MAX(0,calls-?), unknown_tokens=MAX(0,unknown_tokens-?), unknown_calls=MAX(0,unknown_calls-?), updated_at=? WHERE id=1").run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.isUnknown === 1 ? c.total : 0, c.isUnknown, this.now());
    this.db.prepare("UPDATE aggregate_daily SET total_tokens=MAX(0,total_tokens-?), input_tokens=MAX(0,input_tokens-?), output_tokens=MAX(0,output_tokens-?), cache_read_tokens=MAX(0,cache_read_tokens-?), cache_write_tokens=MAX(0,cache_write_tokens-?), reasoning_tokens=MAX(0,reasoning_tokens-?), calls=MAX(0,calls-?), unknown_tokens=MAX(0,unknown_tokens-?), unknown_calls=MAX(0,unknown_calls-?) WHERE local_date=?").run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.isUnknown === 1 ? c.total : 0, c.isUnknown, c.localDate);
    if (c.isUnknown !== 1) {
      this.db.prepare("UPDATE aggregate_model SET total_tokens=MAX(0,total_tokens-?), input_tokens=MAX(0,input_tokens-?), output_tokens=MAX(0,output_tokens-?), cache_read_tokens=MAX(0,cache_read_tokens-?), cache_write_tokens=MAX(0,cache_write_tokens-?), reasoning_tokens=MAX(0,reasoning_tokens-?), calls=MAX(0,calls-?) WHERE provider=? AND model=?").run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.provider ?? "Unknown provider", c.model ?? "Unknown model");
      this.db.prepare("UPDATE aggregate_day_model SET total_tokens=MAX(0,total_tokens-?), input_tokens=MAX(0,input_tokens-?), output_tokens=MAX(0,output_tokens-?), cache_read_tokens=MAX(0,cache_read_tokens-?), cache_write_tokens=MAX(0,cache_write_tokens-?), reasoning_tokens=MAX(0,reasoning_tokens-?), calls=MAX(0,calls-?) WHERE local_date=? AND provider=? AND model=?").run(c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall, c.localDate, c.provider ?? "Unknown provider", c.model ?? "Unknown model");
    }
  }
  /** Cheap meta bump: generation, latest timestamp, and the precomputed split. */
  bumpRecordGeneration(now, split) {
    const m = this.readMeta() ?? this.newMeta();
    m.recordGeneration += 1;
    m.latestRecordAt = now;
    m.liveRecordedTotal = split.live;
    m.historicalRecoveredTotal = split.historical;
    m.historicalRecoveredRecordCount = split.historicalCount;
    this.writeMeta(m);
  }
  rebuildAggregates() {
    return inTransaction(this.db, () => {
      this.db.exec("DELETE FROM aggregate_global");
      this.db.exec("DELETE FROM aggregate_daily");
      this.db.exec("DELETE FROM aggregate_model");
      this.db.exec("DELETE FROM aggregate_day_model");
      const rows = this.db.prepare("SELECT * FROM usage_records").all();
      const global = { ...BLANK_GLOBAL };
      for (const raw of rows) {
        const c = contributionOfRow(raw);
        global.total_tokens += c.total;
        if (c.isUnknown === 1) {
          global.unknown_tokens += c.total;
          global.unknown_calls += c.isUnknown;
          continue;
        }
        global.input_tokens += c.input;
        global.output_tokens += c.output;
        global.cache_read_tokens += c.cacheRead;
        global.cache_write_tokens += c.cacheWrite;
        global.reasoning_tokens += c.reasoning;
        global.calls += c.isCall;
        this.db.prepare(`INSERT INTO aggregate_daily (local_date, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(local_date) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
          output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
          reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls`).run(c.localDate, c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, c.isCall);
        this.db.prepare(`INSERT INTO aggregate_model (provider, model, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(provider, model) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
          output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
          reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls`).run(c.provider ?? "Unknown provider", c.model ?? "Unknown model", c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, 1);
        this.db.prepare(`INSERT INTO aggregate_day_model (local_date, provider, model, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls)
          VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(local_date, provider, model) DO UPDATE SET total_tokens=total_tokens+excluded.total_tokens, input_tokens=input_tokens+excluded.input_tokens,
          output_tokens=output_tokens+excluded.output_tokens, cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
          reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, calls=calls+excluded.calls`).run(c.localDate, c.provider ?? "Unknown provider", c.model ?? "Unknown model", c.total, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning, 1);
      }
      const now = this.now();
      this.db.prepare(`INSERT INTO aggregate_global (id, total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, calls, unknown_tokens, unknown_calls, updated_at)
        VALUES (1,?,?,?,?,?,?,?,?,?,?)`).run(global.total_tokens, global.input_tokens, global.output_tokens, global.cache_read_tokens, global.cache_write_tokens, global.reasoning_tokens, global.calls, global.unknown_tokens, global.unknown_calls, now);
      const m = this.readMeta() ?? this.newMeta();
      m.aggregateGeneration = m.recordGeneration;
      m.lastAggregateRebuild = now;
      const split = this.provenanceSplit();
      m.liveRecordedTotal = split.live;
      m.historicalRecoveredTotal = split.historical;
      m.historicalRecoveredRecordCount = split.historicalCount;
      this.writeMeta(m);
      return global;
    });
  }
  earliestRecordAt() {
    const r = this.db.prepare("SELECT MIN(timestamp) AS v FROM usage_records").get();
    return r.v == null ? null : Number(r.v);
  }
  latestRecordAt() {
    const r = this.db.prepare("SELECT MAX(timestamp) AS v FROM usage_records").get();
    return r.v == null ? null : Number(r.v);
  }
  verifyAggregates() {
    const recordTotal = Number(this.db.prepare("SELECT COALESCE(SUM(total_tokens),0) AS s FROM usage_records").get().s);
    const global = this.globalAggregate();
    const globalTotal = global?.total_tokens ?? 0;
    const calls = global?.calls ?? 0;
    const recordCalls = this.recordCount();
    const details = [];
    if (recordTotal !== globalTotal) details.push(`total mismatch: records=${recordTotal} global=${globalTotal}`);
    if (recordCalls !== calls) details.push(`calls mismatch: records=${recordCalls} global=${calls}`);
    return { ok: details.length === 0, recordTotal, globalTotal, details };
  }
  /** Expose the live handle for migration/test integration that must call raw SQL. */
  get database() {
    return this.db;
  }
  /** Delete the given canonical ids and rebuild all aggregates in ONE transaction.
   *  Used by migration rollback (fail-closed: unverified v1 records are removed so
   *  they never become visible before a verified cut-over). Idempotent. */
  removeRecords(ids) {
    if (ids.length === 0) return;
    inTransaction(this.db, () => {
      const del = this.db.prepare("DELETE FROM usage_records WHERE canonical_id=?");
      for (const id of ids) del.run(id);
    });
    this.rebuildAggregates();
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
    sourceType: r.source_type ?? "live_event"
  };
}
function upsertSql() {
  return `INSERT INTO usage_records (canonical_id, session_id, turn, step, seq, timestamp, local_date, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, unclassified, source_type, historical_or_live, migration_version, created_at, updated_at, schema_version)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(canonical_id) DO UPDATE SET seq=excluded.seq, timestamp=excluded.timestamp, local_date=excluded.local_date, provider=excluded.provider, model=excluded.model,
  input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens, cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens,
  reasoning_tokens=excluded.reasoning_tokens, total_tokens=excluded.total_tokens, unclassified=excluded.unclassified, historical_or_live=excluded.historical_or_live, updated_at=excluded.updated_at`;
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
  return { totalTokens: g.total_tokens ?? 0, inputTokens: g.input_tokens ?? 0, outputTokens: g.output_tokens ?? 0, cacheReadTokens: g.cache_read_tokens ?? 0, cacheWriteTokens: g.cache_write_tokens ?? 0, reasoningTokens: g.reasoning_tokens ?? 0, callCount: g.calls ?? 0 };
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
  return rows.reduce((acc, d) => ({ totalTokens: acc.totalTokens + d.total_tokens, inputTokens: acc.inputTokens + d.input_tokens, outputTokens: acc.outputTokens + d.output_tokens, cacheReadTokens: acc.cacheReadTokens + d.cache_read_tokens, cacheWriteTokens: acc.cacheWriteTokens + d.cache_write_tokens, reasoningTokens: acc.reasoningTokens + d.reasoning_tokens, callCount: acc.callCount + d.calls }), emptyMetrics());
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
function rangeModelRows(store, range, now) {
  if (range === "all") return store.modelTotals();
  const dates = datesForRange(range, now);
  const selected = new Set(dates);
  if (range === "7d") return store.dayModelTotals().filter((row) => selected.has(row.local_date));
  return store.dayModelTotals(dates[0]);
}
function rangeDayModelRows(store, range, now) {
  if (range === "all") return store.dayModelTotals();
  const dates = datesForRange(range, now);
  const selected = new Set(dates);
  return store.dayModelTotals().filter((row) => selected.has(row.local_date));
}
function unknownForRange(store, range, now) {
  if (range === "all") {
    const global = store.globalAggregate();
    return { tokens: global?.unknown_tokens ?? 0, calls: global?.unknown_calls ?? 0 };
  }
  const selected = new Set(datesForRange(range, now));
  return store.dailyTotals().filter((row) => selected.has(row.local_date)).reduce((out, row) => ({ tokens: out.tokens + (row.unknown_tokens ?? 0), calls: out.calls + (row.unknown_calls ?? 0) }), { tokens: 0, calls: 0 });
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
    return { todayTotal: today?.total_tokens ?? 0, todayDate, yesterdayTotal: yesterday?.total_tokens ?? 0, yesterdayDate, lifetimeTotal: global?.total_tokens ?? 0, recordCount: this.store.recordCount(), serverNow: todayDate };
  }
  insights(range, inputFilters = {}) {
    const now = this.now();
    const groups = this.store.listProviderAliasGroups();
    const parsed = normalizedFilters(inputFilters, groups);
    const rangeDates = datesForRange(range, now);
    const rawModels = rangeModelRows(this.store, range, now);
    const facets = buildFacets(rawModels, groups);
    if (parsed.active) {
      const matches = (row) => (parsed.providerValues === void 0 || parsed.providerValues.includes(row.provider)) && (parsed.filters.model === null || row.model === parsed.filters.model);
      const selectedModels = rawModels.filter(matches);
      const categories = sumModelMetrics(selectedModels);
      const selectedDaily = rangeDayModelRows(this.store, range, now).filter(matches);
      const excludedUnclassified = unknownForRange(this.store, range, now);
      return {
        range,
        ...rangeDates ? { rangeStartDate: rangeDates[0], rangeEndDate: rangeDates[rangeDates.length - 1] } : {},
        totalTokens: categories.totalTokens,
        categories,
        unknownTokens: 0,
        unknownCallCount: 0,
        daily: dailyFromModelRows(selectedDaily, rangeDates),
        models: modelDetailsOf(selectedModels, parsed.filters.provider ?? void 0, parsed.group),
        filters: parsed.filters,
        facets,
        excludedUnclassified
      };
    }
    if (range === "all") {
      const global = this.store.globalAggregate() ?? {};
      return { range, totalTokens: global.total_tokens ?? 0, categories: metricsOf(global), unknownTokens: global.unknown_tokens ?? 0, unknownCallCount: global.unknown_calls ?? 0, daily: dailyToDetails(this.store.dailyTotals()), models: modelDetailsOf(this.store.modelTotals()), filters: parsed.filters, facets, excludedUnclassified: { tokens: 0, calls: 0 } };
    }
    if (range === "7d") {
      const dates = rangeDates;
      const selected = new Set(dates);
      const allDaily = this.store.dailyTotals();
      const selectedDaily = allDaily.filter((d) => selected.has(d.local_date)).sort((a, b) => a.local_date < b.local_date ? -1 : 1);
      const dayModels2 = this.store.dayModelTotals().filter((m) => selected.has(m.local_date));
      return { range, rangeStartDate: dates[0], rangeEndDate: dates[dates.length - 1], totalTokens: selectedDaily.reduce((a, d) => a + d.total_tokens, 0), categories: sumCategories(selectedDaily), unknownTokens: selectedDaily.reduce((a, d) => a + (d.unknown_tokens ?? 0), 0), unknownCallCount: selectedDaily.reduce((a, d) => a + (d.unknown_calls ?? 0), 0), daily: dailyToDetails(selectedDaily), models: modelDetailsOf(mergeDayModelRows(dayModels2)), filters: parsed.filters, facets, excludedUnclassified: { tokens: 0, calls: 0 } };
    }
    const target = rangeDates[0];
    const day = this.store.daily(target) ?? {};
    const dayModels = this.store.dayModelTotals(target);
    return { range, ...range === "yesterday" ? { rangeStartDate: target, rangeEndDate: target } : {}, totalTokens: day.total_tokens ?? 0, categories: { totalTokens: day.total_tokens ?? 0, inputTokens: day.input_tokens ?? 0, outputTokens: day.output_tokens ?? 0, cacheReadTokens: day.cache_read_tokens ?? 0, cacheWriteTokens: day.cache_write_tokens ?? 0, reasoningTokens: day.reasoning_tokens ?? 0, callCount: day.calls ?? 0 }, unknownTokens: day.unknown_tokens ?? 0, unknownCallCount: day.unknown_calls ?? 0, daily: dailyToDetails(this.store.dailyTotals()), models: modelDetailsOf(dayModels), filters: parsed.filters, facets, excludedUnclassified: { tokens: 0, calls: 0 } };
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
    return { storageBackend: "sqlite", storageSchemaVersion: meta?.storageSchemaVersion, migrationVersion: meta?.migrationVersion, migrationStatus: meta?.migrationStatus, recordGeneration: meta?.recordGeneration, aggregateGeneration: meta?.aggregateGeneration, lastAggregateRebuild: meta?.lastAggregateRebuild ?? void 0, recordCount: this.store.recordCount(), aggregateStatus: this.store.verifyAggregates().ok ? "consistent" : "stale", lifetimeTotal: global?.total_tokens ?? 0, liveRecordedTotal: split.live, historicalRecoveredTotal: split.historical, historicalRecoveredRecordCount: split.historicalCount, providerAliasGroupCount: this.store.listProviderAliasGroups().length, earliestRecordAt: this.store.earliestRecordAt() ?? void 0, latestRecordAt: this.store.latestRecordAt() ?? void 0 };
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
import { copyFileSync, existsSync, mkdirSync as mkdirSync2, readFileSync } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
var V1_MIGRATION_VERSION = 1;
function readV1Root(v1Path) {
  let text;
  try {
    text = readFileSync(v1Path, "utf8");
  } catch {
    return void 0;
  }
  try {
    const doc = JSON.parse(text);
    return doc?.tables?.ledger?.root;
  } catch {
    return void 0;
  }
}
function backupV1Ledger(v1Path, backupDir) {
  if (!v1Path || !existsSync(v1Path)) return void 0;
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const dir = backupDir ?? dirname2(v1Path);
  mkdirSync2(dir, { recursive: true });
  const dest = join2(dir, `dsh_token_usage_sidebar.json.pre-v1.1-${stamp}.bak`);
  copyFileSync(v1Path, dest);
  return dest;
}
function migrateV1Ledger(dest, opts) {
  const t0 = Date.now();
  const existing = dest.readMeta();
  if (existing?.migrationStatus === "done" && existing.migrationVersion >= V1_MIGRATION_VERSION) {
    const total = (existing.liveRecordedTotal ?? 0) + (existing.historicalRecoveredTotal ?? 0);
    return { migrated: false, status: "done", sourceFound: false, migratedRecords: 0, v1LifetimeTotal: total, v11LifetimeTotal: total, durationMs: 0, verification: [], skippedBecauseDone: true };
  }
  let v1 = opts.v1Root;
  if (!v1 && opts.v1Path) v1 = readV1Root(opts.v1Path);
  if (!v1) return { migrated: false, status: "not_started", sourceFound: false, migratedRecords: 0, v1LifetimeTotal: 0, v11LifetimeTotal: 0, durationMs: 0, verification: [] };
  const backupPath = opts.noBackup ? void 0 : backupV1Ledger(opts.v1Path, opts.backupDir);
  {
    const m = dest.readMeta();
    dest.writeMeta({ ...m ?? dest.newMeta(), migrationStatus: "in_progress", migrationVersion: V1_MIGRATION_VERSION });
  }
  const records = buildRecordsFromV1(v1);
  dest.apply(records);
  dest.rebuildAggregates();
  const verification = verifyV1ToV11(dest, v1, records);
  const v11LifetimeTotal = dest.globalAggregate()?.total_tokens ?? 0;
  const v1LifetimeTotal = v1.lifetimeTotal ?? 0;
  const finalMeta = dest.readMeta();
  if (verification.length > 0) {
    dest.removeRecords(records.map((r) => r.id));
    dest.writeMeta({ ...dest.readMeta() ?? finalMeta, migrationStatus: "failed" });
    return { migrated: false, status: "failed", sourceFound: true, migratedRecords: records.length, v1LifetimeTotal, v11LifetimeTotal, durationMs: Date.now() - t0, verification, backupPath };
  }
  dest.writeMeta({ ...finalMeta, migrationStatus: "done", migrationVersion: V1_MIGRATION_VERSION, earliestRecordAt: dest.earliestRecordAt(), latestRecordAt: dest.latestRecordAt(), recoveryJson: v1.recovery ? JSON.stringify(v1.recovery) : null });
  return { migrated: true, status: "done", sourceFound: true, migratedRecords: records.length, v1LifetimeTotal, v11LifetimeTotal, durationMs: Date.now() - t0, verification, backupPath };
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
function verifyV1ToV11(dest, v1, records) {
  const failures = [];
  const v1Lifetime = v1.lifetimeTotal ?? 0;
  const v1Count = v1.recordCount ?? Object.keys(v1.byId ?? {}).length;
  const v11Lifetime = dest.globalAggregate()?.total_tokens ?? 0;
  const v11Count = dest.recordCount();
  if (v1Lifetime !== v11Lifetime) failures.push(`lifetimeTotal mismatch: v1=${v1Lifetime} v1.1=${v11Lifetime}`);
  if (v1Count !== v11Count) failures.push(`recordCount mismatch: v1=${v1Count} v1.1=${v11Count}`);
  const sumRecords = records.reduce((a, r) => a + r.totalTokens, 0);
  if (sumRecords !== v11Lifetime) failures.push(`sum(records)=${sumRecords} != v1.1 global=${v11Lifetime}`);
  return failures;
}

// src/usage/types.ts
function totalOf(b) {
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
function bucketsOf(data) {
  if (!data) return void 0;
  const usage = data.usage;
  if (!usage || typeof usage !== "object") return void 0;
  const inputTokens = Number(usage.inputTokens);
  const outputTokens = Number(usage.outputTokens);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) || inputTokens < 0 || outputTokens < 0) return void 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: Number.isFinite(Number(usage.cacheReadTokens)) ? Number(usage.cacheReadTokens) : void 0,
    cacheWriteTokens: Number.isFinite(Number(usage.cacheWriteTokens)) ? Number(usage.cacheWriteTokens) : void 0,
    reasoningTokens: Number.isFinite(Number(usage.reasoningTokens)) ? Number(usage.reasoningTokens) : void 0
  };
}
function modelSourceOf(data) {
  const source = data?.message && typeof data.message === "object" ? data.message.source : void 0;
  if (!source || typeof source !== "object") return {};
  const record = source;
  const provider = typeof record.provider === "string" && record.provider.length > 0 ? record.provider : void 0;
  const model = typeof record.model === "string" && record.model.length > 0 ? record.model : void 0;
  return { provider, model };
}
function collectSessionUsage(input) {
  const recs = [];
  const now = input.now ?? Date.now();
  const day = new Date(now);
  const y = day.getFullYear();
  const m = String(day.getMonth() + 1).padStart(2, "0");
  const dd = String(day.getDate()).padStart(2, "0");
  const localDate2 = y + "-" + m + "-" + dd;
  const local = (ts) => {
    const d = new Date(ts);
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd2 = String(d.getDate()).padStart(2, "0");
    return yy + "-" + mm + "-" + dd2;
  };
  for (const event of input.events) {
    let usage;
    let turn = 0;
    let step = 0;
    let source;
    let provider = input.provider;
    let model = input.model;
    let ts = now;
    const eventTime = Number(event.time) || 0;
    if (event.type === "assistant/message") {
      const data = event.data ?? {};
      usage = bucketsOf(data);
      if (usage === void 0) continue;
      turn = Number(data.turn ?? 0);
      step = Number(data.step ?? 0);
      source = "assistant/message";
      const messageSource = modelSourceOf(data);
      provider = messageSource.provider ?? provider;
      model = messageSource.model ?? model;
      ts = Number(data.timestamp) || Number(data.createdAt) || eventTime || now;
    } else if (event.type === "assistant/chunk") {
      const data = event.data ?? {};
      const chunk = data.chunk;
      if (!chunk || chunk.type !== "usage" || !chunk.usage) continue;
      usage = {
        inputTokens: Number(chunk.usage.inputTokens) || 0,
        outputTokens: Number(chunk.usage.outputTokens) || 0,
        cacheReadTokens: Number(chunk.usage.cacheReadTokens) || void 0,
        cacheWriteTokens: Number(chunk.usage.cacheWriteTokens) || void 0,
        reasoningTokens: Number(chunk.usage.reasoningTokens) || void 0
      };
      if (totalOf(usage) === 0) continue;
      turn = Number(data.turn ?? 0);
      step = Number(data.step ?? 0);
      source = "assistant/chunk";
      ts = Number(data.timestamp) || eventTime || now;
    } else {
      continue;
    }
    const total = totalOf(usage);
    recs.push({
      id: input.sessionId + ":" + turn + ":" + step,
      source,
      sessionId: input.sessionId,
      turn,
      step,
      seq: event.seq,
      timestamp: ts,
      localDate: local(ts),
      provider,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
      totalTokens: total,
      accounting: "exact",
      sourceType: input.sourceType,
      sourcePath: input.sourcePath,
      migrationVersion: input.migrationVersion
    });
  }
  const best = /* @__PURE__ */ new Map();
  for (const r of recs) {
    const prev = best.get(r.id);
    if (prev === void 0 || r.seq > prev.seq) best.set(r.id, r);
  }
  return [...best.values()].sort((a, b) => a.seq - b.seq);
}

// src/index.ts
var name = "dsh-token-usage-sidebar";
var inject = ["webServer", "sessions", "webRuntime"];
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
  let body = "";
  for await (const chunk of req) body += String(chunk);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
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
  return message.startsWith("provider-alias-") || message.startsWith("alias ") || message.startsWith("filters.");
}
function v1LedgerPath(dbPath) {
  return join3(dirname3(dbPath), "dsh_token_usage_sidebar.json");
}
function apply(ctx) {
  const hctx = ctx;
  const dbPath = (() => {
    try {
      return defaultDbPath({ DSH_HOME: process.env.DSH_HOME });
    } catch {
      return defaultDbPath({});
    }
  })();
  const store = new DurableStore({ path: dbPath });
  ensureDbDir(dbPath);
  const agg = new DurableAggregator(store);
  ctx.effect(async () => {
    let migrated = false;
    let migration;
    try {
      const v1Path = v1LedgerPath(dbPath);
      if (existsSync2(v1Path)) {
        const v1 = readV1Root(v1Path);
        if (v1) {
          migration = migrateV1Ledger(store, { v1Path, backupDir: dirname3(v1Path) });
          migrated = migration.migrated;
          if (migration.status === "done" && migration.verification.length === 0) {
            console.log(
              "[dsh-token-usage-sidebar] v1.0.1 -> v1.1 migration complete:",
              migration.migratedRecords,
              "records, lifetimeTotal",
              migration.v11LifetimeTotal,
              "in",
              migration.durationMs,
              "ms"
            );
          } else if (migration.status === "failed") {
            console.error(
              "[dsh-token-usage-sidebar] v1.0.1 -> v1.1 migration FAILED (no cutover):",
              migration.verification
            );
          } else if (migration.skippedBecauseDone) {
            console.log("[dsh-token-usage-sidebar] v1.1 ledger already migrated; skipping.");
          }
        } else {
          console.log("[dsh-token-usage-sidebar] no readable v1 ledger; starting fresh.");
        }
      } else {
        console.log("[dsh-token-usage-sidebar] no v1 JSON ledger present; fresh v1.1 install.");
      }
      let sessions = [];
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
      hctx.on("session/event", (session, event) => {
        const recs = collectSessionUsage({ sessionId: String(session?.id ?? ""), events: [event] });
        if (recs.length > 0) agg.apply(recs);
      });
      const trustedHosts = () => {
        const rt = hctx.webRuntime?.trustedHosts;
        return Array.isArray(rt) ? rt : [];
      };
      const fence = (req) => {
        try {
          return isTrustedApiRequest(req, trustedHosts());
        } catch {
          return false;
        }
      };
      const dispose = hctx.webServer.register({
        kind: "prefix",
        path: "/token-usage/api",
        handler: async (req, res) => {
          if (!fence(req)) {
            writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
            return;
          }
          if (req.method !== "POST") {
            writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } });
            return;
          }
          const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
          const method = pathname.startsWith("/token-usage/api/") ? pathname.slice("/token-usage/api/".length) : void 0;
          if (!method || method.includes("/")) {
            writeJson(res, 404, { ok: false, error: { code: "not-found", message: "unknown method" } });
            return;
          }
          try {
            const body = await readJsonBody(req);
            if (method === "summary") {
              writeJson(res, 200, { ok: true, value: agg.summary() });
            } else if (method === "details") {
              const range = insightRangeOf(body);
              if (!range) {
                writeJson(res, 400, { ok: false, error: { code: "validation-error", message: "range must be today, yesterday, 7d, or all" } });
                return;
              }
              const filters = usageFiltersOf(body);
              if (!filters.ok) {
                writeJson(res, 400, { ok: false, error: { code: "validation-error", message: filters.message } });
                return;
              }
              writeJson(res, 200, { ok: true, value: agg.insights(range, filters.value) });
            } else if (method === "aliases") {
              const request = aliasRequestOf(body);
              if (!request.ok) {
                writeJson(res, 400, { ok: false, error: { code: "validation-error", message: request.message } });
                return;
              }
              if (request.action === "upsert") store.upsertProviderAliasGroup(request.group);
              if (request.action === "delete") store.deleteProviderAliasGroup(request.id);
              writeJson(res, 200, { ok: true, value: { groups: store.listProviderAliasGroups() } });
            } else if (method === "debug") {
              writeJson(res, 200, { ok: true, value: agg.diagnostics() });
            } else {
              writeJson(res, 404, { ok: false, error: { code: "not-found", message: "unknown method " + method } });
            }
          } catch (e) {
            writeJson(res, isClientValidationError(e) ? 400 : 500, { ok: false, error: { code: isClientValidationError(e) ? "validation-error" : "internal", message: String(e?.message ?? e) } });
          }
        }
      });
      const closer = dispose ?? void 0;
      return () => {
        try {
          closer?.();
        } catch {
        }
        void agg.close();
      };
    } catch (e) {
      try {
        hctx.logger?.warn?.("[dsh-token-usage-sidebar] init failed", e);
      } catch {
      }
      console.error("[dsh-token-usage-sidebar] init failed", e);
      return () => {
        void agg.close();
      };
    }
  }, "dsh-token-usage-sidebar: host");
}
export {
  apply,
  inject,
  name
};
