import { SessionUsageCollector, type SessionEventLike } from '../collector.js';
import type { UsageRecord, SourceScanStatus } from '../types.js';
import { DurableStore } from './durableStore.js';
interface HeaderLike {
    id: string;
    isSeeded?: boolean;
    parentSession?: string;
}
export interface LiveSessionLike {
    id: string;
    header?: HeaderLike;
    inheritedEventCount?: number;
    events?: readonly SessionEventLike[];
    snapshotEvents?: () => readonly SessionEventLike[];
}
interface ReadHandle {
    header: HeaderLike;
    inheritedEventCount: number;
    read(offset?: number, length?: number, options?: {
        signal?: AbortSignal;
    }): Promise<{
        events: readonly SessionEventLike[];
    }>;
    close(): Promise<void>;
}
export interface PersistenceLike {
    list(options?: unknown): Promise<readonly unknown[]>;
    listSnapshots?: (signal?: AbortSignal) => Promise<readonly unknown[]>;
    open?: (id: string, access: 'read', options?: {
        signal?: AbortSignal;
    }) => Promise<ReadHandle>;
    readFrom?: (id: string, fromSeq: number, signal?: AbortSignal) => Promise<{
        meta: HeaderLike;
        events: readonly SessionEventLike[];
    }>;
}
export interface SessionRecoveryResult {
    sourceScanStatus: SourceScanStatus;
    sessionsDiscovered: number;
    sessionsReadSuccessfully: number;
    sessionsReadFailed: number;
    sessionsSkippedUnchanged: number;
    invalidUsageEvents: number;
    errors: string[];
}
export declare function snapshotLiveSession(session: LiveSessionLike, onInvalidUsage?: () => void): {
    collector: SessionUsageCollector;
    records: UsageRecord[];
    inheritedIds: string[];
    lastSeq: number;
};
/** Always closes read handles; records and their checkpoint commit together. */
export declare function recoverPersistedSessions(store: DurableStore, persistence: PersistenceLike | undefined, signal: AbortSignal): Promise<SessionRecoveryResult>;
export {};
