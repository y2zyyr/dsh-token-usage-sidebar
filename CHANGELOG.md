# Changelog

All notable changes to this project are documented here.

## 1.0.0 — 2026-08-16

- Added a native bilingual **Token Usage** settings page with All time, Today, Yesterday, and Last 7 days overview cards.
- Added Today, Yesterday, 7D, and All time detail ranges, exact token categories, call counts, provider/model aggregation, and a zero-filled seven-local-day table.
- Added the fenced aggregate-only details API; individual ledger entries never leave the DSH runtime.
- Upgraded the durable ledger with exact per-call token buckets and provider/model metadata.
- Added an idempotent historical v1.0 migration. Recoverable calls are enriched or replaced by newer final messages without lifetime inflation; unrecoverable legacy totals remain explicitly unclassified.
- Kept the lightweight sidebar summary API and existing deduplication/persistence behavior compatible with earlier releases.
