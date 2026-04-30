# SPEC-017-4-02: Month-to-Date Aggregation & 80% Warning Threshold

## Metadata
- **Parent Plan**: PLAN-017-4
- **Tasks Covered**: Task 3 (month-to-date aggregation script + workflow wiring), Task 4 (80% sticky-comment warning step)
- **Estimated effort**: 6 hours
- **Future location**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-017-4-02-aggregation-warning-threshold.md`

## Description
Replace the scaffold's `TODO(SPEC-017-4-02)` markers in `.github/workflows/budget-gate.yml` with a working aggregation pipeline and the lowest of three threshold tiers (the 80% advisory warning). The aggregator downloads spend artifacts via `gh api`, runs each through the HMAC verifier from SPEC-017-4-01, applies the ISO-8601 month filter and 32-day age cap from TDD §22.1, and exposes `total_spend`, `budget_limit`, and `percentage` as step outputs. The warning step, when `80 ≤ percentage < 100`, posts (or updates) a single sticky PR comment via `actions/github-script@v7` using a hidden marker — so a workflow that re-runs five times on the same PR produces one comment, not five.

The 100% fail and 110% critical tiers are out of scope here; SPEC-017-4-03 layers them on top of the same `evaluate.outputs.percentage`.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `scripts/ci/aggregate-spend.js` | Create | Downloads + verifies + aggregates artifacts; emits outputs to `$GITHUB_OUTPUT`. |
| `.github/workflows/budget-gate.yml` | Modify | Insert `aggregate` and `warn-80-percent` steps in place of SPEC-017-4-02 TODO markers. |

## Implementation Details

### `scripts/ci/aggregate-spend.js`

CLI: `node scripts/ci/aggregate-spend.js`. Reads from env: `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `BUDGET_HMAC_KEY`, optional `BUDGET_HMAC_KEY_PREVIOUS`, `CLAUDE_MONTHLY_BUDGET_USD`, `GITHUB_OUTPUT`.

Algorithm:
1. List recent workflow run artifacts via `GET /repos/{owner}/{repo}/actions/artifacts?per_page=100&page=N` until the page returns artifacts older than the 32-day cap or pagination ends.
2. Filter to artifacts whose name starts with `spend-` (Plans 1-3 produce these).
3. For each candidate, in parallel batches of up to 8 (per PLAN-017-4 risk row 5), download the zip via the artifact `archive_download_url`, extract the single JSON entry, and run it through the HMAC verifier (`verify-spend-artifact.js` invoked as a subprocess, OR import its core logic — prefer the import for performance).
4. For every verified artifact, compute its month bucket from `artifact.timestamp` (ISO-8601 string inside the JSON payload, NOT the GitHub artifact upload time). Drop:
   - artifacts whose month bucket ≠ the current UTC `YYYY-MM`,
   - artifacts whose `timestamp` is more than 32 days before "now" (UTC),
   - artifacts that fail HMAC verification (logged as warnings; never aborts aggregation).
5. Sum `cost_usd` (number, USD) across surviving artifacts → `total_spend`.
6. Read `CLAUDE_MONTHLY_BUDGET_USD` → `budget_limit`.
7. Compute `percentage = (total_spend / budget_limit) * 100`, rounded to one decimal place.
8. Append three lines to `$GITHUB_OUTPUT`:
   ```
   total_spend=<number>
   budget_limit=<number>
   percentage=<number>
   ```
9. Echo a markdown summary table to `$GITHUB_STEP_SUMMARY` listing per-workflow contribution (e.g. `claude-assistant: $12.40`, `prd-review: $3.10`).

Concurrency control:
```js
async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}
```

Edge cases:
- Zero artifacts in current month → `total_spend=0`, `percentage=0`. Step exits 0; downstream warn/fail/critical steps no-op.
- `CLAUDE_MONTHLY_BUDGET_USD` unset or non-numeric → exit 2 with `::error::CLAUDE_MONTHLY_BUDGET_USD not set or invalid`.
- All artifacts fail HMAC → `total_spend=0`. Each failure is logged via `::warning::`; the aggregate step does NOT fail (a tamper attempt should not silently reset the gate to zero — but the alternative, failing the gate, would also let attackers DoS the gate). Mitigation: the workflow summary lists count of dropped artifacts so operators can audit.

### `.github/workflows/budget-gate.yml` — new steps

Insert immediately before the `Record gate invocation` step from SPEC-017-4-01:

```yaml
      - name: Aggregate month-to-date spend
        id: aggregate
        env:
          GITHUB_TOKEN: ${{ github.token }}
          BUDGET_HMAC_KEY: ${{ secrets.BUDGET_HMAC_KEY }}
          BUDGET_HMAC_KEY_PREVIOUS: ${{ secrets.BUDGET_HMAC_KEY_PREVIOUS }}
          CLAUDE_MONTHLY_BUDGET_USD: ${{ secrets.CLAUDE_MONTHLY_BUDGET_USD }}
        run: node scripts/ci/aggregate-spend.js

      - name: Post 80% warning comment
        if: >-
          github.event_name == 'pull_request' &&
          fromJSON(steps.aggregate.outputs.percentage) >= 80 &&
          fromJSON(steps.aggregate.outputs.percentage) < 100
        uses: actions/github-script@v7
        env:
          PERCENTAGE: ${{ steps.aggregate.outputs.percentage }}
          TOTAL: ${{ steps.aggregate.outputs.total_spend }}
          LIMIT: ${{ steps.aggregate.outputs.budget_limit }}
        with:
          script: |
            const marker = '<!-- budget-gate-comment -->';
            const body = `${marker}\n` +
              `## Budget Warning\n\n` +
              `Monthly Claude spend is at **${process.env.PERCENTAGE}%** ` +
              `($${process.env.TOTAL} of $${process.env.LIMIT}).\n\n` +
              `_This is an advisory notice. The gate will fail at 100%._`;

            const { owner, repo } = context.repo;
            const issue_number = context.issue.number;
            const { data: comments } = await github.rest.issues.listComments({
              owner, repo, issue_number, per_page: 100,
            });
            const existing = comments.find((c) => c.body && c.body.startsWith(marker));
            if (existing) {
              await github.rest.issues.updateComment({
                owner, repo, comment_id: existing.id, body,
              });
            } else {
              await github.rest.issues.createComment({
                owner, repo, issue_number, body,
              });
            }
```

The `Record gate invocation` step is updated to include the percentage and dollar figures from `steps.aggregate.outputs.*` in the step summary.

## Acceptance Criteria

- [ ] Given three valid signed artifacts in the current UTC month with `cost_usd` values 10, 12, 20 and `CLAUDE_MONTHLY_BUDGET_USD=500`, aggregator emits `total_spend=42`, `budget_limit=500`, `percentage=8.4` to `$GITHUB_OUTPUT`.
- [ ] Tampered artifacts (HMAC mismatch) are excluded from the sum and logged via `::warning::HMAC verification failed for artifact <path>`. Aggregator still exits 0.
- [ ] Artifacts with `timestamp` more than 32 days before "now" (UTC) are excluded.
- [ ] Artifacts whose `timestamp` falls in a previous ISO-8601 month are excluded even if within the 32-day window (e.g. an artifact dated 2026-03-31 is excluded on 2026-04-01).
- [ ] Aggregator parallelizes downloads in batches of 8 via `Promise.all`; performance test in SPEC-017-4-05 confirms 500 synthetic artifacts complete in <60s.
- [ ] Aggregator exits 2 (config error, not verification failure) when `CLAUDE_MONTHLY_BUDGET_USD` is unset or not a positive number.
- [ ] Workflow summary lists per-workflow spend contribution and the count of dropped (tampered/old/wrong-month) artifacts.
- [ ] First PR run at 82% creates a single comment whose body begins with `<!-- budget-gate-comment -->\n## Budget Warning`.
- [ ] Second PR run at 85% on the same PR updates that comment in place; `gh api repos/:owner/:repo/issues/:n/comments | jq '[.[] | select(.body | startswith("<!-- budget-gate-comment -->"))] | length'` returns `1`.
- [ ] Run at 79% does not create or modify any comment (verified by snapshotting comment list before/after).
- [ ] Run at 100% does not post a warning comment (the 80% step's `if:` upper bound excludes it; the 100% step in SPEC-017-4-03 takes over).
- [ ] Warning step is gated by `github.event_name == 'pull_request'` so non-PR invocations (push, schedule) do not error attempting to read `context.issue.number`.
- [ ] `actionlint` passes on the modified workflow.

## Dependencies

- Depends on SPEC-017-4-01: requires the workflow scaffold, `verify-spend-artifact.js`, and `canonical-json.js` to exist.
- Consumes the spend-artifact upload steps embedded in the eight Claude-powered workflows from PLAN-017-1/2/3. Until those Plans land in CI, the 80% warning step is exercised only via `nektos/act` mock fixtures.
- `actions/github-script@v7` (already a TDD-016 approved action).
- `actions/setup-node@v4` from SPEC-017-4-01.

## Notes

- The aggregator reads `artifact.timestamp` from the artifact's JSON body, not from the GitHub API's artifact upload metadata. This makes the gate insensitive to clock skew between GitHub's storage layer and the Claude-workflow runners and makes test fixtures easy to construct (just set the `timestamp` field).
- The 32-day age cap (vs. the more obvious 31) is deliberate per TDD §22.1: it provides a one-day overlap so an artifact uploaded at 23:59 UTC on the last day of the month is still counted on the first of the next month for late-running gates, but anything older is firmly stale.
- Comment marker `<!-- budget-gate-comment -->` is HTML-rendered as nothing in GitHub's PR UI but is still grep-able in API responses. Do not change the marker without bumping a CHANGELOG entry; existing PRs in flight would otherwise spawn duplicate comments at the rollout boundary.
- The aggregator does NOT abort when all artifacts fail HMAC; instead it reports `total_spend=0` and warns. Rationale documented above (DoS resistance vs. tamper resistance trade-off). SPEC-017-4-05's docs explain this behavior to operators.
- The `fromJSON()` wrapping in the `if:` expression is required because GitHub Actions outputs are always strings; numeric comparisons silently coerce in surprising ways without it.
