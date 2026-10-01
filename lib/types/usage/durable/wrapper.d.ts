import { DatabaseSync } from 'node:sqlite';
/** Plugin-owned SQLite ledger name (sibling to the v1 JSON ledger). */
export declare const DB_FILE_NAME = "dsh_token_usage_sidebar.sqlite";
/** Resolve the plugin-owned durable DB path, environment-neutral.
 *  DSH data lives under DSH_HOME (or ~/.dsh), in the same `storages` directory
 *  the v1 JSON ledger used. Never the source repo, install dir, or temp. */
export declare function defaultDbPath(env?: {
    DSH_HOME?: string;
}, home?: string): string;
/** Ensure the DB parent directory exists (idempotent). */
export declare function ensureDbDir(path: string): void;
export type DbHandle = DatabaseSync;
export interface TxRunner {
    exec(sql: string): void;
    prepare(sql: string): ReturnType<DatabaseSync['prepare']>;
}
export declare function openDatabase(path: string): DbHandle;
export declare function inTransaction<T>(db: DbHandle, fn: (tx: TxRunner) => T): T;
export declare function backupDatabaseTo(src: DbHandle, destPath: string): string;
