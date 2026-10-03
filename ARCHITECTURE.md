# Architecture — dsh-token-usage-sidebar

Community DeepSeek Harness (DSH) Web/Desktop plugin with a local usage ledger,
sidebar summary, and native Settings → Token Usage page. This document describes
version 1.1.9 and its accounting version 2 migration.

## Data flow

```text
live Session snapshots/events + read-only sessionPersistence history
       │ SessionUsageCollector (accounting v2, per-attempt IDs, owned fork events)
       ▼
DurableStore (SQLite WAL) ──► derived aggregate tables
       │ records + deltas + verified recovery checkpoint commit together
       ▼
fenced POST API ──► sidebar / settings (aggregates and health only)
```

## Modules

- `src/index.ts` opens storage, migrates/imports legacy sources, captures live
  sessions, registers listeners before asynchronous recovery, and serves API routes.
  Host injection requires `webServer`, `sessions`, `webRuntime`, and
  `sessionPersistence`.
- `src/usage/collector.ts` samples message/attempt usage, stream fallbacks and
  older standalone chunks. Its state preserves explicit retry boundaries.
- `src/usage/validation.ts` rejects invalid identifiers, dates and numeric buckets
  before a write batch; missing legacy bucket detail remains unclassified.
- `src/usage/durable/schema.ts` defines additive storage schema 3.
- `wrapper.ts` owns SQLite paths, WAL setup, BEGIN IMMEDIATE/savepoints, and backups.
- `durableStore.ts` validates/upserts records, maintains deltas, verifies/repairs all
  aggregate fields, and records verified accounting corrections.
- `durableAggregator.ts` serves indexed aggregate queries and skips unused notifications.
- `migration.ts` imports the v1 JSON ledger as a verified transactional union.
- `sourceDiscovery.ts` reads plugin-owned JSON units and caches successful imports.
- `sessionRecovery.ts` adapts official DSH 0.1/0.2 persistence APIs, verifies recovery
  checkpoints, folds appended events, and closes read handles even on failure.
- `src/usage/health.ts` separates source scan status from historical coverage.
- `src/client/index.tsx`, `settings.tsx`, and `request.ts` render aggregate data,
  reject obsolete requests, and show unavailable/stale/partial states.
- `src/client/loader.ts` exposes only the browser-loader apply/inject contract and
  shared Summary type; internal React types are not required by public consumers.
- The older memory ledger/services remain migration references and legacy tests;
  their version 1 retry semantics are not the active durable host path.

## Authoritative records and derived caches

`usage_records` is the accounting authority. Global, daily, model, and day/model
aggregates are rebuildable caches. Startup compares every bucket/count/key and
provenance field against valid active records, rebuilding only on drift. Invalid
authoritative records stop initialization; a corrupt ledger is never replaced with
an empty one. Derived generation metadata advances with committed writes.

`excluded_reason='fork_inherited'` retains inherited rows but removes their
contribution. `accounting_changes` retains numeric pre-correction metadata and
session before/after totals. `session_recovery` holds validated recovery checkpoints;
`source_discovery_cache` holds successful import fingerprints/diagnostics.

## Attempt identity and totals

The first attempt keeps `sessionId:turn:step`. A `llm/retry-started` boundary creates
`sessionId:turn:step:retry:<boundary-seq>`. Each attempt keeps its highest-sequence
usage sample; failed attempts with provider usage count separately. A final sample
replaces the stream sample within that attempt. Equal-sequence, equal-total records
can fill missing metadata; conflicting equal-sequence totals do not overwrite.

Total is input + cache read + cache write + output. Reasoning is an output subdivision.
Unclassified records remain in lifetime totals; dated ones also contribute to daily
totals. A daily result's total already includes its unknown tokens. Records without
a trustworthy date never enter a fabricated day/model row.

Legacy rows carry accounting version 1. Only a complete validated session replay can
upgrade their identity semantics, with an immutable SQLite snapshot, atomic correction
and audit. A snapshot behind a legacy ledger is rejected. Unreadable or incomplete
history preserves known records. Live samples lacking a complete snapshot remain
provisional version 1; ownership of an unknown fork prefix is never guessed.

## Recovery and lifecycle

DSH 0.1 prefers listSnapshots with list fallback, followed by readFrom; DSH 0.2 uses
list/open('read')/read/close. Official source/revision tokens skip unchanged logs.
Changed logs verify the boundary hash before folding a suffix. Fresh legacy writes
invalidate their session checkpoint; aggregate repairs force full replay. Incremental
commits verify under the write lock that their checkpoint was not invalidated during
an await. Records/checkpoints commit together. Boundary conflicts preserve the ledger.
The append-only source contract is required; JSONL may still parse the full physical
artifact when a changed-source read is necessary.

Recovery yields between sessions (and between 0.2 batches). Live collection continues
while cold scans run. Disposal aborts recovery, unregisters listeners/routes, closes
SQLite, and prevents resumed asynchronous work from writing after unload.

## Transactions and failure reporting

Each batch commits record changes, all aggregate deltas and provenance in one
transaction. Outer writes use BEGIN IMMEDIATE; nested work uses savepoints. WAL with
synchronous=NORMAL protects transactional consistency across process crashes; it
does not promise preservation of every recent commit across a host power failure.

Initialization/failed cutover returns HTTP 503 with health/error. A readable ledger
can serve known usage with partial-source health. Source scan completeness refers
only to enumerated sessions; lifetime coverage remains partial/unknown.

All API methods retain the browser trust fence. Requests are bounded to 64 KiB.
Browser probes have a 15-second headers/body deadline. Stale matching data carries
its last successful timestamp; mismatched range/filter data is hidden.

## Performance and verification

Prepared statements are reused. Summary counts use maintained aggregate calls;
writes do not calculate summaries when there are no subscribers. Date ranges constrain
day/model SQL reads once per request; seven-day output retains empty local days.

Successful JSON imports reuse file-list/device/inode/size/mtime/ctime fingerprints.
Failed scans, changed sources or aggregate repairs force rereads. Initial authoritative
verification and full first recovery still require work proportional to available history.

Build emits self-contained declarations and byte-aligned browser artifacts.
CI runs tests, TS/TSX checking, build, packed NodeNext/Bundler consumers and archive
checks on Node 22/24. Tests use synthetic storage, host services and actual React DOM.
The repaired host/client were also smoke-tested on DSH Desktop 0.2.0-rc.2, including
sidebar/settings rendering, API responses, ledger preservation and aggregate integrity.
The DSH 0.1 adapter has fixture coverage but no fresh manual smoke test for this release.

See [JSON migration](docs/migrations/v1.0.1-to-v1.1.0.md),
[accounting v2 migration](docs/migrations/accounting-v2.md), and
[storage decision](docs/architecture/STORAGE_DECISION.md).
