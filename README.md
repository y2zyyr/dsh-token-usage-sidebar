# dsh-token-usage-sidebar

A community [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) web-profile plugin that shows persistent **Today / Yesterday / Total** provider-reported token usage directly in the sidebar.

```
DeepSeek Logo
  ↓
  TOKEN USAGE
  Today            …
  Yesterday        …
  Total            …
  ↓
+ New Conversation
```

## Install

Install from GitHub into the DSH `web` profile, then restart DSH:

```bash
dsh plugin --profile web add github:y2zyyr/dsh-token-usage-sidebar
# Restart `dsh web` after installation.
```

The install command uses DSH's profile plugin manager. Review third-party source before installing, and pin a commit in production workflows where reproducibility matters.

## Configuration

None in v0.2.1 (the component is always on when the plugin loads). No settings page or card is added. Future options (enable toggle, Show Session/Cost/Cache ratio, reset) belong in DSH settings.

## How it works

- Usage comes from DSH/provider-reported records, never a tokenizer estimate.
- Accounting is persisted locally, so restarting DSH does not reset totals.
- Historical session usage is recovered when authoritative records are available.
- Replay and duplicate delivery are deduplicated, so an invocation is counted exactly once.
- Today and Yesterday use the host machine's local calendar-day buckets.

## Data source (authoritative)

Usage comes from **durable session-log events** produced by the model/provider runtimes:

- `assistant/message .data.usage` — the final authoritative `TokenUsage` for a committed `(turn, step)`; the count a sidebar should prefer.
- `assistant/chunk (chunk.type === 'usage')` — an early stream sample for the same `(turn, step)`.

`TokenUsage = { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }` are **disjoint** buckets. The displayed total is the provider-authoritative sum **`total = input + cacheRead + cacheWrite + output`**; `reasoningTokens` is an *output subdivision* and is deliberately not added again (matches @deepseek-ai/dsh-token-meter). Partial streamed text is never counted; only the authoritative usage event after a completed submission is recorded.

## Exactly-once accounting

One model invocation contributes exactly once. The dedup identity is `(sessionId, turn, step)`. Replaying a session log, re-delivering an event, or a retried request for the same `(turn, step)` **replaces** that invocation's total (higher `seq` wins) instead of adding again. The projection framework drives every committed session event exactly once per seq, so the fold is idempotent by construction.

## Persistence

The process-global ledger (lifetime/today/byId plus per-record local day and highest seq) is stored through DSH's domain-KV facility (`ctx.storageDomain`) and written to `~/.dsh/storages/dsh_token_usage_sidebar.json` — schema-validated, atomic (temp+fsync+rename), versioned. It survives DSH restart and browser refresh. Browser localStorage is never authoritative.

## Timezone ("Today" and "Yesterday")

Today and Yesterday use the **local calendar date** of the host process (the user's system timezone). At a local-day boundary, Today is derived from records dated today and Yesterday from records dated one local day earlier; `lifetimeTotal` is unaffected. No timezone is hard-coded. Legacy rows without a recoverable timestamp remain part of Total but are deliberately excluded from day-specific buckets.

## Supported providers

Works for every provider whose durable session events carry a provider `TokenUsage` — DeepSeek, OpenAI, Anthropic, Google, OpenRouter, local and other DSH-compatible model plugins. Provider caveats are respected (e.g. DeepSeek never reports `cacheWriteTokens`; treated as 0). No fake support for providers that expose no reliable usage data.

## Historical migration

On first activation the host **folds existing durable session logs** (including cold/archived sessions) idempotently, deduped by `(sessionId, turn, step)`, so Total starts from existing authoritative usage. Versioned recovery safely replays known records to restore missing metadata without adding them again. There is **no invented/estimated history**: if no authoritative record exists for a session, it contributes nothing.

## Privacy

Only accounting metadata is persisted: session id, (turn, step), highest seq, local day, provenance, and token totals. Session logs are read solely to extract provider usage and event timing; no prompt, assistant, tool output, API key, credential, or conversation text is persisted by this plugin.

## Uninstall

```bash
dsh plugin --profile web remove dsh-token-usage-sidebar
# Restart `dsh web` after removal.
```

Uninstalling does not delete the persisted local ledger. Delete `~/.dsh/storages/dsh_token_usage_sidebar.json` manually only if you intentionally want to reset all-time totals.

## Known limitations

- **Multi-instance**: more than one DSH host sharing `~/.dsh` writes the same domain file; domain-KV is single-process-first (last-write-wins). Each instance folds the same session events, so records reconcile; brief cross-process divergence is possible.
- **Client refresh path**: the client refetches the host summary on mount, on a low-cost 4-second interval (paused when hidden), and on re-activation. A host→client push channel would require editing the `dsh-api-remotes` forwarded-event allowlist, so it is intentionally avoided.

## Development

```bash
npm install
npm test       # accounting, historical recovery, daily-bucket, and restart invariants
npm run build  # writes the shipped host and browser bundles to lib/
```

## Compatibility

Verified with DeepSeek Harness `0.1.0-rc.6` and its `web` profile. No broader DSH-version or OS compatibility is claimed.

## License

[MIT](LICENSE)
