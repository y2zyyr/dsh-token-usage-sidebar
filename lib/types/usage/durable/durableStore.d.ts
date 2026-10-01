import { DatabaseSync } from 'node:sqlite';
import type { UsageRecord } from '../types.js';
import type { ProviderAliasGroup } from '../providerAliases.js';
export type MigrationStatus = 'not_started' | 'in_progress' | 'done' | 'failed';
export interface DurableMeta {
    storageSchemaVersion: number;
    migrationVersion: number;
    recordGeneration: number;
    aggregateGeneration: number;
    migrationStatus: MigrationStatus;
    lastAggregateRebuild: number | null;
    earliestRecordAt: number | null;
    latestRecordAt: number | null;
    liveRecordedTotal: number;
    historicalRecoveredTotal: number;
    historicalRecoveredRecordCount: number;
    recoveryJson: string | null;
}
export interface GlobalAggRow {
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    calls: number;
    unknown_tokens: number;
    unknown_calls: number;
    updated_at: number;
}
export interface DailyAggRow {
    local_date: string;
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    calls: number;
    unknown_tokens: number;
    unknown_calls: number;
}
export interface ModelAggRow {
    provider: string;
    model: string;
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    calls: number;
    unknown_tokens: number;
    unknown_calls: number;
}
export interface DayModelAggRow {
    local_date: string;
    provider: string;
    model: string;
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    calls: number;
}
export interface BatchOutcome {
    added: number;
    replaced: number;
    ignored: number;
}
export interface DurableStoreOptions {
    path: string;
    now?: () => number;
}
export interface ProviderAliasGroupInput {
    id?: string;
    label: string;
    rawValues: readonly string[];
}
export declare class DurableStore {
    private db;
    private now;
    private closed;
    private statements;
    private path;
    private accountingBackup?;
    readonly repairedOnOpen: boolean;
    constructor(opts: DurableStoreOptions);
    get isClosed(): boolean;
    private statement;
    private ensureMeta;
    readMeta(): DurableMeta | null;
    writeMeta(m: DurableMeta): void;
    newMeta(): DurableMeta;
    recordCount(): number;
    hasRecord(id: string): boolean;
    getRecord(id: string): Record<string, unknown> | undefined;
    listRecords(): UsageRecord[];
    provenanceSplit(): {
        live: number;
        historical: number;
        historicalCount: number;
    };
    globalAggregate(): GlobalAggRow | null;
    dailyTotals(start?: string, end?: string): DailyAggRow[];
    daily(date: string): DailyAggRow | undefined;
    modelTotals(): ModelAggRow[];
    dayModelTotals(date?: string, end?: string): DayModelAggRow[];
    listProviderAliasGroups(): ProviderAliasGroup[];
    upsertProviderAliasGroup(input: ProviderAliasGroupInput): ProviderAliasGroup;
    deleteProviderAliasGroup(id: string): boolean;
    apply(records: readonly UsageRecord[], options?: {
        reconcile?: boolean;
    }): BatchOutcome;
    private addContribution;
    private subtractContribution;
    /** Cheap meta bump: generation, latest timestamp, and the precomputed split. */
    private bumpRecordGeneration;
    private expectedAggregates;
    private invalidRecordCount;
    rebuildAggregates(): GlobalAggRow;
    earliestRecordAt(): number | null;
    latestRecordAt(): number | null;
    verifyAggregates(): {
        ok: boolean;
        recordTotal: number;
        globalTotal: number;
        details: string[];
        invalidRecords: number;
    };
    readSessionCheckpoint<T>(sessionId: string): T | undefined;
    writeSessionCheckpoint(sessionId: string, checkpoint: unknown): void;
    readSourceDiscoveryCache<T>(): T | undefined;
    writeSourceDiscoveryCache(cache: unknown): void;
    /** Only a complete, validated session replay may upgrade legacy attempt identities. */
    reconcileSession(sessionId: string, records: readonly UsageRecord[], inheritedIds: readonly string[], lastSeq: number, checkpoint?: unknown): void;
    accountingDiagnostics(): {
        accountingVersion: number;
        legacyRecordCount: number;
        accountingAdjustment: number;
        accountingChangeCount: number;
    };
    /** Expose the live handle for migration/test integration that must call raw SQL. */
    get database(): DatabaseSync;
    /** Maintenance helper. Migration rollback uses transactions, never deletion. */
    removeRecords(ids: readonly string[]): void;
    close(): void;
}
