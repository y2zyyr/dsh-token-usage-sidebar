// src/usage/durable/wrapper.ts — minimal wrapper around node:sqlite (DatabaseSync)
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { SCHEMA_SQL } from './schema.ts';

/** Plugin-owned SQLite ledger name (sibling to the v1 JSON ledger). */
export const DB_FILE_NAME = 'dsh_token_usage_sidebar.sqlite';

/** Resolve the plugin-owned durable DB path, environment-neutral.
 *  DSH data lives under DSH_HOME (or ~/.dsh), in the same `storages` directory
 *  the v1 JSON ledger used. Never the source repo, install dir, or temp. */
export function defaultDbPath(env?: { DSH_HOME?: string }, home: string = homedir()): string {
  const base = (env && env.DSH_HOME && env.DSH_HOME.length > 0) ? env.DSH_HOME : join(home, '.dsh');
  return join(base, 'storages', DB_FILE_NAME);
}

/** Ensure the DB parent directory exists (idempotent). */
export function ensureDbDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

export type DbHandle = DatabaseSync;
export interface TxRunner { exec(sql: string): void; prepare(sql: string): ReturnType<DatabaseSync['prepare']>; }

export function openDatabase(path: string): DbHandle {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA temp_store = MEMORY');
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}

export function inTransaction<T>(db: DbHandle, fn: (tx: TxRunner) => T): T {
  db.exec('BEGIN');
  try { const out = fn({ exec: (sql) => db.exec(sql), prepare: (sql) => db.prepare(sql) }); db.exec('COMMIT'); return out; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

export function backupDatabaseTo(src: DbHandle, destPath: string): string {
  src.exec('PRAGMA wal_checkpoint(FULL)');
  src.exec("VACUUM INTO '" + destPath.replaceAll("'", "''") + "'");
  return destPath;
}
