# Changelog

All notable changes to this project are documented here.

## 1.0.1 — 2026-08-16

### Fixed
- **Shutdown persistence loss (P0).** `close()` no longer marks the aggregator closed before flushing, so a usage event inside the debounce window is persisted before shutdown instead of being silently dropped. Persistence writes are now serialized on a single save chain, preventing concurrent `store.save()` calls and guaranteeing an older ledger snapshot can never overwrite a newer one. Multiple `close()` calls are idempotent; a transient save failure keeps the ledger dirty so a later flush or close retries and does not lose the write.
- **Historical scan over-claiming completeness.** Recovery no longer reports `complete` simply because some sessions were found. A new `sourceScanStatus` (`complete`/`partial`/`failed`/`unknown`) tracks scan mechanics, and `recoveryStatus` now reflects lifetime coverage, which stays `partial` (or `unknown`) whenever full coverage cannot be proven. Failed session reads are counted, never silently swallowed as success.
- **No silent zero reset on corrupt storage (P0 hardening).** A persisted ledger that fails validation is now reported as `invalid`, triggers a clear warning, never overwrites the corrupt source, and never silently resets lifetime Total to zero.

### Added
- Regression tests for shutdown/close semantics: immediate-close persistence, multiple-close safety, concurrent flush+close, and save-failure recovery.
- Historical scan-status tests: partial scan, empty source, enumeration failure, and coverage-complete gating on a proven tracking window.
- Ledger consistency-invariant tests (`recordCount === byId.size`, `lifetimeTotal === sum(byId)`, additive live/historical split) plus a `recomputeSourceSplit` self-heal for stale cached split fields.
- Invalid-store load-outcome tests.
- A reproducible ledger scalability benchmark (`scripts/bench.mjs`).
- GitHub Actions CI (`.github/workflows/ci.yml`): `npm ci`, `npm test`, `npm run build`, and `git diff --exit-code` to keep committed artifacts reproducible.

### Changed
- `RecoveryMetadata` gains `sourceScanStatus`, `sessionsDiscovered`, `sessionsReadSuccessfully`, `sessionsReadFailed` for diagnostics.
- Aggregator diagnostics now expose `loadStatus` (`none`/`ok`/`invalid`), and the historical migration recomputes the live/historical split from authoritative records.
- Hardened the legacy sidebar fallback predicate: it now requires sidebar ancestry plus an aria-label keyword rather than matching any button that merely contains a `<span>`, avoiding mis-mounts.

### Docs
- Clarified EN/ZH: history reporting honesty, Total semantics, shutdown reliability, corrupt-storage behavior, and CI.

## 1.0.0 — 2026-08-16

- Added a native bilingual **Token Usage** settings page with All time, Today, Yesterday, and Last 7 days overview cards.
- Added Today, Yesterday, 7D, and All time detail ranges, exact token categories, call counts, provider/model aggregation, and a zero-filled seven-local-day table.
- Added the fenced aggregate-only details API; individual ledger entries never leave the DSH runtime.
- Upgraded the durable ledger with exact per-call token buckets and provider/model metadata.
- Added an idempotent historical v1.0 migration. Recoverable calls are enriched or replaced by newer final messages without lifetime inflation; unrecoverable legacy totals remain explicitly unclassified.
- Kept the lightweight sidebar summary API and existing deduplication/persistence behavior compatible with earlier releases.
