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
- Historical recovery from available authoritative session usage records.
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

v1.0.0 performs one idempotent replay of recoverable persistent DSH session events to enrich existing calls with their exact buckets and model metadata. A previously recorded call is only enriched, or replaced by a higher-sequence final message: it is not added to lifetime usage again.

Some legacy calls may have a reliable All time total but no recoverable date, bucket, provider, or model. Those tokens remain included in All time and are explicitly shown as **unclassified coverage**. They are never invented into a date or model row.

## Data & Privacy

Usage accounting stays local to the DSH runtime. The source repository does not receive, contain, or upload a user's token ledger. Runtime persistence is separate from the source code and release artifacts.

The plugin stores accounting metadata needed for reliable totals, such as deduplication identity, date bucket, and token totals. It does not persist prompts, assistant text, tool output, API keys, credentials, or conversation content as part of its ledger.

## Compatibility and Status

Current release: v1.0.0.

Verified with DeepSeek Harness `0.1.0-rc.6` and its `web` profile. No broader DSH-version or operating-system compatibility is claimed.

## Development

```bash
npm install
npm test
npm run build
```

`npm test` runs the accounting and historical-recovery tests. `npm run build` writes the shipped host and browser bundles to `lib/`.

## License

[MIT](LICENSE)
