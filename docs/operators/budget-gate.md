# Budget Gate -- Operator Guide

Reference documentation for the monthly Claude-spend budget gate
(SPEC-017-4-01..05). One document, no duplication: every other doc
linking to budget concepts links here.

## What this gate does

Each Claude-invoking workflow emits an HMAC-signed JSON spend artifact
when it finishes. A reusable workflow (`.github/workflows/budget-gate.yml`)
runs ahead of every Claude job, downloads recent `spend-*` artifacts
via the GitHub Actions API, verifies each HMAC, sums the current-UTC-month
contributions inside a 32-day age window, and gates the downstream job
based on the percentage of the monthly budget consumed.

A tampered or unsigned artifact is dropped with a `::warning::`; it
does NOT fail the gate (doing so would let an attacker DoS the gate by
uploading a single bad artifact).

## Threshold semantics

| Percentage | Behavior | Override |
|------------|----------|----------|
| `< 80%`     | Silent | None |
| `80% – 99.9%` | Sticky PR comment (advisory; updated each re-run) | None |
| `100% – 109.9%` | Workflow fails | `cost:override` label (any maintainer with `pull-requests: write`) |
| `>= 110%`    | Workflow fails | `cost:override-critical` label + two distinct org admins with distinct verified emails |

Override labels are removed automatically after a successful run
(single-run validity). Repeat overrides require re-applying the label.

The 30-day rollout window may set repo variable `BUDGET_GATE_ADVISORY_MODE=true`,
which downgrades the 100% threshold to a `::warning::` and skips the
override requirement. The 110% threshold ALWAYS enforces.

## Worked examples

### 1. 70% spend (silent)
Open a PR. The `budget-gate` job runs, computes 70%, posts no comment,
and downstream Claude jobs proceed. Step summary records the percentage.

### 2. 85% spend (advisory comment)
Open a PR. The gate posts a sticky comment marked
`<!-- budget-gate-comment -->` reading "Monthly Claude spend is at 85%
($425 of $500). This is an advisory notice. The gate will fail at 100%."
Subsequent gate runs UPDATE the same comment (no comment spam). Downstream
Claude jobs proceed.

### 3. 102% spend (single-admin override)
Gate fails with
`::error::Monthly budget exceeded (102%). Apply 'cost:override' label to proceed.`
Apply `cost:override`, re-run the workflow. Gate succeeds, label is
auto-removed, audit line `Override consumed: cost:override by <actor>`
appears in the step summary.

### 4. 115% spend (two-admin critical override)
Gate fails with
`::error::Critical budget threshold (115%) reached. Apply 'cost:override-critical' label and obtain a second org admin approval to proceed.`
Procedure:

1. Admin A applies `cost:override-critical`.
2. Admin B (different login, different verified public email) applies
   `cost:override-critical` (label is idempotent; the gate reads the
   labeled-event history, not just the current label set).
3. Re-run the workflow.
4. The gate calls `verify-two-admin-override.js`, which lists the two
   most recent labelers, asserts each is in the org admin list, and
   asserts the two verified emails differ (case-insensitive).
5. On success, the label is auto-removed and the step summary lists
   the two approving admins.

If either admin lacks a verified public email or shares an email with
the other admin, the override fails with a structured `::error::` line
and a third admin must take over.

## Reading the workflow summary

Each `budget-gate` run appends the following to `$GITHUB_STEP_SUMMARY`:

- `## Budget Gate -- Aggregation` -- total spend, budget limit, percentage,
  count of verified vs dropped artifacts.
- A per-workflow contribution table sorted alphabetically by workflow
  name. Use this to identify which workflow is driving the spend.
- `## Budget Gate` -- triggering workflow name and the same MTD numbers.
- (Override only) `Override consumed: cost:override by <actor>` audit line.
- (Critical override only) `## Critical Override -- Approvers` table
  with both admin logins and their verified emails.

## Override workflow

- **Who can apply `cost:override`:** any user with `pull-requests: write`.
  GitHub label-application is an audited event; the actor is recorded
  in the issue events feed.
- **Who can apply `cost:override-critical`:** must be an org admin AND
  one of two distinct admins with distinct verified emails.
- **Why labels are auto-removed:** an override is single-run-valid by
  design. A re-run without re-applying the label re-blocks. This forces
  a human acknowledgment for every Claude-bearing run.
- **False-positive 100% breaches (estimation drift):** spend artifacts
  use `estimated_cost_usd` from each workflow's emitter, not actual
  Anthropic billing. If estimation drifts high, apply `cost:override`
  for the affected runs and tune the estimator (see PRD-008 §6).

## HMAC-key rotation procedure (manual, quarterly)

The 32-day overlap window matches the aggregator's artifact age cap:
no artifact still in the aggregation window can outlive the previous
key's retention.

1. Generate a new key:
   ```bash
   openssl rand -hex 32
   ```
2. Set `BUDGET_HMAC_KEY_PREVIOUS` (repo or org secret) to the
   currently-active key.
3. Set `BUDGET_HMAC_KEY` to the newly-generated key. Workflows that
   emit new artifacts immediately sign with the new key; the verifier
   accepts either key during the overlap window.
4. Wait at least 32 days.
5. Unset `BUDGET_HMAC_KEY_PREVIOUS`. Any artifact still signed by the
   old key is older than the age cap and is excluded by the aggregator
   regardless.

Skipping the 32-day overlap will cause the gate to drop legitimate
artifacts as `HMAC verification failed`, which is detectable in the
step summary's "Dropped: N HMAC-failed" line.

## When the gate fails

Every fatal log line and what to do about it:

- `::error::Monthly budget exceeded (X%). Apply 'cost:override' label to proceed.`
  -- Apply `cost:override`, re-run. See Worked Example 3.

- `::error::Critical budget threshold (X%) reached. Apply 'cost:override-critical' label and obtain a second org admin approval to proceed.`
  -- Two distinct admins must label. See Worked Example 4.

- `::error::Critical override requires two distinct org admin approvals (got: <list>)`
  -- A labeler is not an org admin OR only one admin has labeled.
  Recruit a second admin.

- `::error::Same-email accounts not permitted for critical override (admin A and B share <email>)`
  -- The two admins share a verified public email. Need a third admin
  with a distinct email.

- `::error::Admin <login> has no verified public email; cannot satisfy critical override invariant`
  -- The admin must add and verify a public email on their GitHub
  profile (Settings > Emails > Public email), or hand off to another admin.

- `::warning::HMAC verification failed for artifact <name>`
  -- An artifact was tampered with OR signed with a key the gate does
  not know. The artifact is excluded from the sum; investigate via
  the source workflow run.

- `::error::BUDGET_HMAC_KEY not set`
  -- Repo secret missing. Run the rotation procedure to set it.

- `::error::CLAUDE_MONTHLY_BUDGET_USD not set or invalid`
  -- Repo secret missing or non-positive. Set to a positive number
  representing the dollar budget for a calendar month.

## Known edge cases

- **Advisory mode (`BUDGET_GATE_ADVISORY_MODE=true`):** demotes the
  100% threshold to a `::warning::`. The 110% threshold always
  enforces. Intended for the first 30 days post-launch to surface
  estimation accuracy before promoting to a required check.
- **GitHub admin API eventual consistency:** the two-admin verifier
  retries 3x with 10-second backoff on 5xx and on transiently empty
  admin pages. Re-trigger the gate if a critical override fails with
  a generic 5xx.
- **Tag-push workflows (`release.yml`):** budget-gate runs but the PR-only
  steps (sticky comment, label check) no-op. The aggregator still
  computes month-to-date spend; downstream jobs are gated only by the
  100%/110% fail steps, which require a PR context. This is by design
  -- a release should not be blocked by spend already incurred.

## See also

- `.github/workflows/budget-gate.yml` -- reusable workflow source.
- `scripts/ci/{verify-spend-artifact,aggregate-spend,verify-two-admin-override}.js`
- SPEC-017-4-01..05 in `plugins/autonomous-dev/docs/specs/`.
- `tests/ci/test_budget_gate.bats`, `tests/ci/test_two_admin_override.bats`
