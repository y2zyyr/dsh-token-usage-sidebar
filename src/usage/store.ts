// src/usage/store.ts
// Durable persistence seam. The host plugin provides a DSH-backed
// implementation over ctx.storageDomain (domain-KV) -> ~/.dsh/storages/<unit>.json.
// Keeping an interface here lets the accounting core and tests run with an
// in-memory or file-backed store, independent of DSH.
import type { LedgerState } from './ledger.ts';
export type { LedgerState } from './ledger.ts';

export interface UsageStore {
  /** Resolve the persisted ledger; returns undefined when none exists yet. */
  load(): Promise<LedgerState | undefined>;
  /** Persist the given ledger atomically. */
  save(ledger: LedgerState): Promise<void>;
  /** Best-effort dispose; used by tests and plugin teardown. */
  close?(): Promise<void>;
}

/** In-memory store: useful as a mock and for tests. */
export class MemoryUsageStore implements UsageStore {
  private value: LedgerState | undefined;
  writes = 0;
  async load(): Promise<LedgerState | undefined> { return this.value; }
  async save(ledger: LedgerState): Promise<void> { this.value = ledger; this.writes += 1; }
  set(v: LedgerState | undefined): void { this.value = v; }
}