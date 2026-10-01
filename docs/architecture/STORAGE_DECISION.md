# dsh-token-usage-sidebar — v1.1.0 Storage Architecture Decision

Status: ACCEPTED for v1.1.0; unreleased integrity/query update after v1.1.8
Date: 2026-08-16

## Problem
v1.0.1 keeps the entire accounting state in one root JSON ledger
(~/.dsh/storages/dsh_token_usage_sidebar.json, key tables.ledger.root). Every new
invocation copies + serializes + rewrites the ENTIRE history: measured 50k-fold =
88.9s, single recordUsage 3188us (Node 26). Per-write cost is O(N).

## DSH storage audit (verified in installed source)
dsh-storage-json republishes the WHOLE unit file (serialize all rows + fsync +
rename) on every putRecord. So row-level keys inside one JSON unit are STILL O(N)
per write; no key design removes the whole-file rewrite.

## Options considered
- A) row-level JSON domain-KV: whole-unit rewrite per write; still O(N); no multi-row tx. REJECTED.
- B) chunked domain-KV / per-day JSON units (a competing implementation was built and
  proposed for v1.1): split records across per-day JSON units. REJECTED for these reasons:
  1. **Unit-level full rewrite.** Each DSH JSON unit is still rewritten in full on every
     update; sharding by day only narrows the rewrite scope to one file, not to one row.
  2. **Within-day growth.** All of a single high-volume day still lives in one unit, so a
     busy day regresses to O(N) writes within that day's file.
  3. **Multi-unit routing complexity.** A canonical id must be routed to the correct day
     unit; reads/writes that span days must fan out and reconcile — a real correctness
     and maintenance surface.
  4. **Aggregate consistency.** Totals derived by summing units require coordinated
     updates across units; a crash between units could desynchronize them with no
     transactional guarantee (DSH JSON offers no multi-row transaction).
  5. **Migration complexity.** Indexing/routing existing records into shards adds
     migration machinery that the row-store approach avoids entirely.
Per-day JSON performs the same whole-file rewrite and adds routing and
  consistency complexity, while still degrading within a single hot day. It was
  therefore rejected.
- C) plugin-owned SQLite via node:sqlite (WAL): row-level writes touch only changed
  pages; true transactions; built into Node (no dep, no native build); verified flat
  up to 500k rows. ACCEPTED.

## Measured evidence (node:sqlite POC)
rows -> single upsert / total SUM / day SUM
1k    -> 0.003ms / 0.05ms / 0.08ms
50k   -> 0.002ms / 1.90ms / 3.02ms
100k  -> 0.003ms / 4.34ms / 6.55ms
500k  -> 0.002ms / 19.26ms / 33.17ms
These original measurements are a small SQLite POC, not end-to-end plugin timings.
They show row-level storage avoiding the whole-JSON rewrite.

## Unreleased end-to-end/query verification

Synthetic Node 26.4 measurements for the repaired durable path:

| Data size | Store single write | Aggregator single write | Summary |
| --- | ---: | ---: | ---: |
| 1k usage records | 0.126 ms | 0.092 ms | 0.012 ms |
| 100k usage records | 0.085 ms | 0.083 ms | 0.010 ms |

With 100k date/model aggregate rows, a seven-local-day query went from 244.57 ms
in v1.1.8 to 2.25 ms in the repaired path. It performs zero full day/model reads;
EXPLAIN confirms a date-range index search. The fixture uses 200 models per day,
so the selected range contains at most 1,400 rows. These are local synthetic results,
not hardware-independent latency guarantees.

## Chosen model
- usage_records = authoritative source of truth (canonical_id PK identifies an attempt;
  the first keeps sessionId:turn:step and explicit retries append a boundary-seq suffix).
- aggregate_global / aggregate_daily / aggregate_model / aggregate_day_model = derived rebuildable cache.
- meta: storage_schema_version, migration_version, record_generation, aggregate_generation, migration_status.
- Every record batch commits records + aggregate deltas in ONE transaction (subtract-old, add-new).
- Startup verifies all record-derived aggregate fields/provenance, with a rebuild only
  on drift. Invalid authoritative records prevent initialization. First verification
  remains O(history), while normal summary/write paths avoid full-record scans.
- Indexed date constraints avoid full day/model materialization for short ranges.
- Successful JSON imports, official source revisions and persisted session checkpoints
  avoid unchanged parsing/refolding. Changed JSONL reads may still scan the physical
  artifact internally. Legacy imports and repairs invalidate session checkpoints.
- Schema 3 adds accounting version/exclusions, numeric correction audits, session
  checkpoints, and successful source-discovery cache metadata.
- Records retained indefinitely (no auto-delete).

## Migration strategy
detect v1 -> read-only validate -> backup (timestamped, immutable) -> create DB ->
insert canonical records (upsert) -> rebuild aggregates -> verify (lifetimeTotal, recordCount,
the imported union and every aggregate field) -> commit migration_status='done' -> switch reads.
Existing unrelated/newer destination records are retained. Any verification failure
rolls back rows, aggregates and transaction metadata before setting status='failed';
the v1 source stays untouched. Idempotent and process-crash safe.

Accounting v2 correction separately requires a complete source replay, an immutable
SQLite backup and a transactional before/after audit. Inherited fork rows are excluded
rather than deleted. See [the accounting migration](../migrations/accounting-v2.md).

## node:sqlite feasibility across matrix
Node 22.13.0 / 22.19.0 / 24.0.0 import node:sqlite + CRUD + WAL + tx without a flag
(in-memory WAL / on-disk WAL verified). DSK engines floor ^22.19.0 || >=24.0.0; CI matrix 22/24. OK.
