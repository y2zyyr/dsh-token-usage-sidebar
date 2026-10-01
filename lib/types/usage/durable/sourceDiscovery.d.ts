import type { UsageRecord } from '../types.js';
import type { DurableStore } from './durableStore.js';
export declare const SOURCE_DISCOVERY_VERSION = 3;
type DiscoveryFormat = 'record-table' | 'legacy-root' | 'aggregate-summary';
export interface DiscoveredSource {
    path: string;
    format: DiscoveryFormat;
    sha256: string;
    recordCount: number;
    totalTokens: number;
    imported: boolean;
}
export interface SourceDiscoveryResult {
    cached?: boolean;
    storageDir: string;
    status: 'complete' | 'partial' | 'failed' | 'none';
    records: UsageRecord[];
    sources: DiscoveredSource[];
    errors: string[];
    aggregateChecks: {
        expectedTotal: number | null;
        expectedRecordCount: number | null;
        discoveredTotal: number;
        discoveredRecordCount: number;
    };
}
export interface SourceDiscoveryOptions {
    /** Import the legacy root only after the verified v1 migration completed. */
    includeLegacyRoot?: boolean;
}
/** Cache only successful, committed imports. File changes and failed scans are rechecked. */
export declare function importTokenSources(store: DurableStore, storageDir: string, options?: SourceDiscoveryOptions): {
    discovery: SourceDiscoveryResult;
    applied: number;
};
/**
 * Discover plugin-owned JSON storage units in one DSH storages directory.
 * Aggregate-only units are recorded for verification but never converted into
 * UsageRecords. Record-table units are normalized and deduplicated by ID.
 */
export declare function discoverTokenSources(storageDir: string, options?: SourceDiscoveryOptions): SourceDiscoveryResult;
export {};
