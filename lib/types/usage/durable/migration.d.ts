import type { UsageRecord, UsageSourceType } from '../types.js';
import { DurableStore } from './durableStore.js';
export declare const V1_MIGRATION_VERSION = 1;
export interface V1Detail {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    provider?: string;
    model?: string;
}
export interface V1LedgerState {
    lifetimeTotal?: number;
    todayTotal?: number;
    todayDate?: string;
    byId?: Record<string, number>;
    recordCount?: number;
    src?: Record<string, UsageSourceType | undefined>;
    liveRecordedTotal?: number;
    historicalRecoveredTotal?: number;
    historicalRecoveredRecordCount?: number;
    dayBy?: Record<string, string>;
    seqBy?: Record<string, number>;
    detailBy?: Record<string, V1Detail>;
    schemaVersion?: number;
    recovery?: unknown;
}
export interface MigrationResult {
    migrated: boolean;
    status: 'done' | 'failed' | 'not_started';
    sourceFound: boolean;
    migratedRecords: number;
    v1LifetimeTotal: number;
    v11LifetimeTotal: number;
    durationMs: number;
    verification: string[];
    backupPath?: string;
    skippedBecauseDone?: boolean;
}
export interface MigrationOptions {
    v1Root?: V1LedgerState;
    v1Path?: string;
    backupDir?: string;
    now?: () => number;
    noBackup?: boolean;
}
export type V1ReadResult = {
    status: 'absent';
} | {
    status: 'invalid';
    message: string;
} | {
    status: 'ok';
    root: V1LedgerState;
};
export declare function readV1RootResult(v1Path: string): V1ReadResult;
/** Compatibility reader. Host code uses the discriminated result above. */
export declare function readV1Root(v1Path: string): V1LedgerState | undefined;
export declare function backupV1Ledger(v1Path: string | undefined, backupDir?: string): string | undefined;
export declare function migrateV1Ledger(dest: DurableStore, opts: MigrationOptions): MigrationResult;
export declare function buildRecordsFromV1(v1: V1LedgerState): UsageRecord[];
export declare function verifyV1ToV11(dest: DurableStore, v1: V1LedgerState, records: UsageRecord[], before?: {
    total: number;
    rows: Map<string, Record<string, unknown> | undefined>;
}): string[];
