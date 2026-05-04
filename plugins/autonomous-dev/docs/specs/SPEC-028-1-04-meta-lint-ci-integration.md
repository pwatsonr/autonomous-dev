# SPEC-028-1-04: Meta-Lint CI Integration

## Metadata
- **Parent Plan**: PLAN-028-1
- **Parent TDD**: TDD-028 §9 + PRD-010 / TDD-016 CI baseline
- **Tasks Covered**: Task 8 (CI wiring)
- **Estimated effort**: 2 hours
- **Status**: Draft

## Summary
Wire `evals/meta-lint.sh` into the existing CI workflow under `.github/workflows/`. The CI step runs on any PR touching `plugins/autonomous-dev-assist/evals/**`, invokes meta-lint with `--json`, and posts a Markdown summary as a PR comment when any finding is FAIL. Tolerates the `--allow-baseline-deficit` path used by sibling-pending eval-suite PRs.

## Functional Requirements

| ID | Requirement | Task |
|----|-------------|------|
| FR-1 | A CI workflow MUST run `bash plugins/autonomous-dev-assist/evals/meta-lint.sh --json` on PRs whose changed files match `plugins/autonomous-dev-assist/evals/**`. | T8 |
| FR-2 | The workflow MUST set up dependencies (`yq` v4 + `node` for `ajv`, OR `python3` + `python3-jsonschema`) before invoking meta-lint. | T8 |
| FR-3 | If meta-lint exits non-zero, the workflow MUST fail the PR check. | T8 |
| FR-4 | If meta-lint reports findings, the workflow MUST post a Markdown comment to the PR summarizing findings (per-suite pass/fail; rule violations). | T8 |
| FR-5 | A PR that touches non-eval files (e.g., only `README.md` or `commands/eval.md`) MUST NOT trigger the meta-lint workflow. | T8 |
| FR-6 | The workflow MUST be `actionlint`-clean. | T8 |
| FR-7 | The workflow MUST honor a PR label `meta-lint-allow-baseline-deficit`. When the label is present, the workflow invokes meta-lint with `--allow-baseline-deficit`. | T8 |
| FR-8 | All third-party GitHub Actions used MUST be pinned to a major version (e.g., `actions/checkout@v4`). No SHA pinning. | T8 |

## Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Workflow runtime | < 90 s end-to-end | GitHub Actions wall-clock |
| Workflow file size | ≤ 80 lines YAML | `wc -l` |
| `actionlint` exit | 0, no warnings | `actionlint .github/workflows/eval-meta-lint.yml` |
| Path-filter precision | 100% (only triggers on eval changes) | Empirical: 5 dummy PRs touching different paths |

## Files to Create or Modify

- **Path (create)**: `.github/workflows/eval-meta-lint.yml`
  - **Action**: Create (preferred) — keeps the meta-lint job isolated and auditable.
  - **Description**: GitHub Actions workflow with a `pull_request` trigger filtered on `paths: ['plugins/autonomous-dev-assist/evals/**']`.
- **Alternative path (modify)**: `.github/workflows/assist-evals.yml` (if it exists; add a job)
  - **Action**: Conditional — if an assist-evals workflow already exists, prefer adding a job there over creating a new file.
  - **Description**: New job `meta-lint:` parallel to existing eval jobs.

## Technical Approach

### Workflow structure
1. **Trigger**: `on: pull_request: paths: ['plugins/autonomous-dev-assist/evals/**']`.
2. **Jobs**:
   - `meta-lint`:
     - `runs-on: ubuntu-latest`
     - `permissions: pull-requests: write` (to post comments)
     - Steps:
       1. `actions/checkout@v4`.
       2. Install `yq` v4: `wget` from mikefarah/yq releases (pin major version) OR `actions/setup-go@v5` + `go install`.
       3. Install Node + `ajv-cli`: `actions/setup-node@v4` + `npm install -g ajv-cli@v5` (pin major).
       4. Detect label: `if: contains(github.event.pull_request.labels.*.name, 'meta-lint-allow-baseline-deficit')` controls a `FLAGS` env var.
       5. Run meta-lint: `bash plugins/autonomous-dev-assist/evals/meta-lint.sh --json $FLAGS > meta-lint-output.json`. Capture exit code.
       6. Post comment via `actions/github-script@v7` if findings exist (regardless of exit code so warnings are also surfaced). Comment body parses `meta-lint-output.json` and emits a Markdown table.
       7. Exit step with the captured exit code so the PR check status reflects pass/fail.

### Path-filter verification (T8 testing)
1. Create a draft PR touching only `plugins/autonomous-dev-assist/evals/test-cases/help-questions.yaml` (existing) with a deliberate violation (e.g., remove a `must_not_mention` field). Confirm meta-lint workflow runs and FAILs.
2. Fix the violation. Confirm workflow PASSes.
3. Create a separate draft PR touching only `plugins/autonomous-dev-assist/README.md`. Confirm meta-lint workflow does NOT run.
4. Apply `meta-lint-allow-baseline-deficit` label to a PR that has only a `case_minimum` violation. Confirm workflow PASSes (warning, not error).

## Acceptance Criteria

```
Given a PR that introduces a malformed eval case (missing must_not_mention)
When CI runs
Then the meta-lint workflow runs
And the workflow exits non-zero
And a PR comment is posted with the findings table
And the PR check is marked failed
```

```
Given a PR that touches only plugins/autonomous-dev-assist/README.md
When CI runs
Then the meta-lint workflow does NOT run
And no PR comment is posted by the meta-lint job
```

```
Given a PR that touches only plugins/autonomous-dev-assist/evals/eval-config.yaml
When CI runs
Then the meta-lint workflow runs
And reports the current state of all suites
```

```
Given a PR with the label "meta-lint-allow-baseline-deficit"
And the PR has only case_minimum violations (no schema/frontmatter/negative_minimum violations)
When CI runs
Then meta-lint runs with --allow-baseline-deficit
And the workflow exits 0
And the PR comment shows case_minimum findings as warnings (not errors)
```

```
Given the workflow file
When actionlint is invoked
Then exit code is 0
And no warnings are emitted
```

```
Given the workflow file
When grepped for SHA-pinned actions (e.g., @[0-9a-f]{40})
Then no matches are found
And every action reference uses a major-version tag (@v4, @v5, etc.)
```

```
Given a PR that introduces a brand-new suite YAML with frontmatter but only 3 cases (below case_minimum=20 for chains)
And the PR does NOT have the baseline-deficit label
When CI runs
Then the workflow exits non-zero
And the comment names the case_minimum violation
```

```
Given a clean eval directory (no violations)
When CI runs
Then meta-lint exits 0
And no PR comment is posted (or a "PASS" comment is posted, depending on implementation choice — both acceptable)
And the PR check is green
```

## Test Requirements

- **Path-filter test**: 2 draft PRs (one in-scope, one out-of-scope) prove the path filter.
- **Failure-path test**: 1 draft PR with deliberate violation; meta-lint blocks merge.
- **Success-path test**: 1 draft PR with valid changes; meta-lint passes.
- **Label-toggle test**: 1 draft PR with case_minimum-only violation; with vs without the label; pass vs fail.
- **`actionlint`**: clean.
- **SHA-pinning audit**: grep workflow file for SHA-pinned action refs; expect zero.

## Implementation Notes

- The existing CI workflow under `.github/workflows/` may already include path-filtered eval steps; check for an existing `assist-evals.yml`. Adding a job there is preferred over creating a parallel file.
- The PR-comment step uses `actions/github-script@v7` with a small JS snippet that reads `meta-lint-output.json` and emits a Markdown comment. Keep the snippet ≤30 lines.
- The `meta-lint-allow-baseline-deficit` label is the merge gate for SPEC-028-2-* and SPEC-028-3-* PRs. Without this label-honoring path, those sibling-pending PRs cannot land.
- Per FR-8, NEVER use SHA-pinned actions. The standards-reviewer agent's SHA-pinning regex (TDD-026 §8) checks workflow files too.

## Rollout Considerations

- The workflow activates immediately on merge. Existing eval files are validated retroactively on the next PR that touches `evals/**`. Per TDD-028 OQ-5, legacy violations do not block; the workflow only blocks if the failing finding is on a NEW or MODIFIED case (this is a v1 acceptable simplification — the meta-lint script itself does not distinguish, but reviewers can dismiss legacy findings).
- Rollback: revert the workflow file commit; meta-lint can still be invoked manually.

## Dependencies

- **Blocked by**: SPEC-028-1-02 (meta-lint script must exist), SPEC-028-1-03 (eval-config.yaml registers suites).
- **Exposes to**: SPEC-028-2-* and SPEC-028-3-* (their PRs need this gate to merge with `--allow-baseline-deficit`).

## Out of Scope

- Authoring meta-lint.sh or schema — owned by SPEC-028-1-01 / SPEC-028-1-02.
- Modifying any non-eval CI workflows.
- Cost-tracking dashboards for eval runs.
- Notification routing (Slack, etc.) on workflow failure.
