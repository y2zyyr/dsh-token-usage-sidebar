# dsh-token-usage-sidebar

English | [简体中文](README.zh-CN.md)

A community [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) web-profile plugin that keeps provider-reported token usage locally. It provides both a persistent sidebar summary and a native **Token Usage** settings page.

[![npm version](https://img.shields.io/npm/v/@y2zyyr/dsh-token-usage-sidebar)](https://www.npmjs.com/package/@y2zyyr/dsh-token-usage-sidebar)

```text
TOKEN USAGE
Today       …
Yesterday   …
Total       …
```

This is a community plugin, not an official DeepSeek plugin.

## Features

- Sidebar summary: Today, Yesterday, and lifetime Total.
- Native **Settings → Token Usage** page, placed after Agent Presets and before Plugin Market.
- Compact per-range metric cards for Total, Input, Output, Cache, Reasoning,
  and Calls.
- Detail range selector: Today, Yesterday, 7D, and All time, with the filters
  kept on one compact row in the DSH modal.
- Per-range totals for Input, Output, Cache Read, Cache Write, Reasoning, and call count.
- Dynamic provider/model filters: the choices come from the exact provider and model names present in the selected range; no provider directory or preset supplier list is hard-coded.
- Provider/model filters use the exact names reported by DSH; the plugin does not ask users to configure a second provider-name mapping.
- Compact provider/model table with expandable bucket details, plus a seven-local-day table that retains zero-value days.
- Persistent local accounting that survives DSH restarts.
- **Scalable durable ledger (v1.1).** The lifetime accounting store is backed by a
  plugin-owned SQLite database (Node's built-in `node:sqlite`, WAL journal) instead
  of a monolithic JSON root. A new invocation is one small row-level upsert, so write
  latency stays effectively flat no matter how many historical records accumulate.
- **Automatic verified migration (v1.1).** Existing v1.0.1 totals are migrated into the
  new ledger automatically, verified for exact equivalence (lifetime total, record
  count, per-day and provider/model), and only then cut over. No totals are lost or
  double-counted, and a backup of the v1 ledger is made before cutover.
- Shutdown-safe persistence: dirty usage is flushed before the store closes, so
  a usage event followed by a quick DSH restart is not lost.
- Historical recovery from available authoritative session usage records, with
  honest scan/coverage reporting (a partial or failed scan never claims complete
  lifetime coverage).
- Replay-safe, deduplicated accounting: an invocation is counted once.
- Native placement in the DSH web sidebar.

![Token Usage settings page](docs/screenshots/token-usage-settings-en-v1.1.5.png)

## Installation

Recommended package: `@y2zyyr/dsh-token-usage-sidebar` (published on the npm registry).

### Recommended — DeepSeek Harness

Install the plugin into the DSH `web` profile, then restart DSH:

```bash
dsh plugin --profile web add @y2zyyr/dsh-token-usage-sidebar
# Restart `dsh web` after installation.
```

`dsh plugin` accepts the scoped package name directly; the plugin is added to the
profile's bundle list and its loader entry keeps the stable id `token-usage-sidebar`.
You can also ask an agent that can access your DSH installation to install the npm
package `@y2zyyr/dsh-token-usage-sidebar` into the web profile (source: https://github.com/y2zyyr/dsh-token-usage-sidebar). Review
third-party source before authorizing an agent to install it. Pin a commit when your
workflow requires a reproducible dependency revision.

### npm

The package can be installed from npm directly:

```bash
npm install @y2zyyr/dsh-token-usage-sidebar
```

### Source

GitHub is the source repository (code, issues, release history, source inspection):
https://github.com/y2zyyr/dsh-token-usage-sidebar

A direct GitHub install also keeps working
(`dsh plugin --profile web add github:y2zyyr/dsh-token-usage-sidebar`), but the npm
scoped package is the recommended distribution channel.

## Update

Update the installed plugin, then restart DSH:

```bash
dsh plugin --profile web update @y2zyyr/dsh-token-usage-sidebar
# Restart `dsh web` after updating.
```

The plugin is versioned on npm with semantic versions.

## Removal

Removing the plugin does not reset its separately persisted local accounting data.

```bash
dsh plugin --profile web remove @y2zyyr/dsh-token-usage-sidebar
# Restart `dsh web` after removal.
```

### Upgrading from a v1.1.0 GitHub install

Existing v1.1.0 installs keep their complete ledger. Switch the profile bundle
from the old package name to the scoped one — the plugin keeps the same loader
entry ID, exported plugin name, client module ID, and SQLite ledger path, so no
data migration is needed:

```bash
dsh plugin --profile web remove dsh-token-usage-sidebar
dsh plugin --profile web add @y2zyyr/dsh-token-usage-sidebar
# Restart `dsh web` after the switch.
```

## How it works

```text
DSH/provider usage records
        ↓
historical and live collection
        ↓
deduplication
        ↓
persistent local accounting
        ↓
sidebar summary
```

The plugin uses provider/runtime-reported usage records rather than tokenizer estimates. Total is `input + cache read + cache write + output`; **Reasoning** is displayed as an output subdivision and is never added to Total a second time. It uses the final committed assistant message's `message.source.provider` and `message.source.model` when available.

All day-based ranges use the DSH host's local calendar days. Last 7 days includes today plus the previous six local days. The settings page receives aggregate results only; it never receives the individual invocation ledger.

### Provider and model filtering

Provider options are discovered from the aggregate data in the selected range and are matched exactly. A user whose ledger only contains `my-company-api` sees that name; an empty preset-provider option is never added. Different spellings remain separate, and there is no separate alias form to fill in. Any legacy alias table left by an older release is retained for storage compatibility but is not exposed in the settings UI.

### Migration and historical coverage

The plugin also performs a narrow automatic discovery pass in the DSH
`storages` directory. It recognizes plugin-owned token record units, including
partitioned day ledgers from earlier local builds, and imports their invocation
details by the canonical `sessionId:turn:step` identity. Aggregate-only
summaries are used for verification and are never imported as extra calls.
Discovery is read-only against its sources and idempotent across restarts; it
does not scan the general filesystem or require a manually configured path.

v1.0.0/v1.0.1 performs one idempotent replay of recoverable persistent DSH session events to enrich existing calls with their exact buckets and model metadata. A previously recorded call is only enriched, or replaced by a higher-sequence final message: it is not added to lifetime usage again.

Some legacy calls may have a reliable All time total but no recoverable date, bucket, provider, or model. Those tokens remain included in All time and are explicitly shown as **unclassified coverage**. They are never invented into a date or model row.

**History reporting is honest (v1.0.1).** The plugin keeps two distinct signals:

- **Source scan status** — whether every session the plugin could enumerate was read successfully (complete / partial / failed / unknown). Any session that fails to read downgrades the scan to partial; it can never claim complete.
- **Historical coverage** — whether we can assert that the recovered records represent the plugin's full lifetime history (complete / partial / unknown). Because enumerating today's session logs does not prove there are no older, deleted, or out-of-window sessions, coverage almost always remains partial (or unknown when nothing is recoverable). The plugin never labels a scan as complete simply because some sessions were found.

**Total's meaning:** Lifetime **Total** is the deduplicated union of every authoritative usage record the plugin recovered from durable sources plus usage recorded after tracking began — it reflects what the plugin can recover, not a claim about the DSH account's full lifetime usage when not all history is provably recoverable.

### v1.0.1 → v1.1 upgrade migration

On first startup after upgrading to v1.1, the plugin detects the v1.0.1 JSON ledger and:

1. **Validates** the legacy ledger read-only (never modifies it).
2. **Backs up** the v1 ledger to a timestamped, immutable `.pre-v1.1-<timestamp>.bak`
   file in the same data directory.
3. **Creates/opens** the v1.1 SQLite ledger and inserts the canonical records.
4. **Derives** all aggregate tables (global, daily, provider/model) from the records.
5. **Verifies** exact accounting equivalence (lifetime total, record count, and
   `sum(records) == global`).
6. **Cutover** — only if verification passes. Any mismatch marks the migration
   **failed**, no cutover happens, and the v1 source is left untouched.

The migration is **idempotent**: a completed migration is a no-op on later restarts,
and no records are duplicated. New usage recorded after cutover is exactly-once.

See `docs/migrations/v1.0.1-to-v1.1.0.md` for the full design.

## Data & Privacy

Usage accounting stays local to the DSH runtime. The source repository does not receive, contain, or upload a user's token ledger. Runtime persistence is separate from the source code and release artifacts.

The plugin stores accounting metadata needed for reliable totals, such as deduplication identity, date bucket, and token totals. It does not persist prompts, assistant text, tool output, API keys, credentials, or conversation content as part of its ledger.

### Where v1.1 stores data (v1.1)

- **Local only.** All persistent data lives under the DSH data home. Nothing is uploaded.
- **SQLite ledger.** v1.1 stores the accounting ledger in a plugin-owned SQLite database:
  `${DSH_HOME:-~/.dsh}/storages/dsh_token_usage_sidebar.sqlite`, plus its WAL/shm
  companions. The exact path respects the `DSH_HOME` environment variable when set.
  It is never the source repo or the package install directory, so it survives
  upgrades, re-installs, and restarts.
- **No conversation contents.** The DB holds only deduplication ids (`sessionId:turn:step`),
  token bucket totals, provider/model labels, local dates, and accounting metadata.
  It never stores prompts, assistant text, tool output, API keys, credentials, or
  conversation content.
- **Legacy alias compatibility.** If an older release created provider-alias rows, they remain in the plugin-owned database during upgrade; the current UI does not ask users to maintain a second provider-name mapping, and accounting records are never deleted or rewritten.
- **Upgrade backup.** Before cutover the v1.0.1 JSON ledger is copied to a timestamped
  `.pre-v1.1-<timestamp>.bak` file in the same directory. The v1 source is never deleted.
- **Uninstall.** Removing the plugin does not delete this data.
- **Downgrade to v1.0.1.** The v1.1 SQLite ledger is not read by v1.0.1. To return to
  v1.0.1, restore the pre-upgrade v1 JSON backup (or the untouched v1 source) after
  reinstalling v1.0.1.

## Compatibility and Status

Current release: **v1.1.5** (npm package `@y2zyyr/dsh-token-usage-sidebar`; source on GitHub).

Verified with DeepSeek Harness `0.1.0-rc.6` and its `web` profile, on a runtime whose
Node.js provides the built-in `node:sqlite` module (Node with `node:sqlite`).
No broader DSH-version or operating-system compatibility is claimed. Running against
later desktop builds (e.g. DSH Desktop 2.0.0 / Node 26) has been observed locally but
is not formally claimed.

### Reliability guarantees (v1.1)

- **Flat write latency.** A new invocation is one small row-level SQLite upsert in WAL
  mode, independent of lifetime history size. Summary reads come from maintained
  aggregate tables, not a scan of the full record set.
- **Exactly-once accounting.** Canonical identity is `sessionId:turn:step`; the final
  committed `assistant/message.usage` supersedes an earlier `assistant/chunk` sample, and
  replays/duplicates never double-count (higher-seq wins).
- **Source of truth = records.** `usage_records` is authoritative; aggregate tables are a
  derived, rebuildable cache. If an aggregate drifts, it is rebuilt from records.
- **Verified migration.** v1.0.1 totals are migrated and verified for exact equivalence
  before cutover; a mismatch fails closed and keeps the v1 source intact.
- **Crash-safe migration.** The v1 source is only ever read/copied; a partial or failed
  migration never leaves unverified records visible and resumes cleanly.
- **No lost writes on shutdown.** Dirty usage is flushed and the SQLite ledger is
  committed/checkpointed before the store closes.

### Reliability guarantees (v1.0.1)

- **No lost writes on shutdown.** Dirty usage is flushed before the store closes; the persistence write is serialized so concurrent saves never race or reorder, and a transient write failure keeps the data recoverable for a later flush or close.
- **No silent reset on corrupt storage.** If the persisted ledger fails validation, the plugin warns, does not overwrite the corrupt source, and never presents a silent new Total of zero.
- **Source-scan invariants.** The live/historical split is recomputed from the authoritative records so lifetimeTotal = live + historical always holds.
- **Honest history reporting.** See *Migration and historical coverage*; a partial or failed scan is never mislabeled complete.

## Development

```bash
npm install
npm test
npm run build
npx tsc --noEmit   # typecheck (v1.1 adds this gate)
```

`npm test` runs the accounting, historical-recovery, insights, durable SQLite, migration,
and property/equivalence tests. `npm run build` writes the shipped host and browser
bundles to `lib/` and keeps the root-compatibility `client.js` byte-aligned. GitHub
Actions CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm test`, `npm run build`, and
a `git diff --exit-code` so committed artifacts must always match source.

## License

[MIT](LICENSE)
