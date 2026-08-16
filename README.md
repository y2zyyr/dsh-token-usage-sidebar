# dsh-token-usage-sidebar

English | [简体中文](README.zh-CN.md)

A community [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) web-profile plugin that keeps provider-reported token usage locally. It provides both a persistent sidebar summary and a native **Token Usage** settings page.

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
- Four overview cards: All time, Today, Yesterday, and Last 7 days.
- Detail range selector: Today, Yesterday, 7D, and All time.
- Per-range totals for Input, Output, Cache Read, Cache Write, Reasoning, and call count.
- Provider/model table, sorted by Total, plus a seven-local-day table that retains zero-value days.
- Persistent local accounting that survives DSH restarts.
- Shutdown-safe persistence: dirty usage is flushed before the store closes, so
  a usage event followed by a quick DSH restart is not lost.
- Historical recovery from available authoritative session usage records, with
  honest scan/coverage reporting (a partial or failed scan never claims complete
  lifetime coverage).
- Replay-safe, deduplicated accounting: an invocation is counted once.
- Native placement in the DSH web sidebar.

![Token Usage settings page](docs/screenshots/token-usage-settings-en-v1.0.0.jpeg)

## Installation

### Ask your agent (recommended)

Copy this message into an agent that can access your DSH installation:

```text
Please follow https://github.com/y2zyyr/dsh-token-usage-sidebar to install this plugin into DeepSeek Harness's web profile.
```

Review third-party source before authorizing an agent to install it. Pin a commit when your workflow requires a reproducible dependency revision.

### Manual installation

Install from GitHub into the DSH `web` profile, then restart DSH:

```bash
dsh plugin --profile web add github:y2zyyr/dsh-token-usage-sidebar
# Restart `dsh web` after installation.
```

## Update

Update the installed plugin, then restart DSH:

```bash
dsh plugin --profile web update dsh-token-usage-sidebar
# Restart `dsh web` after updating.
```

## Removal

```bash
dsh plugin --profile web remove dsh-token-usage-sidebar
# Restart `dsh web` after removal.
```

Removing the plugin does not reset its separately persisted local accounting data.

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

### Migration and historical coverage

v1.0.0/v1.0.1 performs one idempotent replay of recoverable persistent DSH session events to enrich existing calls with their exact buckets and model metadata. A previously recorded call is only enriched, or replaced by a higher-sequence final message: it is not added to lifetime usage again.

Some legacy calls may have a reliable All time total but no recoverable date, bucket, provider, or model. Those tokens remain included in All time and are explicitly shown as **unclassified coverage**. They are never invented into a date or model row.

**History reporting is honest (v1.0.1).** The plugin keeps two distinct signals:

- **Source scan status** — whether every session the plugin could enumerate was read successfully (complete / partial / failed / unknown). Any session that fails to read downgrades the scan to partial; it can never claim complete.
- **Historical coverage** — whether we can assert that the recovered records represent the plugin's full lifetime history (complete / partial / unknown). Because enumerating today's session logs does not prove there are no older, deleted, or out-of-window sessions, coverage almost always remains partial (or unknown when nothing is recoverable). The plugin never labels a scan as complete simply because some sessions were found.

**Total's meaning:** Lifetime **Total** is the deduplicated union of every authoritative usage record the plugin recovered from durable sources plus usage recorded after tracking began — it reflects what the plugin can recover, not a claim about the DSH account's full lifetime usage when not all history is provably recoverable.

## Data & Privacy

Usage accounting stays local to the DSH runtime. The source repository does not receive, contain, or upload a user's token ledger. Runtime persistence is separate from the source code and release artifacts.

The plugin stores accounting metadata needed for reliable totals, such as deduplication identity, date bucket, and token totals. It does not persist prompts, assistant text, tool output, API keys, credentials, or conversation content as part of its ledger.

## Compatibility and Status

Current release: v1.0.1.

Verified with DeepSeek Harness `0.1.0-rc.6` and its `web` profile. No broader DSH-version or operating-system compatibility is claimed. Running against later desktop builds (e.g. DSH Desktop 2.0.0) has been observed locally but is not formally claimed.

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
```

`npm test` runs the accounting, historical-recovery, and insights tests. `npm run build` writes the shipped host and browser bundles to `lib/` and keeps the root-compatibility `client.js` byte-aligned. GitHub Actions CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm test`, `npm run build`, and a `git diff --exit-code` so committed artifacts must always match source.

## License

[MIT](LICENSE)
