// src/usage/types.ts
// Core data model for dsh-token-usage-sidebar accounting.
//
// One model invocation = one authoritative UsageRecord. Authoritative counts
// come from durable session-log events, never tokenizer estimates.

/** A local calendar day, YYYY-MM-DD (host process timezone). */
export type LocalDate = string;

/**
 * One model invocation's authoritative usage. The dedup identity is
 * `${sessionId}:${turn}:${step}` -- the same (turn, step) sample may be reported
 * first as an early stream sample (assistant/chunk.usage) and later replaced by
 * the final committed message (assistant/message.usage). Exactly one number per
 * (session, turn, step) contributes to Lifetime/Total.
 */
export interface UsageRecord {
  /** Deterministic dedup identity. */
  readonly id: string;
  /** Source event type. */
  readonly source: 'assistant/message' | 'assistant/chunk';
  readonly sessionId: string;
  readonly turn: number;
  readonly step: number;
  /** Committed event seq in the session log (for audit; higher wins on conflict). */
  readonly seq: number;
  /** Unix epoch ms at fold time. */
  readonly timestamp: number;
  /** Local calendar day of the usage. */
  readonly localDate: LocalDate;
  readonly provider?: string;
  readonly model?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  /** Authoritative total = input + cacheRead + cacheWrite + output. */
  readonly totalTokens: number;
  /** Always 'exact' for authoritative provider usage; reserved for future estimation fallback. */
  readonly accounting: 'exact';
  /** v0.2 provenance: first-seen source. */
  readonly sourceType?: UsageSourceType;
  /** v0.2 provenance: on-disk path / store the record came from. */
  readonly sourcePath?: string;
  /** v0.2 provenance: migration/format version. */
  readonly migrationVersion?: number;
}

/** Disjoint token buckets from a provider TokenUsage. */
export interface UsageBuckets {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

/** Sum disjoint provider buckets without double-counting reasoning (output subdivision). */
export function totalOf(b: UsageBuckets): number {
  return b.inputTokens + (b.cacheReadTokens ?? 0) + (b.cacheWriteTokens ?? 0) + b.outputTokens;
}

// ── v0.2 provenance (§9, §10) ──────────────────────────────────────────────

/** Where an invocation's authoritative usage was first recovered. */
export type UsageSourceType =
  | 'live_event'        // recorded live via session/event after plugin install
  | 'session_log'       // recovered from a durable session.jsonl.zstd on disk
  | 'provider_record'   // recovered from a provider response record (reserved)
  | 'legacy_store'      // recovered from a legacy/token-meter store (reserved)
  | 'other';

/** Audit breadcrumb carried on every record. */
export interface UsageProvenance {
  /** Canonical dedup identity (sessionId:turn:step). */
  readonly id: string;
  /** First-seen source; precedence: live committed > durable session log > other. */
  readonly sourceType: UsageSourceType;
  /** On-disk path or store identifier the record came from. */
  readonly sourcePath?: string;
  /** Migration/format version that produced it. */
  readonly migrationVersion?: number;
}

/** Tracking metadata persisted with the ledger (§23). */
export interface RecoveryMetadata {
  /** Date the plugin began authoritative tracking (installation date). */
  readonly trackingStartDate?: string;
  /** Earliest recoverable historical event timestamp (epoch ms). */
  readonly earliestRecoveredAt?: number;
  /** Latest recoverable pre-plugin/past event timestamp (epoch ms). */
  readonly latestRecoveredAt?: number;
  /** Migration version of the recovery logic. */
  readonly recoveryVersion?: number;
  /** When the historical recovery last completed (epoch ms). */
  readonly recoveryCompletedAt?: number;
  /** Source label(s) that contributed recovered records. */
  readonly recoverySources?: readonly string[];
  /** Number of distinct historical invocations recovered (not overlapped by live). */
  readonly recoveredRecordCount?: number;
  /** COMPLETE | PARTIAL | UNKNOWN relative to recoverable authoritative history. */
  readonly recoveryStatus?: 'complete' | 'partial' | 'unknown';
}
/** The current local calendar day in the host process timezone. */
export function currentLocalDate(now: number = Date.now()): LocalDate {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Whole-value aggregate state. Today reflects the current local calendar day;
 * Lifetime is the cumulative total ever recorded. Both are maintained, so a
 * sidebar render needs no scan of the ledger.
 */
export interface UsageAggregate {
  /** Lifetime cumulative total tokens (exact provider counts). */
  readonly lifetimeTotal: number;
  /** Tokens recorded during the current local calendar day. */
  readonly todayTotal: number;
  /** The local calendar day `todayTotal` corresponds to. */
  readonly todayDate: LocalDate;
  /** Total distinct invocations recorded. */
  readonly recordCount: number;
}

export const EMPTY_AGGREGATE: UsageAggregate = Object.freeze({
  lifetimeTotal: 0,
  todayTotal: 0,
  todayDate: currentLocalDate(),
  recordCount: 0,
});
