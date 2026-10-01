# Accounting version 2 — retries, fork ownership and recovery

Status: unreleased after v1.1.8. Storage schema 3 is additive; storage paths and
plugin identity remain unchanged. This accounting change is separate from the
older JSON-to-SQLite migration.

## Why totals can change

Accounting version 1 kept one highest-sequence sample for `sessionId:turn:step`.
That merged separately billed retries, missed some `assistant/attempt` usage, and
could count inherited fork events again under a child's session ID.

Version 2 uses provider-reported message/attempt usage (including stream fallback),
keeps explicit retry attempts separate, and counts only events owned by each session.
A failed attempt without provider usage contributes nothing; no tokens are estimated.
Reasoning remains included in output and is never added to total a second time.

Synthetic example: an attempt reporting 100 tokens followed by an explicit retry
reporting 200 tokens contributes 300. Replaying either event leaves that total unchanged.
A child inheriting the parent's 100 tokens and producing its own 50 contributes
only 50; the parent remains responsible for its own 100.

## Identity and replacement rules

- First attempt: `sessionId:turn:step`.
- Explicit retry: `sessionId:turn:step:retry:<llm/retry-started-seq>`.
- Highest-sequence sample replaces previous samples within the same attempt.
- Equal-sequence, equal-total samples may fill missing dates, buckets and labels;
  conflicting equal-sequence totals do not replace the record.
- Legacy imports cannot overwrite a row already verified at accounting version 2.

Recovery checkpoints retain the last processed sequence, boundary event hash, fork
cut, active retry slot and official opaque source revision when available. Matching
revisions skip unchanged logs; changed logs verify their boundary before tail replay.
New legacy records invalidate checkpoints, aggregate repairs force full recovery,
and asynchronous commits reject a checkpoint invalidated while reading. The adapter
relies on official append-only session logs. A changed
boundary or fork cut fails recovery and preserves the existing ledger. A full source
replay must have contiguous events starting at zero; filtered or incomplete arrays
cannot authorize a legacy correction.

## Audited legacy correction

Rows without an accounting version default to version 1. The plugin only upgrades
them after reading a complete, validated authoritative session snapshot/log. A legacy
row newer than the available snapshot prevents correction of that session.

Before the first correction in a store lifetime, the plugin creates an immutable
SQLite snapshot beside the ledger:

`dsh_token_usage_sidebar.sqlite.pre-accounting-v2-<uuid>.bak`

Within one immediate transaction it then:

1. Reads the current session rows under the write lock and records their old total.
2. Replaces legacy identities with verified attempt samples and inserts missing attempts.
3. Flags proven inherited rows with `excluded_reason='fork_inherited'`; retains the
   original row rather than deleting it.
4. Updates all aggregate/provenance contributions and verifies that the global delta
   equals the session's before/after delta.
5. Writes `accounting_changes` with numeric pre-correction record metadata, before/after
   totals, reason and timestamp; commits the recovery checkpoint with the records.

A failure rolls the transaction back. The backup remains. Audits/checkpoints contain
accounting metadata and hashes, never prompts, response text, tool output or credentials.
The debug API exposes adjustment counts/totals but not individual audit rows.

## Unavailable history and provisional live data

Unverifiable version 1 rows remain included in known totals, with a partial-history
notice. The plugin does not infer retry boundaries or delete unknown history.
When a live snapshot temporarily fails, readable new samples remain provisional
version 1; later events retry the complete snapshot and permit audited correction.
If fork ownership is unknown, the plugin waits for a verifiable cut rather than
assigning inherited usage to the child.

Initialization or failed cutover returns an API error; a failed source scan with a
readable existing ledger can serve known totals with partial health. Scan completeness
describes enumerated logs, not a guarantee of full account lifetime coverage.

## Rollback and downgrade

Do not run an older plugin against the corrected database: older versions do not
understand retry identities or excluded fork rows. Stop the relevant DSH profile
before any manual restore. Archive the current SQLite, WAL/SHM and backups first;
preserve them for recovery. Use the pre-correction snapshot only if reverting the
entire ledger state to that point is intended. Newer usage is still in the archive;
restoring an old snapshot does not merge it automatically.

Backups and source logs are never automatically deleted. No real ledger is touched
by the synthetic regression suite.
