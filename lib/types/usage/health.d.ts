import type { SourceScanStatus } from './types.js';
/** Accompanies successful reads; a failed cutover is served as an API error. */
export interface UsageHealth {
    status: 'loading' | 'ready' | 'partial' | 'failed';
    sourceScanStatus: SourceScanStatus;
    historicalCoverage: 'partial' | 'unknown';
    sessionsDiscovered: number;
    sessionsReadSuccessfully: number;
    sessionsReadFailed: number;
    invalidUsageEvents: number;
    accountingVersion: number;
    legacyRecordCount: number;
    accountingAdjustment: number;
    accountingChangeCount: number;
    /** True while the persisted-session scan still runs in the background (v1.1.11). */
    scanInProgress: boolean;
    updatedAt: number;
}
