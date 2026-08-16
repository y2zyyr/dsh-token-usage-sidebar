# Architecture — dsh-token-usage-sidebar

Community DeepSeek Harness (DSH) web-profile plugin that keeps provider-reported
token usage locally, with a sidebar summary and a native Settings → Token Usage page.

## High-level flow

```text
DSH session events (assistant/message.usage, assistant/chunk type=usage)
        │ collectSessionUsage() → UsageRecord[ id = sessionId:turn:step ]
        ▼
DurableAggregator / DurableStore (SQLite, v1.1)  ──► aggregate tables
        │ row-level upsert (exactly-once, higher-seq wins)
        ▼
sidebar summary / settings details / debug  (aggregates only; no ledger rows cross)
```

## Modules

- `src/usage/types.ts` — core model: `UsageRecord`, `UsageSourceType`, `RecoveryMetadata`.
- `src/usage/collector.ts` — translates durable session events into `UsageRecord`s.
- `src/usage/ledger.ts` — v1.0.1 pure in-memory accounting (kept as the legacy reader and migration reference).
- `src/usage/aggregator.ts`, `historical.ts`, `insights.ts`, `store.ts` — v1.0.1 host services (kept for legacy compatibility/tests).
- `src/usage/durable/` — v1.1 SQLite durable ledger:
  - `schema.ts` — DDL and `STORAGE_SCHEMA_VERSION`.
  - `wrapper.ts` — `node:sqlite` open/WAL/transaction/backup + DB-path resolution.
  - `durableStore.ts` — record upsert, aggregate-delta maintenance, rebuild, verify.
  - `durableAggregator.ts` — aggregate-driven summary/details/diagnostics service.
  - `migration.ts` — v1.0.1 JSON → v1.1 SQLite migration.
- `src/index.ts` — host wiring: DB open, migration, live event drive, web routes.

## Source of truth

`usage_records` is the authoritative accounting source. The aggregate tables
(`aggregate_global`, `aggregate_daily`, `aggregate_model`, `aggregate_day_model`) are
derived, rebuildable caches. If an aggregate drifts, `rebuildAggregates()` re-derives it
from records. Cached totals are never the sole source of truth.

## Exactly-once

Canonical identity is `sessionId:turn:step` (`usage_records.canonical_id`).
The final committed `assistant/message.usage` supersedes an earlier `assistant/chunk`
sample for the same id; a higher `seq` wins on conflict and re-deliveries/duplicates
never double-count. One model invocation = one record.

## Write path (chunk → final)

A stream sample (e.g. 12,000) followed by the final assistant message (e.g. 14,174) for
the same `(session, turn, step)` results in one row with `total_tokens = 14,174`. The
aggregates are adjusted by the difference (+2,174), not by adding 14,174 again, via a
single transaction that subtracts the old row and adds the new row.

## Transactions and journal

- Each record batch commits `usage_records` updates + aggregate deltas in one SQLite
  transaction (`BEGIN` … `COMMIT`/`ROLLBACK`).
- The DB uses WAL journaling (`PRAGMA journal_mode=WAL`, `synchronous=NORMAL`), giving
  readers/checkpointing durability while keeping per-invocation writes small.

## Migration

See `docs/migrations/v1.0.1-to-v1.1.0.md` and `docs/architecture/STORAGE_DECISION.md`.

## Performance

The storage architecture decision was made because v1.0.1 rewrote the whole JSON ledger
on each invocation (O(N)). v1.1 performs one small row-level SQLite upsert whose latency
is effectively flat regardless of lifetime history size (measured 1k → 500k records).
Summary and detail reads use maintained aggregates and indexes.
