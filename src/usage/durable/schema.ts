// src/usage/durable/schema.ts — SQLite schema (v1.1 scalable durable ledger)
// usage_records = authoritative source of truth; aggregate_* = derived cache.
export const STORAGE_SCHEMA_VERSION = 2;
export const SCHEMA_SQL: readonly string[] = [
  'CREATE TABLE IF NOT EXISTS usage_records (' +
  'canonical_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn INTEGER NOT NULL, ' +
  'step INTEGER NOT NULL, seq INTEGER NOT NULL, timestamp INTEGER NOT NULL, local_date TEXT NOT NULL, ' +
  'provider TEXT, model TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, ' +
  'cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, ' +
  'total_tokens INTEGER NOT NULL, unclassified INTEGER NOT NULL DEFAULT 0, source_type TEXT, historical_or_live TEXT, ' +
  'migration_version INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, schema_version INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS aggregate_global (id INTEGER PRIMARY KEY CHECK (id=1), total_tokens INTEGER NOT NULL, ' +
  'input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, ' +
  'cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, calls INTEGER NOT NULL, ' +
  'unknown_tokens INTEGER NOT NULL DEFAULT 0, unknown_calls INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS aggregate_daily (local_date TEXT PRIMARY KEY, total_tokens INTEGER NOT NULL, ' +
  'input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, ' +
  'cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, calls INTEGER NOT NULL, ' +
  'unknown_tokens INTEGER NOT NULL DEFAULT 0, unknown_calls INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS aggregate_model (provider TEXT NOT NULL, model TEXT NOT NULL, total_tokens INTEGER NOT NULL, ' +
  'input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, ' +
  'cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, calls INTEGER NOT NULL, ' +
  'unknown_tokens INTEGER NOT NULL DEFAULT 0, unknown_calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (provider, model))',
  'CREATE TABLE IF NOT EXISTS aggregate_day_model (local_date TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, ' +
  'total_tokens INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, ' +
  'cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, ' +
  'calls INTEGER NOT NULL, PRIMARY KEY (local_date, provider, model))',
  'CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id=1), storage_schema_version INTEGER NOT NULL, ' +
  'migration_version INTEGER NOT NULL, record_generation INTEGER NOT NULL, aggregate_generation INTEGER NOT NULL, ' +
  'migration_status TEXT NOT NULL, last_aggregate_rebuild INTEGER, earliest_record_at INTEGER, latest_record_at INTEGER, ' +
  'live_recorded_total INTEGER NOT NULL DEFAULT 0, historical_recovered_total INTEGER NOT NULL DEFAULT 0, ' +
  'historical_recovered_record_count INTEGER NOT NULL DEFAULT 0, recovery_json TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_usage_records_date ON usage_records(local_date)',
  'CREATE INDEX IF NOT EXISTS idx_usage_records_provider_model ON usage_records(provider, model)',
  'CREATE TABLE IF NOT EXISTS provider_alias_groups (' +
  'id TEXT PRIMARY KEY, label TEXT NOT NULL, raw_values_json TEXT NOT NULL, ' +
  'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
];
