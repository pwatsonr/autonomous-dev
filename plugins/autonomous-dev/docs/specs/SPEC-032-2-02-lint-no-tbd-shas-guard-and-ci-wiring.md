# SPEC-032-2-02: `lint:no-tbd-shas` Regression Guard + CI Wiring

## Metadata
- **Parent Plan**: PLAN-032-2 (SHA Pinning + observe.yml.example + lint guard)
- **Parent TDD**: TDD-032 §5.2.3 (WS-2 + WS-6)
- **Parent PRD**: PRD-017 (FR-1709, FR-1711)
- **Tasks Covered**: PLAN-032-2 Task 3 (lint script), Task 4 (CI wiring), Task 5 (actionlint devDep)
- **Estimated effort**: 0.75 day
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-032-2-02-lint-no-tbd-shas-guard-and-ci-wiring.md`

## Summary
Ship the `lint:no-tbd-shas` regression guard that prevents
`TBD-replace-with-pinned-SHA` from re-entering the four cloud-deploy
plugins or `.github/workflows/release.yml`. Wire the guard into the
existing CI `lint` job (no new workflow file). Verify `actionlint` is
invokable both locally and in CI. The guard pairs with SPEC-032-2-01's
pin set and reverts together with it per TDD §4 (WS-6 paired-revert
contract).

This spec ships a small shell script, a `package.json` `scripts:`
entry, one new `run:` step in `.github/workflows/ci.yml`, and (if
needed) a setup step for `actionlint` on local dev.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `scripts/lint/no-tbd-shas.sh` | Create | Shell script implementing the grep guard |
| `package.json` | Modify | Add `scripts.lint:no-tbd-shas` entry |
| `.github/workflows/ci.yml` | Modify | Add one `run:` step inside the existing `lint` job |
| `scripts/lint/test-no-tbd-shas.sh` | Create | Round-trip integration test (synthesize-fail-cleanup) |

If sibling lint scripts (per PLAN-016-2 precedent) live as inline
`scripts:` entries rather than standalone shell files, fold the script
body into `package.json` and skip `scripts/lint/no-tbd-shas.sh`. The
implementer picks the option that matches the existing precedent and
documents the choice in the PR description.

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | A new lint script `lint:no-tbd-shas` exists in `package.json` `scripts:` field. Invokable via `npm run lint:no-tbd-shas`. | T3 |
| FR-2 | The script runs `git grep -nE 'TBD-replace-with-pinned-SHA' -- 'plugins/autonomous-dev-deploy-*' '.github/workflows/release.yml'` (or equivalent). | T3 |
| FR-3 | If the grep returns at least one match: the script prints `ERROR: TBD-replace-with-pinned-SHA reintroduced` followed by the offending `file:line` rows, then exits with code 1. | T3 |
| FR-4 | If the grep returns zero matches: the script exits with code 0 and produces no stdout output (or a single `OK` line; pick one and document). | T3 |
| FR-5 | The grep is path-scoped to `plugins/autonomous-dev-deploy-*` and `.github/workflows/release.yml` ONLY. PRD/TDD docs that mention the literal as illustration do NOT trigger the guard. | T3 |
| FR-6 | A round-trip integration test exists that: (a) synthesizes `plugins/autonomous-dev-deploy-aws/.lint-test.yml` containing the literal, (b) runs the script and asserts exit 1, (c) removes the file, (d) re-runs and asserts exit 0. | T3 |
| FR-7 | The `lint` job in `.github/workflows/ci.yml` has one new `run: npm run lint:no-tbd-shas` step appended after existing lint steps. | T4 |
| FR-8 | The new CI step has no `if:` gating — it runs on every PR and every push the `lint` job already triggers on. | T4 |
| FR-9 | A PR introducing the literal to any in-scope file MUST fail the `lint` status check; the failure annotation MUST point to the offending `file:line`. | T4 |
| FR-10 | `actionlint` is invokable from local dev (e.g. `npx actionlint` or installed via Homebrew/asdf with a documented path) AND from the CI `lint` job. If PLAN-016-2 already ships `actionlint` in CI, this spec does NOT duplicate it. | T5 |
| FR-11 | If `actionlint` is added as a devDependency or via a Homebrew-style install hint, the path is documented in `plugins/autonomous-dev/docs/runbooks/refresh-action-pins.md` (SPEC-032-2-04 owns the runbook). | T5 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Guard latency | < 1s on a clean tree | `time npm run lint:no-tbd-shas` from a warm cache |
| Path-scope correctness | Zero false positives from PRD/TDD docs containing the literal | Run guard on the worktree at HEAD; expect exit 0 |
| Cross-platform safety | Script runs on macOS bash 3.2 AND Ubuntu bash 5.x (CI runner) | Test in both environments; no GNU-only flags |
| CI integration footprint | Exactly one new `run:` step inside the existing `lint` job; zero new jobs; zero new workflow files | Diff `.github/workflows/ci.yml` |
| `actionlint` available | `actionlint --version` succeeds locally and in CI | Invoke in both contexts |
| Regression posture | `npm test` pass count strictly non-decreasing after this spec lands | Compare baseline vs. branch (TG-06) |

## Technical Approach

### Script body

`scripts/lint/no-tbd-shas.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

PATHS=(
  'plugins/autonomous-dev-deploy-aws'
  'plugins/autonomous-dev-deploy-gcp'
  'plugins/autonomous-dev-deploy-azure'
  'plugins/autonomous-dev-deploy-k8s'
  '.github/workflows/release.yml'
)

if matches=$(git grep -nF 'TBD-replace-with-pinned-SHA' -- "${PATHS[@]}" 2>/dev/null); then
  echo "ERROR: TBD-replace-with-pinned-SHA reintroduced" >&2
  echo "${matches}" >&2
  exit 1
fi
exit 0
```

- `git grep` exit code is `1` on no-match and `0` on match. The
  `if matches=$(...)` form captures stdout when a match is found and
  treats no-match as "all good" (the assignment succeeds even if
  `git grep` exits 1, because we wrap with `2>/dev/null` and rely on
  the captured-output presence). Equivalent alternative:
  `git grep -q ... && { echo ERROR; git grep ...; exit 1; }`.
- The script runs from repo root. `package.json` `scripts:` invocations
  start there by default.

### `package.json` entry

```json
{
  "scripts": {
    "lint:no-tbd-shas": "bash scripts/lint/no-tbd-shas.sh"
  }
}
```

If sibling lint scripts inline the body directly (no `scripts/lint/`
directory), fold the body into `package.json` per the precedent.

### CI wiring

In `.github/workflows/ci.yml`, locate the existing `lint` job and
append:

```yaml
      - name: Lint — no TBD action SHAs
        run: npm run lint:no-tbd-shas
```

This step lives inside the `lint` job's `steps:` array, after existing
lint steps (e.g. ESLint, Prettier, actionlint). It runs unconditionally
— no `if:` gate.

### `actionlint` availability

1. Run `npx actionlint --version` locally; if it succeeds, no change
   needed. If it fails:
2. Inspect `.github/workflows/ci.yml` for an existing `actionlint`
   invocation (PLAN-016-2 ships `rhysd/actionlint@<sha>` per the plan's
   §5.2.3 reference).
3. If CI ships actionlint via the action but local devs lack it:
   document the install path (`brew install actionlint` or
   `asdf plugin add actionlint`) in SPEC-032-2-04's runbook.
4. If neither CI nor local has it: add a `setup-actionlint` step to
   the existing `lint` job (`rhysd/actionlint@<pinned-sha>`) and pin
   the SHA per SPEC-032-2-01's procedure.

### Round-trip test

`scripts/lint/test-no-tbd-shas.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

WORKDIR=plugins/autonomous-dev-deploy-aws
TESTFILE="${WORKDIR}/.lint-test.yml"
trap 'rm -f "${TESTFILE}"' EXIT

# Phase A: clean tree → exit 0
npm run --silent lint:no-tbd-shas
echo "Phase A passed (clean tree exits 0)"

# Phase B: synthesize literal → exit 1
echo "uses: actions/checkout@TBD-replace-with-pinned-SHA" > "${TESTFILE}"
if npm run --silent lint:no-tbd-shas; then
  echo "FAIL: guard did not detect synthesized literal" >&2
  exit 1
fi
echo "Phase B passed (literal triggers exit 1)"

# Phase C: cleanup → exit 0
rm "${TESTFILE}"
npm run --silent lint:no-tbd-shas
echo "Phase C passed (cleanup restores exit 0)"
```

Run this test once locally during implementation and document the
output in the PR description. The test is NOT wired into CI (it would
self-trigger the guard during the synthesize phase). It exists as
spec-level evidence the guard works.

## Interfaces and Dependencies

**Consumes:**
- `git`, `bash`, `npm` (always available in CI and local dev).
- The clean tree produced by SPEC-032-2-01.

**Produces:**
- A regression guard that other future SHA-pinning closeouts depend on
  (per TDD §5.2.3: "the guard is the regression test for the pin
  set").

**Cross-references:**
- SPEC-032-2-01 ships the pinned SHAs the guard protects.
- SPEC-032-2-04's runbook documents how to refresh pins WITHOUT
  triggering the guard (the implementer always replaces the literal
  in the same edit; never commits the literal).

## Acceptance Criteria

```
Given a worktree with no TBD-replace-with-pinned-SHA literals in scope
When `npm run lint:no-tbd-shas` is invoked
Then exit code is 0

Given a worktree where the literal has been re-introduced into
  plugins/autonomous-dev-deploy-aws/iam.yml
When `npm run lint:no-tbd-shas` is invoked
Then exit code is 1
And stderr contains "ERROR: TBD-replace-with-pinned-SHA reintroduced"
And stderr contains the offending file:line "plugins/autonomous-dev-deploy-aws/iam.yml:<line>"

Given the literal exists in a PRD/TDD doc under
  plugins/autonomous-dev/docs/**
When `npm run lint:no-tbd-shas` is invoked
Then exit code is 0 (path scoping excludes docs)

Given the round-trip test scripts/lint/test-no-tbd-shas.sh
When invoked from repo root with the lint script in place
Then all three phases (clean → synthesized → cleaned) pass
And the script exits 0

Given .github/workflows/ci.yml after this spec lands
When `actionlint .github/workflows/ci.yml` is invoked
Then exit code is 0 with no warnings
And the lint job has exactly one new `run: npm run lint:no-tbd-shas` step
And the step has no `if:` gating

Given a PR re-introduces the literal into release.yml
When CI runs
Then the lint status check fails
And the failure annotation points to release.yml:<line>

Given local dev environment after this spec lands
When `actionlint --version` is invoked (via npx, brew, or installed binary)
Then it succeeds
And the install path is documented in SPEC-032-2-04's runbook (FR-11)

Given the worktree at HEAD on this branch
When `npm test` is run
Then pass count is strictly non-decreasing vs. the pre-spec baseline (TG-06)
```

## Test Requirements

- **Round-trip integration test:** the synthesize-detect-cleanup test
  in `scripts/lint/test-no-tbd-shas.sh`. Run once locally; capture
  output in PR description. Not wired into CI.
- **CI dry-run validation:** open a draft PR with a deliberate
  literal injection in a deploy plugin file; verify CI's `lint` job
  fails with the expected annotation. Discard the draft after
  validation. (Or: run `npm run lint:no-tbd-shas` locally after
  injecting the literal to confirm.)
- **`actionlint` validation:** `actionlint .github/workflows/ci.yml`
  exits 0 after the new step lands.
- **No new test framework:** the round-trip test is a bash script per
  PRD-017 NG-04 (no new tooling). It does NOT plug into Jest, Vitest,
  or any other test runner.

## Implementation Notes

- The `lint:no-tbd-shas` name matches PLAN-032-2's prescribed name and
  must not change. Downstream specs (SPEC-032-2-01's PR description,
  SPEC-032-2-04's runbook) reference it by name.
- `git grep` requires a git checkout. The script will fail with a
  non-zero exit and a confusing error message if invoked outside a
  git working tree (e.g., from a tarball). This is acceptable —
  document in the script header: "Run from a git working tree; tarball
  installs do not exercise this guard."
- Exit-code semantics: `1` = literal found (build break). `0` = clean.
  Do NOT use `2` or other codes — CI annotation tooling expects
  `0/1` from lint scripts.
- The grep pattern uses `-F` (literal string match) to avoid regex
  escaping issues. The literal is fixed at
  `TBD-replace-with-pinned-SHA`.
- Path-scoping is non-negotiable. A path-broadening change in the
  script is the highest-risk regression mode (false positives from
  TDD/PRD docs). The closeout PR description and the runbook BOTH
  must reiterate the scope to prevent drift.
- The round-trip test synthesizes a `.yml` file under a deploy plugin
  directory. Choose a hidden name like `.lint-test.yml` so a
  half-cleaned test does not get picked up by `actionlint` runs in
  the same workspace. The `trap rm` in the test guards against leaks.
- If the implementer discovers PLAN-016-2's existing `actionlint`
  setup is sufficient, this spec's task 5 reduces to a one-line PR
  comment confirming local-dev availability. No `package.json`
  change required.

## Rollout Considerations

- Guard is **immediately active** at merge. No feature flag.
- The guard pairs with SPEC-032-2-01's pin set per TDD §4 / WS-6:
  any revert of the pin set MUST also revert the guard, otherwise CI
  blocks every subsequent PR with no escape hatch. Reviewer enforces
  this at revert time.
- Rollback scenario: if the pinned SHAs need to be unpinned (e.g., an
  emergency rollback to a floating tag for an upstream-broken pin),
  the guard goes too in the same revert PR.
- The guard does NOT prevent floating-tag re-introduction (e.g.
  `@v4` instead of `@<sha>`). PRD-017 §6 acknowledges this: human
  review catches floating tags. Future hardening (Dependabot config,
  SHA regex enforcement) is filed in the runbook as a follow-up.

## Effort Estimate

- Script + `package.json` entry: 0.25 day
- CI wiring + `actionlint` verification: 0.25 day
- Round-trip test + verification: 0.25 day
- Total: 0.75 day
