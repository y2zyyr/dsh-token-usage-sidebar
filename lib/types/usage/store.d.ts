import type { LedgerState } from './ledger.js';
export type { LedgerState } from './ledger.js';
/** Outcome of loading the persisted ledger. */
export type LoadOutcome = {
    status: 'none';
    ledger?: undefined;
} | {
    status: 'ok';
    ledger: LedgerState;
} | {
    status: 'invalid';
    ledger?: undefined;
};
/**
 * v1.0.1: load() must distinguish "no ledger exists yet" from "ledger exists
 * but is corrupt/invalid". Treating an invalid store as absent silently resets
 * lifetimeTotal to zero — a forbidden data-destruction behavior. Implementations
 * that only hold a raw LedgerState are still supported via the shorthand.
 */
export interface UsageStore {
    /** Resolve the persisted ledger. Returns 'none' when nothing exists yet,
     *  'ok' on a validated ledger, 'invalid' when a row exists but fails parsing. */
    load(): Promise<LoadOutcome | LedgerState | undefined>;
    /** Persist the given ledger atomically. */
    save(ledger: LedgerState): Promise<void>;
    /** Best-effort dispose; used by tests and plugin teardown. */
    close?(): Promise<void>;
}
/** Normalize a store's load() return (outcome object or legacy shorthand). */
export declare function normalizeLoad(raw: LoadOutcome | LedgerState | undefined): LoadOutcome;
/** In-memory store: useful as a mock and for tests. */
export declare class MemoryUsageStore implements UsageStore {
    private value;
    writes: number;
    load(): Promise<LedgerState | undefined>;
    save(ledger: LedgerState): Promise<void>;
    set(v: LedgerState | undefined): void;
}
