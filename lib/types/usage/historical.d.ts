import { type LedgerState } from './ledger.js';
import type { RecoveryMetadata } from './types.js';
export declare const HISTORICAL_MIGRATION_VERSION = 4;
/** One persisted session the recovery scans. */
export interface HistoricalSession {
    /** DSH session id (session-... / bare uuid). */
    readonly id: string;
    /** Optional on-disk path (for provenance). */
    readonly path?: string;
}
/**
 * Injectable reader so the host plugin can reuse DSH's own persistence
 * (`ctx.sessionPersistence.list()` + `readFrom(id,0)` — correct multi-frame
 * zstd, archived/cold included), while tests use a file-backed reader over
 * single-frame fixtures.
 */
export interface HistoricalReader {
    list(): Promise<HistoricalSession[]>;
    readEvents(id: string): Promise<{
        sessionId: string;
        events: {
            type: string;
            seq: number;
            time?: number;
            data?: Record<string, unknown>;
        }[];
        path?: string;
    } | null>;
}
/** Resolve the DSH sessions root (used by the file-backed fallback reader). */
export declare function sessionsRoot(overrideDshHome?: string): string;
/** Walk every `session.jsonl.zstd` on disk (skips *.corrupt-original / *.bak). */
export declare function enumerateSessionLogs(sessionsDir: string): string[];
/** Generic file-backed reader (single-frame zstd fixtures; used by tests). */
export declare function fileBackedReader(sessionsDir: string): HistoricalReader;
/** Parse JSONL lines into a session id + events. */
export declare function parseSessionLog(lines: string): {
    sessionId: string;
    events: {
        type: string;
        seq: number;
        time?: number;
        data?: Record<string, unknown>;
    }[];
};
/**
 * v1.0.1: source-scan mechanics for the file-backed path.
 * A readable sessions root does NOT prove full lifetime coverage — it only says
 * the plugin could attempt an enumeration. Scan mechanics are reported
 * separately from coverage (recoveryStatus) so the plugin never overclaims.
 */
export declare function deriveRecoveryStatus(sessionsDir: string): RecoveryMetadata['sourceScanStatus'];
export interface HistoricalMigrationOptions {
    reader?: HistoricalReader;
    sessionsDir?: string;
    now?: number;
    force?: boolean;
}
export interface HistoricalMigrationResult {
    migrated: boolean;
    ledger: LedgerState;
    summary: {
        migrated: boolean;
        sessionsScanned: number;
        recordsFound: number;
        recoveredTokens: number;
        liveTokens: number;
        lifetimeTotal: number;
        earliestRecoveredAt?: number;
        latestRecoveredAt?: number;
        /** v1.0.1: scan mechanics — how many sessions were enumerated/read/failed. */
        sessionsDiscovered?: number;
        sessionsReadSuccessfully?: number;
        sessionsReadFailed?: number;
        /** v1.0.1: source scan mechanics, never conflated with coverage. */
        sourceScanStatus?: RecoveryMetadata['sourceScanStatus'];
        /** v1.0.1: lifetime coverage (partial unless scan complete AND no pre-tracking gap). */
        recoveryStatus?: RecoveryMetadata['recoveryStatus'];
    };
}
/**
 * Run the v0.2 historical recovery migration (idempotent).
 * If already verified under v1.0.1 semantics (schemaVersion >= 2 with both
 * recoveryStatus AND sourceScanStatus metadata) it is a no-op unless `force`
 * is set; a legacy 'complete' recoveryStatus alone is NOT enough to skip the
 * scan (§19). Meres every authoritative record into the ledger without
 * resetting or dropping existing live records.
 */
export declare function runHistoricalMigration(ledger: LedgerState, opts?: HistoricalMigrationOptions): Promise<HistoricalMigrationResult>;
