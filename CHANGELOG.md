# Changelog

All notable changes to this project are documented here.

## Unreleased

### Accounting and recovery
- Add accounting version 2: read DSH 0.2 attempt usage and stream fallbacks, preserve
  explicit retry boundaries across live events and restart checkpoints, and exclude
  fork-inherited events from child accounting.
- Correct legacy attempt identities only after a complete validated source replay,
  keeping an immutable SQLite backup and numeric before/after audit. Unverifiable
  legacy history remains counted; inherited rows are retained with an exclusion flag.
- Recover cold sessions through the official DSH 0.1/0.2 `sessionPersistence` APIs.
  Verify checkpoints before folding appended events and always close read handles.
- Prefer lightweight source revisions to skip unchanged logs; invalidate checkpoints
  on new legacy records or aggregate repair and refuse stale asynchronous commits.
- Preserve provisional live samples when snapshots fail, then reconcile after a
  complete snapshot becomes readable; unknown fork ownership is never guessed.
- Make JSON migration a verified union with existing SQLite history. Failed imports
  roll back overwritten rows, aggregates, and metadata together.
- Reject negative, fractional, non-finite, unsafe, or missing token totals before
  writes. Startup checks every aggregate field and repairs caches from valid records.
- Keep dated unclassified tokens consistent across writes/rebuilds. Daily totals
  include them once, and unfiltered seven-day results retain all seven local dates.

### Performance and presentation
- Cache prepared statements; use aggregate call counts for summaries; skip subscriber
  notifications when none exist. Query day/model aggregates once within indexed dates.
- Match inherited fork identities through a lookup map rather than nested row scans.
- Cache successful legacy JSON imports using file identity/size/mtime/ctime metadata.
  Changed files, failed scans, and aggregate repairs invalidate reuse.
- Return explicit initialization/recovery errors instead of successful zero totals;
  include source scan, partial coverage, and accounting adjustment diagnostics.
- Abort obsolete browser probes, bound headers and body reads with a deadline, retain
  matching stale data with a timestamp, and hide mismatched range/filter data.
- Localize sidebar labels and expose partial-history and verified adjustment notices.

### Validation and packaging
- Type-check TSX and emit packaged declarations with resolvable sibling imports.
  The public browser-loader contract avoids internal React type dependencies.
- Add synthetic integrity, host-route, React DOM, checkpoint, and cache regressions;
  audit the npm archive and compile external NodeNext/Bundler type consumers in CI.
- Update the development esbuild dependency and document migration/rollback behavior.

These changes have not been published. Real DSH boot/UI smoke testing remains
unverified; automated adapters follow the inspected official persistence contracts.

## 1.1.8 — 2026-09-29

### Official DSH 0.2 runtime compatibility
- Read existing session history through DSH 0.2's `snapshotEvents()` API, while
  retaining support for older hosts that expose an `events` array.
- Keep per-session history reads isolated so one unavailable session does not
  prevent the plugin from starting or collecting live `session/event` updates.

## 1.1.7 — 2026-09-29

### DSH 0.2 compatibility
- Removed the unused `@deepseek-ai/dsh-storage-domain` host peer. The plugin owns its
  SQLite ledger and does not import or call that package, so DSH 0.2.0-rc.2 no longer
  fails installation because it provides storage-domain 0.2.0-rc.2 instead of 0.1.0-rc.6.
- Widened the Cordis peer range to `^4.0.1`, covering the 4.0.4 runtime used by DSH
  0.2.0-rc.2 while retaining compatibility with the previously tested 4.0.1 host.
- No token accounting, storage, or runtime behavior changed.

## 1.1.6 — 2026-08-29

### Packaging compatibility
- Moved DSH-provided `@deepseek-ai/*` host packages from production
  `dependencies` to exact `peerDependencies`, while retaining them as
  development-only packages for local type checking.
- This prevents an install from unnecessarily bringing a second copy of the
  DSH host runtime into the plugin dependency tree.

## 1.1.5 — 2026-08-29

### Recovery and compatibility
- Discovers plugin-owned token record-table units in the DSH `storages`
  directory, including partitioned day ledgers written by earlier local builds.
- Imports invocation records by canonical `sessionId:turn:step` identity and
  keeps the highest sequence for a replay, so an aggregate summary is never
  counted as a second set of calls.
- Verifies an available aggregate companion against the discovered detail
  records and exposes source status in the local debug endpoint. Existing
  source files remain read-only; discovery is idempotent across restarts.

### Settings UX
- Removed the manual provider-alias configuration panel from the Token Usage
  settings page. Provider filters now expose the exact names reported by DSH,
  without asking users to enter the same provider identity a second time.
- Existing alias rows remain untouched in the local database for backward
  compatibility; no token records are deleted or rewritten.
- Tightened the overview and detail metric cards so the settings page uses the
  narrow DSH modal more efficiently.
- Kept the provider filter, model filter, and clear-filters action on one
  compact row in the DSH modal, with a narrow-screen fallback.
- Removed the redundant explanatory subtitle and duplicate four-card summary
  from the Token Usage settings page; the detailed range view is now the
  primary content.

## 1.1.4 — 2026-08-29

### Documentation
- Corrected the current-release version shown in the English and Simplified
  Chinese README files.

## 1.1.3 — 2026-08-29

### Filtering and local identity mappings
- Added dynamic provider and model filters whose options come from the exact raw
  names present in the selected range; no preset provider directory is injected.
- Added local provider alias groups backed by the plugin-owned SQLite ledger.
  Aliases affect only query/display grouping; raw provider values and accounting
  records remain unchanged.
- Added expandable provider/model bucket details and raw-provider breakdowns for
  auditable merged totals.
- Added validation preventing one raw provider from belonging to multiple alias
  groups at the same time.
- Added regression coverage for dynamic facets, exact matching, alias CRUD,
  migration persistence, and backward-compatible aggregate queries.

## 1.1.2 — 2026-08-19

### Distribution
- Widened `@deepseek-ai/dsh-storage-domain` to `^0.1.0-rc.6` so the published
  package passes the DSH Desktop plugin-market verifier (which targets runtime
  0.1.0-rc.7) and the 插件市场 shows the direct install button.
- No behavior or storage changes; accounting semantics unchanged.

## 1.1.1 — 2026-08-17

### Distribution
- Published to the npm registry as a scoped package: @y2zyyr/dsh-token-usage-sidebar.
  Install and update discovery now use the npm registry; the GitHub repository
  remains the source of code, README, issues, Git tags, and GitHub Releases.
- Runtime identity is unchanged by the rename: the Cordis loader entry ID
  (token-usage-sidebar), the exported plugin name, the client module ID, the
  settings namespace, the /token-usage/api/* routes, and the persistent
  SQLite ledger path (~/.dsh/storages/dsh_token_usage_sidebar.sqlite) are all
  stable, so existing v1.1.0 installs keep their full history when they switch
  the profile bundle from dsh-token-usage-sidebar to @y2zyyr/dsh-token-usage-sidebar (remove old,
  add new; no data migration required).
- Added publishConfig.access = public for the scoped package; no production
  code or storage semantics changed.

## 1.1.0 — 2026-08-16

### Storage architecture
- **Replaced the monolithic root-JSON ledger with a plugin-owned SQLite durable ledger.
  The v1.0.1 ledger kept all accounting state in one JSON object that was copied,
  serialized, and rewritten on every invocation, making per-write cost O(N) in history
  size. v1.1 uses a SQLite database (Node's built-in `node:sqlite`, WAL journal) so a new
  invocation is one small row-level upsert and write latency stays effectively flat as
  history grows (measured flat from 1k to 500k records).
- `usage_records` is the authoritative source of truth; `aggregate_global` /
  `aggregate_daily` / `aggregate_model` / `aggregate_day_model` are derived, rebuildable
  caches. Any aggregate drift is healed by rebuilding from records.
- Recording and aggregate-delta maintenance happen in one SQLite transaction per batch
  (subtract old row, add new row) so a chunk→final replacement adjusts aggregates by the
  difference, never by the full value again.

### Migration (v1.0.1 → v1.1)
- Automatic, on first startup: detect v1 JSON ledger → read-only validate → immutable
  timestamped backup → create/open SQLite → insert canonical records → derive
  aggregates → **verify exact equivalence** (`lifetimeTotal`, `recordCount`, and
  `sum(records) == global`) → cutover only on success.
- Idempotent (a completed migration is a no-op on restart), crash-safe (v1 is only
  read/copied; a partial or failed migration never exposes unverified records and never
  deletes the v1 source), and fail-closed (any verification mismatch = `failed`, no
  cutover).
- Live usage collection does not start until migration/cutover completes, so no live
  event can race the cutover.

### Performance
- Same architecture benchmark as v1.0.1 reproduced, plus SQLite benchmarks at 1k / 10k /
  50k / 100k / 500k (see report): single durable upsert is sub-millisecond and flat,
  summary/7D/provider-model reads come from maintained aggregates instead of a full-row
  scan.

### Reliability
- No silent reset on corrupt persistent data: if authoritative `usage_records` storage is
  corrupt the plugin does not reset totals to zero; it warns and preserves files.
- Corrupt aggregate tables are detected and rebuilt from valid records.
- Shutdown flushes pending writes and checkpoint/closes the SQLite ledger; a usage event
  inside the debounce window is not lost.

### Compatibility
- Requires a DSH runtime whose Node provides the built-in `node:sqlite` module
  (Node ≥ 22.13), consistent with the engine floor already used by the plugin. No native
  third-party SQLite dependency is added.
- v1.0.1's durable JSON ledger remains supported as the migration *source*; it is no
  longer the live store after upgrading.

### Documentation
- Added `docs/migrations/v1.0.1-to-v1.1.0.md` and `ARCHITECTURE.md`; documented the
  storage decision and the explicitly rejected chunked-JSON-units alternative in
  `docs/architecture/STORAGE_DECISION.md`; updated README/README.zh-CN and the data
  location / upgrade / downgrade guidance.

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
