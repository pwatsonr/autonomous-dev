# Self-Improve Loop — Architecture Reference

> **Implemented by**: REQ-000057
> **Status**: Shipped in the `autonomous/REQ-000057` branch
> **Related docs**: [docs/tdd/REQ-000057-req-000057.md](../tdd/REQ-000057-req-000057.md) · [docs/prd/REQ-000057-req-000057.md](../prd/REQ-000057-req-000057.md)
> **Feature flag**: `AUTONOMOUS_DEV_SELF_IMPROVE=1` (default: off)

---

## Overview

The **self-improve loop** gives autonomous-dev the ability to fix its own pipeline
failures automatically. Once enabled, each periodic watch-tick polls enrolled
GitHub repositories for open issues that indicate something went wrong (a
pipeline failure, a reviewer rejection, or a human-labeled bug), then creates
a new fix request via the existing intake router.

The loop is **default-off** (`AUTONOMOUS_DEV_SELF_IMPROVE` must be set to exactly
the string `'1'` — not `'true'`, not `'yes'`). It is a purely _additive_ phase
inside `runWatchTick`; existing watch-tick behavior is completely unchanged when
`selfImprove` is absent from `WatchTickDeps`.

Key invariants:

- **FR-MERGE-01 / ADR-006**: Self-improve requests **never auto-merge**. The
  merge gate reads `state.source === 'self-improve'` (state-based, not
  label-based). Even if a human manually adds the `autodev:self-fix` label, the
  gate will still block auto-merge.
- **NFR-RELIABILITY-01**: `scanEnrolledRepos` is wrapped in a top-level
  try/catch and NEVER propagates exceptions. Any unhandled error is emitted as a
  `self_improve_error` event and a partial `ScanResult` is returned.
- **ADR-005** (ledger-before-comment): The ledger is written _before_ the
  GitHub comment. If the comment fails, the ledger entry remains and the request
  is tracked; the comment failure is emitted as `GH_COMMENT_FAILED`.

---

## Gating Model

### 14-guard pipeline (strict order)

```
GD1 → GD2 → GD10 → GD9 → NA1 → GD4 → GD5 → GD6 → GD7 → NA3 → NA4 → NA2 → GD11 → NA7
```

Each guard is a named gate that either passes or trips. On a trip, a
`self_improve_issue_skipped` event is emitted with the `guard` ID and an
`evidence` object. Processing for that issue stops; the next issue is attempted.

| Guard | What it checks |
|---|---|
| GD1 | `config.enabled` (kill-switch) |
| GD2 | Repo is enrolled in auto-improvement |
| GD10 | Issue was classified into an actionable class (A1, A2, or A3) |
| GD9 | Issue fingerprint not in the false-negative registry |
| NA1 | Issue does not have `autodev:in-progress` label (when `addInProgressLabel=false`) |
| GD4 | Global in-flight cap (`maxConcurrentGlobal`) not exceeded |
| GD5 | Per-repo in-flight cap (`maxConcurrentPerRepo`) not exceeded |
| GD6 | 24-hour cost cap (`maxCostUsdPerDay`) not exceeded |
| GD7 | 7-day cost cap (`maxCostUsdPerWeek`) not exceeded |
| NA3 | Attempt count < `maxAttemptsPerIssue` |
| NA4 | Backoff window has expired |
| NA2 | No in-flight request already exists for this (repo, issue) pair |
| GD11 | Per-tick submission limit (`maxIssuesPerTick`) not reached |
| NA7 | Evidence check passed (see §Evidence) |

### Merge-gate contract (`merge_gate.ts`)

```typescript
checkAutoMergeAllowed(state: RequestState | null, labels: string[]): { allow: boolean; reason?: string }
```

Returns `{ allow: false, reason: 'self-improve request never auto-merges (FR-MERGE-01)' }`
whenever `state.source === 'self-improve'` OR
`state.self_improve?.sourceIssue?.issueNumber` is a positive integer.

All other states pass through (return `{ allow: true }`).

---

## Actionable Issue Classes

| Class | Required label | Required marker | Author predicate |
|---|---|---|---|
| A1 | `autodev:pipeline-failed` | `<!-- autodev-failure: <fp> -->` | bot author OR fingerprint non-null |
| A2 | `autodev:reviewer-finding` | `<!-- autodev-reviewer: <fp> -->` | any |
| A3 | `autodev/auto-fix` | none | any |

Only the **first matching class** (in catalog order: A1 → A2 → A3) is used per
issue.

---

## Evidence

Before the guard pipeline reaches NA7, each classified issue goes through an
asynchronous evidence check (`evidence.ts`). Each class has its own evidence
strategy:

- **A1**: Find the first `REQ-XXXXXX` reference in the issue body; read its
  `state.json`; verify `status === 'failed'`. If no REQ- reference is present
  but a fingerprint marker is, accept as `mode: 'marker-only'`.
- **A2**: Parse the `reviewerBlockFp` marker; call `readReviewerBlock`; accept
  only `REQUEST_CHANGES` or `APPROVED` verdicts.
- **A3**: Call `fetchIssueEvents`; verify the `autodev/auto-fix` label was
  added by a human (not the bot).

Evidence checks are raced against a configurable `evidenceTimeoutMs` (default:
5000 ms). A timeout emits `EVIDENCE_TIMEOUT` and trips NA7.

---

## Event Catalog

All events are emitted via the `EventEmitter` type and recorded to the audit
log (`~/.autonomous-dev/audit.log`). JSON schemas live in
`docs/schemas/events/`.

| Event type | When emitted |
|---|---|
| `self_improve_disabled` | Scan called with `enabled=false` |
| `self_improve_config_invalid` | An env var had an invalid value; fallback used |
| `self_improve_issue_detected` | An issue was classified into A1, A2, or A3 |
| `self_improve_issue_skipped` | A guard tripped for an issue |
| `self_improve_request_submitted` | A fix request was created successfully |
| `self_improve_tick_summary` | End of each scan pass (scanned, submitted, skipped, errors) |
| `self_improve_error` | Any operational error (GH_LIST_FAILED, SUBMIT_FAILED, etc.) |
| `self_improve_body_truncated` | Issue body exceeded `bodyTruncateBytes` and was truncated |

---

## Ledger

The persistent ledger tracks one entry per `(repoId, issueNumber)` pair.

**Path**: `~/.autonomous-dev/state/self-improve/ledger.json`
**Permission**: `0600`
**Format**: JSON `{ version: 1, entries: {...}, windowCosts: {...} }`

### Entry lifecycle

```
(new) → in_flight → idle (reconciled)
               ↘ backoff (failed attempt)
               ↘ capped (maxAttempts reached)
```

### Cost windows

Hour-bucketed as `YYYY-MM-DDTHH` UTC keys. `costLast24h()` and `costLast7d()`
sum the relevant buckets from the current time.

### Atomic write

The ledger uses `.tmp + rename` (mirrors `trigger_store.ts`). A lock file
(`ledger.lock`) serializes concurrent writers. Stale locks (mtime > 60 s) are
force-unlinked and retried once. If the lock cannot be acquired after 500 ms,
`LedgerLockBusyError` is thrown with code `LOCK_BUSY`.

---

## Configuration Reference

All settings are read from environment variables. Invalid values are silently
replaced with defaults and a `self_improve_config_invalid` event is emitted.

| Env var | Default | Type | Description |
|---|---|---|---|
| `AUTONOMOUS_DEV_SELF_IMPROVE` | `'0'` | `'1'` only | Enable/disable the loop |
| `AUTONOMOUS_DEV_SELF_IMPROVE_MAX_ATTEMPTS` | `3` | positive integer | Max attempts per issue |
| `AUTONOMOUS_DEV_SELF_IMPROVE_MAX_CONCURRENT` | `3` | positive integer | Global in-flight cap |
| `AUTONOMOUS_DEV_SELF_IMPROVE_MAX_CONCURRENT_PER_REPO` | `1` | positive integer | Per-repo in-flight cap |
| `AUTONOMOUS_DEV_SELF_IMPROVE_MAX_COST_USD_PER_DAY` | `10` | non-negative float | 24-hour cost cap |
| `AUTONOMOUS_DEV_SELF_IMPROVE_MAX_COST_USD_PER_WEEK` | `50` | non-negative float | 7-day cost cap |
| `AUTONOMOUS_DEV_SELF_IMPROVE_BACKOFF_BASE_MINUTES` | `60` | positive integer | Base backoff (doubles each retry) |
| `AUTONOMOUS_DEV_SELF_IMPROVE_MAX_ISSUES_PER_TICK` | `5` | positive integer | Per-tick submission cap |
| `AUTONOMOUS_DEV_SELF_IMPROVE_EVIDENCE_TIMEOUT_MS` | `5000` | positive integer | Evidence check timeout |
| `AUTONOMOUS_DEV_SELF_IMPROVE_BODY_TRUNCATE_BYTES` | `32768` | positive integer | Issue body byte limit |
| `AUTONOMOUS_DEV_SELF_IMPROVE_ADD_IN_PROGRESS_LABEL` | `'1'` | `'1'` or not | Add `autodev:in-progress` on submission |
| `AUTONOMOUS_DEV_SELF_IMPROVE_FN_REGISTRY_PATH` | `null` | file path | False-negative fingerprint registry |
| `AUTONOMOUS_DEV_BOT_LOGIN` | `''` | string | GitHub login of the bot account |

---

## Runbook

### Enable the loop

```bash
export AUTONOMOUS_DEV_SELF_IMPROVE=1
export AUTONOMOUS_DEV_BOT_LOGIN=your-bot-login
```

Then restart the daemon. The loop runs once per watch-tick cycle.

### Check status

```bash
autonomous-dev triggers self-improve status
# JSON output:
autonomous-dev triggers self-improve status --format json
```

### Run one scan manually

```bash
autonomous-dev triggers self-improve tick
```

Output: `scanned=N submitted=N errors=N skipped={...}`

### Reset a stuck entry

If an issue is stuck in `in_flight` or `backoff`, reset it:

```bash
autonomous-dev triggers self-improve reset <owner/repo> <issue-number>
# Example:
autonomous-dev triggers self-improve reset myorg/myrepo 123
```

This removes the entry from the ledger. The next tick will re-classify the
issue and start fresh.

### Investigate a skipped issue

Check the audit log for `self_improve_issue_skipped` events:

```bash
grep '"self_improve_issue_skipped"' ~/.autonomous-dev/audit.log | tail -20 | jq .
```

The `guard` field identifies which gate tripped; the `evidence` object gives
details.

### Disable the loop immediately

```bash
export AUTONOMOUS_DEV_SELF_IMPROVE=0
# Or unset it:
unset AUTONOMOUS_DEV_SELF_IMPROVE
```

The next tick will emit `self_improve_disabled` and skip all scanning. No ledger
writes occur.

---

## Module Map

```
intake/triggers/self_improve/
├── config.ts          — environment variable parsing
├── labels.ts          — label constants and parsers
├── ledger.ts          — persistent ledger (atomic write, lock, cost windows)
├── actionable.ts      — classify issues into A1/A2/A3
├── evidence.ts        — per-class evidence checks
├── guards.ts          — 14-guard pipeline
├── gh_issues.ts       — GitHub API calls (list issues, post comment)
├── description.ts     — build RequestSubmitInput description from issue
├── events.ts          — event types and emitter factory
├── merge_gate.ts      — checkAutoMergeAllowed (FR-MERGE-01)
├── submit.ts          — submitFromIssue (ADR-005 ledger-before-comment)
├── scan.ts            — scanEnrolledRepos (main entry point)
└── index.ts           — barrel re-exports
```

Integration points:

- `watch_tick.ts` — calls `scanEnrolledRepos` as an optional phase 3
- `bin/triggers-cli.ts` — `self-improve tick|status|reset` subcommands
- `intake/adapters/cli_adapter_entry.ts` — `routerProvider()` for submit
