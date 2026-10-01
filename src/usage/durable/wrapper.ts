// src/usage/durable/wrapper.ts — minimal wrapper around node:sqlite (DatabaseSync)
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { SCHEMA_SQL, STORAGE_SCHEMA_VERSION } from './schema.ts';

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
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()) {
      const meta = db.prepare('SELECT storage_schema_version FROM meta WHERE id=1').get() as { storage_schema_version?: number } | undefined;
      if (Number(meta?.storage_schema_version ?? 0) > STORAGE_SCHEMA_VERSION) throw new Error('unsupported-storage-schema');
    }
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec('PRAGMA temp_store = MEMORY');
    inTransaction(db, () => {
      for (const sql of SCHEMA_SQL) db.exec(sql);
      const columns = db.prepare('PRAGMA table_info(usage_records)').all() as { name: string }[];
      if (!columns.some((column) => column.name === 'accounting_version')) db.exec('ALTER TABLE usage_records ADD COLUMN accounting_version INTEGER NOT NULL DEFAULT 1');
      if (!columns.some((column) => column.name === 'excluded_reason')) db.exec('ALTER TABLE usage_records ADD COLUMN excluded_reason TEXT');
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const depths = new WeakMap<DbHandle, number>();
let savepointNumber = 0;
export function inTransaction<T>(db: DbHandle, fn: (tx: TxRunner) => T): T {
  const depth = depths.get(db) ?? 0;
  const savepoint = 'usage_tx_' + ++savepointNumber;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : 'SAVEPOINT ' + savepoint);
  depths.set(db, depth + 1);
  try {
    const out = fn({ exec: (sql) => db.exec(sql), prepare: (sql) => db.prepare(sql) });
    db.exec(depth === 0 ? 'COMMIT' : 'RELEASE SAVEPOINT ' + savepoint);
    return out;
  } catch (error) {
    if (depth === 0) db.exec('ROLLBACK');
    else { db.exec('ROLLBACK TO SAVEPOINT ' + savepoint); db.exec('RELEASE SAVEPOINT ' + savepoint); }
    throw error;
  } finally { depths.set(db, depth); }
}

export function backupDatabaseTo(src: DbHandle, destPath: string): string {
  src.exec('PRAGMA wal_checkpoint(FULL)');
  src.exec("VACUUM INTO '" + destPath.replaceAll("'", "''") + "'");
  return destPath;
}
