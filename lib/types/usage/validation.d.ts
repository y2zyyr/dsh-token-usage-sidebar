import type { UsageRecord } from './types.js';
export declare function isTokenCount(value: unknown): value is number;
export declare function isLocalDate(value: string): boolean;
/** Reject a whole batch before any write. Legacy unknown totals remain valid. */
export declare function assertUsageRecord(record: UsageRecord): void;
