# SPEC-017-4-03: 100% Fail Step, 110% Two-Admin Critical Override, Single-Run Override Removal

## Metadata
- **Parent Plan**: PLAN-017-4
- **Tasks Covered**: Task 5 (100% fail step + `cost:override`), Task 6 (110% critical step + two-admin verification), Task 7 (single-run override label auto-removal)
- **Estimated effort**: 6.5 hours
- **Future location**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-017-4-03-fail-critical-overrides.md`

## Description
Layer the two upper threshold tiers and the override-revocation policy on top of the aggregator and 80% warning step from SPEC-017-4-02. This is the security-critical core of the gate: it must reject single-admin overrides, alt-account override attempts, replay attempts (re-using a label across runs), and admin-list eventual-consistency edge cases without false-positives that block legitimate work.

The 100% step (`100 ≤ percentage < 110`) requires a `cost:override` label applied by any repo collaborator with write access; this is the routine "we know this PR is over budget, ship it anyway" lane. The 110% step (`percentage ≥ 110`) requires a `cost:override-critical` label AND verification that two distinct org admins applied or approved the label, each holding a distinct verified email per TDD §22.4 (alt-account / shared-mailbox attacks must fail). After a successful run that consumed either label, the label is removed so a re-run requires re-application — single-run validity per TDD §22.4 item 3.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `scripts/ci/verify-two-admin-override.js` | Create | Queries org admins, validates the two-distinct-admin-with-distinct-verified-emails invariant. |
| `.github/workflows/budget-gate.yml` | Modify | Replace SPEC-017-4-03 TODO markers with `fail-100`, `critical-110`, and `revoke-overrides` steps. |

## Implementation Details

### `scripts/ci/verify-two-admin-override.js`

CLI: `node scripts/ci/verify-two-admin-override.js`. Env inputs: `GITHUB_TOKEN`, `GITHUB_REPOSITORY` (org/repo), `PR_NUMBER`, `CRITICAL_LABEL` (default `cost:override-critical`).

Algorithm:
1. Determine the org name from `GITHUB_REPOSITORY` (`owner/repo` → `owner`).
2. Query `GET /orgs/{org}/members?role=admin&per_page=100` (paginated). Per PLAN-017-4 risk row 4, retry up to 3 times with 10-second backoff on 5xx or empty response. Build `Set<string>` of admin logins (lowercased).
3. Query `GET /repos/{owner}/{repo}/issues/{pr}/events?per_page=100` (paginated). Filter to events with `event === 'labeled'` and `label.name === CRITICAL_LABEL`. The `actor.login` of each is the admin who applied the label. Build a list of unique labelers in chronological order.
4. Reject if fewer than two unique labelers, or if any labeler is not in the admin set. Error: `::error::Critical override requires two distinct org admin approvals (got: <list>)`.
5. For each of the (up to two) labelers, fetch `GET /users/{username}` to read the `email` field. If `email` is null (unverified or hidden), reject with `::error::Admin <login> has no verified public email; cannot satisfy critical override invariant`.
6. Lowercase, normalize (strip dots in the local part for Gmail-style equivalence is OUT of scope — string equality only), and compare. If both emails are byte-equal, reject with `::error::Same-email accounts not permitted for critical override (admin <a> and <b> share <email>)`.
7. Otherwise, exit 0 and append the two `(login, email)` pairs to `$GITHUB_STEP_SUMMARY`.

Failure mode is "deny by default": any unexpected API error after retries → exit 1 with a structured warning that names the failing API call. The operator doc (SPEC-017-4-05) flags this as a known minor edge case (legitimate critical override blocked at boundary).

```js
#!/usr/bin/env node
'use strict';

const { request } = require('node:https');

async function gh(pathStr) {
  // Implementation: GET https://api.github.com${pathStr} with Authorization,
  // Accept: application/vnd.github+json, X-GitHub-Api-Version: 2022-11-28.
  // Returns parsed JSON body. Caller handles pagination.
}

async function withRetry(fn, attempts = 3, backoffMs = 10000) {
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await fn();
      if (result && (Array.isArray(result) ? result.length > 0 : true)) return result;
    } catch (err) {
      if (i === attempts - 1) throw err;
    }
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  throw new Error('Retry exhausted');
}

// ... main flow as algorithm above ...
```

Exit codes: `0` = two distinct admins with distinct verified emails confirmed; `1` = invariant violated; `2` = configuration error (missing env vars).

### `.github/workflows/budget-gate.yml` — new steps

Insert after the warning step from SPEC-017-4-02:

```yaml
      - name: Check for cost override label (100%)
        id: check-100
        if: fromJSON(steps.aggregate.outputs.percentage) >= 100 && fromJSON(steps.aggregate.outputs.percentage) < 110
        env:
          GITHUB_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.number }}
        run: |
          set -euo pipefail
          if [ "${BUDGET_GATE_ADVISORY_MODE:-false}" = "true" ]; then
            echo "advisory_mode=true" >> "$GITHUB_OUTPUT"
            echo "::warning::Budget exceeded but advisory mode enabled. Promote to required check after baseline data."
            exit 0
          fi
          labels=$(gh api "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/labels" --jq '.[].name')
          if echo "$labels" | grep -qx "cost:override"; then
            echo "override_consumed=cost:override" >> "$GITHUB_OUTPUT"
            actor="${GITHUB_ACTOR}"
            echo "::notice::cost:override consumed by ${actor} at $(date -u +%FT%TZ)"
            echo "Override consumed: \`cost:override\` by \`${actor}\`" >> "$GITHUB_STEP_SUMMARY"
          else
            echo "::error::Monthly budget exceeded (${PERCENTAGE}%). Apply 'cost:override' label to proceed."
            exit 1
          fi
        env:
          GITHUB_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.number }}
          GITHUB_ACTOR: ${{ github.actor }}
          PERCENTAGE: ${{ steps.aggregate.outputs.percentage }}
          BUDGET_GATE_ADVISORY_MODE: ${{ vars.BUDGET_GATE_ADVISORY_MODE }}

      - name: Verify critical override (110%)
        id: check-110
        if: fromJSON(steps.aggregate.outputs.percentage) >= 110
        env:
          GITHUB_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.number }}
          CRITICAL_LABEL: cost:override-critical
        run: |
          set -euo pipefail
          labels=$(gh api "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/labels" --jq '.[].name')
          if ! echo "$labels" | grep -qx "${CRITICAL_LABEL}"; then
            echo "::error::Critical budget threshold (${PERCENTAGE}%) reached. Apply '${CRITICAL_LABEL}' label and obtain a second org admin approval to proceed."
            exit 1
          fi
          node scripts/ci/verify-two-admin-override.js
          echo "override_consumed=cost:override-critical" >> "$GITHUB_OUTPUT"
        env:
          GITHUB_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.number }}
          CRITICAL_LABEL: cost:override-critical
          PERCENTAGE: ${{ steps.aggregate.outputs.percentage }}

      - name: Revoke override labels (single-run validity)
        if: >-
          success() &&
          github.event_name == 'pull_request' &&
          (steps.check-100.outputs.override_consumed != '' ||
           steps.check-110.outputs.override_consumed != '')
        env:
          GITHUB_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.number }}
          LABEL_100: ${{ steps.check-100.outputs.override_consumed }}
          LABEL_110: ${{ steps.check-110.outputs.override_consumed }}
        run: |
          set -euo pipefail
          for label in "$LABEL_100" "$LABEL_110"; do
            [ -z "$label" ] && continue
            gh pr edit "$PR_NUMBER" --remove-label "$label" --repo "$GITHUB_REPOSITORY"
            echo "Removed label \`$label\` (single-run validity)" >> "$GITHUB_STEP_SUMMARY"
          done
```

## Acceptance Criteria

### 100% fail step (Task 5)
- [ ] Run at 102% on a PR without the `cost:override` label exits 1 with stderr containing `::error::Monthly budget exceeded (102%). Apply 'cost:override' label to proceed.`.
- [ ] Run at 102% with `cost:override` applied exits 0, logs `::notice::cost:override consumed by <actor> at <ISO-8601-UTC>`, and records the override in `$GITHUB_STEP_SUMMARY`.
- [ ] When `BUDGET_GATE_ADVISORY_MODE=true` (repo variable), 100% threshold emits `::warning::` instead of `::error::` and exits 0; sets `advisory_mode=true` output.
- [ ] Run at exactly 99.9% does NOT enter the 100% step (boundary inclusive on 100, exclusive below).
- [ ] Run at exactly 110% does NOT enter the 100% step (boundary exclusive at 110; the 110% step takes over).

### 110% critical step (Task 6)
- [ ] Run at 115% without `cost:override-critical` label exits 1 with `::error::Critical budget threshold (115%) reached. Apply 'cost:override-critical' label and obtain a second org admin approval to proceed.`.
- [ ] Run at 115% with the label applied by exactly one admin exits 1 with `::error::Critical override requires two distinct org admin approvals (got: <login>)`.
- [ ] Run at 115% with the label applied by two distinct admins whose `users/{username}` responses report the same `email` exits 1 with `::error::Same-email accounts not permitted for critical override`.
- [ ] Run at 115% with the label applied by a non-admin (write access only) exits 1 with `::error::Critical override requires two distinct org admin approvals`.
- [ ] Run at 115% with the label applied by two distinct admins, each with a non-null distinct `email`, exits 0; both `(login, email)` pairs appear in `$GITHUB_STEP_SUMMARY`.
- [ ] Run at 115% where one of the two admin lookups returns `email: null` (unverified or private) exits 1 with `::error::Admin <login> has no verified public email`.
- [ ] Admin-list query retries up to 3 times with 10-second backoff on 5xx or empty response (verified by SPEC-017-4-05 unit test mocking the HTTP layer).
- [ ] Email comparison is case-insensitive byte-wise: `Alice@Example.com` matches `alice@example.com`. No further normalization (no Gmail dot-stripping, no plus-tag handling) — keep the rule predictable.

### Single-run override removal (Task 7)
- [ ] After a successful 105% run that consumed `cost:override`, the label is removed via `gh pr edit --remove-label cost:override` and the removal is logged to `$GITHUB_STEP_SUMMARY`.
- [ ] After a successful 115% run that consumed `cost:override-critical`, that label is removed (the `cost:override` label is not touched if it was not applied).
- [ ] If both labels are present (operator over-applied), both are removed.
- [ ] Removal step is gated by `success()` — if any earlier step fails, the labels remain so the operator can re-trigger after fixing the underlying issue.
- [ ] A re-run on the same PR at the same percentage immediately after a successful gated run fails with the standard "label not present" error (no leaked override carryover).
- [ ] `actionlint` passes on the modified workflow.

## Dependencies

- Depends on SPEC-017-4-01 (workflow scaffold) and SPEC-017-4-02 (aggregator + percentage output).
- Requires the GitHub Actions runner to have `gh` CLI available (default on `ubuntu-latest`).
- Requires `pull-requests: write` permission (already declared in SPEC-017-4-01) for label removal.
- The `BUDGET_GATE_ADVISORY_MODE` repo variable is opt-in; no default set by this spec.

## Notes

- **Threat model.** The two-admin invariant defends against three attacks: (1) single rogue admin self-approving an over-budget Claude run; (2) admin and an alt account they control both applying the label; (3) admin and a colleague's account compromised via shared mailbox both applying the label. Defenses (1) and (2) are addressed by counting distinct admin logins; defense (3) is addressed by requiring distinct verified emails. None of these defenses is bulletproof against a determined insider with cooperating accomplices, but they raise the cost of accidental or unilateral over-budget approvals significantly.
- **Email-as-identity is imperfect.** A determined attacker can rotate the email on their GitHub account between approvals. The TDD §22.4 acknowledges this; the gate captures email at evaluation time and audits via `$GITHUB_STEP_SUMMARY`, which pairs with branch-protection-required reviews to triangulate.
- **Replay protection.** Single-run validity (Task 7) prevents an admin from approving a single critical override and then having that approval reused on later, increasingly expensive runs. Each run consumes the label; each re-trigger forces a fresh re-approval round.
- **Label removal is not transactional.** If `gh pr edit --remove-label` fails (e.g. PR closed in flight), the label persists. The next gate run will treat it as a fresh override — a small risk, accepted because the alternative (failing the gate AFTER the workflow already ran) doesn't actually undo the spend.
- **Advisory mode (PLAN-017-4 risk row 2).** The `BUDGET_GATE_ADVISORY_MODE` toggle exists so the gate can ship in non-blocking mode for the first 30 days while baseline cost-estimation accuracy is established. Operators promote to required check by setting the variable to `false` (or unsetting it). The advisory toggle is intentionally NOT honored at the 110% critical threshold — critical overrides always require the two-admin verification, even during the advisory window, because a 110% breach is by definition not a noise-floor false positive.
- **`grep -qx`** (fixed-string, full-line match) prevents a label named `cost:override-foo` from accidentally satisfying a check for `cost:override`.
- The 100% and 110% steps' `if:` expressions are mutually exclusive (`>= 100 && < 110` vs. `>= 110`), so on any run at most one threshold step actually executes.
- The override-revocation step does not depend on the override actor being the same as the PR author or the gate-runner. The label is metadata on the PR; whoever applies it accepts the cost.
- `verify-two-admin-override.js` performs no `git` operations and no filesystem writes; it is a pure HTTP+stdout/stderr program. This makes SPEC-017-4-05 unit tests straightforward (mock `https.request`).
