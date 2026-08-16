// src/usage/store.ts
// Durable persistence seam. The host plugin provides a DSH-backed
// implementation over ctx.storageDomain (domain-KV) -> ~/.dsh/storages/<unit>.json.
// Keeping an interface here lets the accounting core and tests run with an
// in-memory or file-backed store, independent of DSH.
import type { LedgerState } from './ledger.ts';
export type { LedgerState } from './ledger.ts';

/** Outcome of loading the persisted ledger. */
export type LoadOutcome =
  | { status: 'none'; ledger?: undefined }            // no persisted ledger yet (fresh install)
  | { status: 'ok'; ledger: LedgerState }             // parsed and validated
  | { status: 'invalid'; ledger?: undefined };        // row exists but failed validation

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
export function normalizeLoad(raw: LoadOutcome | LedgerState | undefined): LoadOutcome {
  if (raw === undefined) return { status: 'none' };
  if (typeof raw === 'object' && 'status' in raw
      && (raw.status === 'none' || raw.status === 'ok' || raw.status === 'invalid')) {
    return raw as LoadOutcome;
  }
  return { status: 'ok', ledger: raw as LedgerState };
}

/** In-memory store: useful as a mock and for tests. */
export class MemoryUsageStore implements UsageStore {
  private value: LedgerState | undefined;
  writes = 0;
  async load(): Promise<LedgerState | undefined> { return this.value; }
  async save(ledger: LedgerState): Promise<void> { this.value = ledger; this.writes += 1; }
  set(v: LedgerState | undefined): void { this.value = v; }
}