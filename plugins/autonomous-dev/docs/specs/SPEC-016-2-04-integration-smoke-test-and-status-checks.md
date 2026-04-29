# SPEC-016-2-04: Integration Smoke Test and Branch-Protection Status-Check Names

## Metadata
- **Parent Plan**: PLAN-016-2
- **Tasks Covered**: Task 7 (Manual integration smoke test) plus the branch-protection status-check exit criterion from PLAN-016-2 § Definition of Done
- **Estimated effort**: 1.5 hours

## Description

Run a draft-PR-based integration smoke test that proves the three jobs from SPEC-016-2-01 (`shell`), SPEC-016-2-02 (`markdown`), and SPEC-016-2-03 (`actionlint`) are correctly gated by `paths-filter`, fail loudly on injected errors, and pass cleanly on isolated valid changes. The smoke test produces a documented evidence trail: six GitHub Actions run links (3 positive + 3 negative), each annotated with the trigger commit, the expected gating, and the observed outcome. The deliverable also documents the three required-status-check names so a repo admin can wire them into branch-protection rules out-of-band.

This spec is a verification spec, not an implementation spec. It produces no production code; the only artifact is a structured smoke-test report appended to PLAN-016-2's verification log AND a short README block listing the three status-check names for the admin running branch-protection setup.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/docs/plans/PLAN-016-2-shell-markdown-workflow-validation.md` | Modify | Append a "Verification Log" section with the six run links and their outcomes |
| `plugins/autonomous-dev/docs/runbooks/ci-status-checks.md` | Create | One-pager listing the three status-check names and admin instructions for branch-protection setup |

No `.github/` files are modified by this spec. All implementation files were delivered by SPEC-016-2-01/02/03.

## Implementation Details

### Smoke Test Procedure

1. **Branch setup**: from a clean `main`, create branch `ci/spec-016-2-04-smoke`.
2. **Three positive commits** (one per job, isolated paths):
   - **Commit P1 (shell only)**: a no-op edit to `plugins/autonomous-dev/bin/supervisor-loop.sh` (e.g., update a comment). Push and open a draft PR. Capture the run URL. Required outcome: `paths-filter` runs, `shell` runs and passes, `markdown` and `actionlint` are `Skipped`.
   - **Commit P2 (markdown only)**: a no-op edit to a doc with known-good links (e.g., add a new bullet to `plugins/autonomous-dev/docs/README.md` referencing `https://github.com`). Push to the same branch. Capture the run URL. Required outcome: `markdown` runs and passes, `shell` and `actionlint` are `Skipped`.
   - **Commit P3 (workflow only)**: a no-op edit to `.github/workflows/ci.yml` (e.g., add a comment line at the top of the file). Push. Capture the run URL. Required outcome: `actionlint` runs and passes, `shell` and `markdown` are `Skipped`.
3. **Three negative commits** (separate branch `ci/spec-016-2-04-smoke-negatives` to keep the positive branch green):
   - **Commit N1 (shell failure)**: add a deliberately-broken file `plugins/autonomous-dev/bin/_smoke.sh` containing `echo $undef_var` (triggers SC2154). Push, capture run URL. Required outcome: `shell` runs and FAILS with SC2154 in the annotations. Then revert the commit.
   - **Commit N2 (markdown failure)**: add `plugins/autonomous-dev/docs/_smoke.md` containing `[broken](https://this-domain-definitely-does-not-exist.invalid)`. Push, capture run URL. Required outcome: `markdown` runs and FAILS, log identifies the broken URL. Then revert.
   - **Commit N3 (workflow failure)**: introduce a typo in `.github/workflows/ci.yml` (e.g., `step:` instead of `steps:`) on a throwaway branch. Push, capture run URL. Required outcome: `actionlint` runs and FAILS, log identifies the line. Then revert (or close the PR without merging).
4. **Cleanup**: revert all smoke-test commits, delete the smoke-test branches, close the draft PRs without merging.
5. **Evidence**: capture the six run URLs and a one-line summary of each outcome.

### Verification Log Entry

Append the following block to PLAN-016-2 (verbatim format; replace placeholders with real URLs and timestamps):

```markdown
## Verification Log

### SPEC-016-2-04 Integration Smoke Test (executed YYYY-MM-DD)

**Positive runs (gating + green):**

| # | Trigger | Run URL | `paths-filter` outputs | Expected | Observed |
|---|---------|---------|------------------------|----------|----------|
| P1 | Shell-only commit on bin/supervisor-loop.sh | https://github.com/<org>/<repo>/actions/runs/<id> | shell=true, others=false | shell green, others skipped | shell green, others skipped |
| P2 | Markdown-only commit on docs/README.md | https://github.com/<org>/<repo>/actions/runs/<id> | markdown=true, others=false | markdown green, others skipped | markdown green, others skipped |
| P3 | Workflow-only commit on ci.yml | https://github.com/<org>/<repo>/actions/runs/<id> | workflows=true, others=false | actionlint green, others skipped | actionlint green, others skipped |

**Negative runs (gating + red):**

| # | Trigger | Run URL | Expected failure | Observed failure |
|---|---------|---------|-------------------|-------------------|
| N1 | Shell file with SC2154 | https://github.com/<org>/<repo>/actions/runs/<id> | shell red on SC2154 | shell red on SC2154 |
| N2 | Markdown file with broken link | https://github.com/<org>/<repo>/actions/runs/<id> | markdown red on URL invalid | markdown red on URL invalid |
| N3 | Workflow file with `step:` typo | https://github.com/<org>/<repo>/actions/runs/<id> | actionlint red on syntax | actionlint red on syntax |

All six runs behaved as expected. Smoke-test branches and PRs cleaned up. No regressions observed in the `paths-filter` job from PLAN-016-1.
```

### `plugins/autonomous-dev/docs/runbooks/ci-status-checks.md` (new file)

Verbatim content:

```markdown
# CI Required Status Checks (Branch Protection)

Configured in: `.github/workflows/ci.yml` (PLAN-016-1, PLAN-016-2 + sibling plans).

## Required status check names

The repo admin must add the following names to the branch-protection rule
for `main` (Settings → Branches → Branch protection rules → Require status
checks to pass before merging). Names are case-sensitive and must match the
job `name:` keys exactly.

- `paths-filter`  (PLAN-016-1)
- `typecheck`     (PLAN-016-1)
- `lint`          (PLAN-016-1)
- `test`          (PLAN-016-1)
- `shell`         (PLAN-016-2 / SPEC-016-2-01)
- `markdown`      (PLAN-016-2 / SPEC-016-2-02)
- `actionlint`    (PLAN-016-2 / SPEC-016-2-03)

## Conditional checks

`shell`, `markdown`, and `actionlint` are gated by `paths-filter` outputs.
A PR that does not touch the relevant file types will report these checks
as `Skipped`. GitHub treats `Skipped` as passing for required checks, so
adding all three to the required list does not block PRs that legitimately
do not touch shell/markdown/workflow files.

## How to add (one-time, by repo admin)

1. Open Settings → Branches → Branch protection rules.
2. Edit the rule for `main` (create one if it does not exist).
3. Enable "Require status checks to pass before merging".
4. Add each name above to the search box and select it.
5. Save.

## Troubleshooting

- A check named like `shell / shell (ubuntu-latest)` instead of `shell`
  indicates the job has a matrix without an explicit `name:` key. The
  job definition in `ci.yml` MUST set `name: shell` (likewise `markdown`
  and `actionlint`) to lock the status-check name. See SPEC-016-2-01 § Notes.
```

## Acceptance Criteria

### Functional Requirements

- **FR-1**: A draft PR exists (or has existed and been closed) demonstrating run P1: a shell-only commit triggers `shell` and skips `markdown` and `actionlint`.
  - **Given** commit P1 pushed to `ci/spec-016-2-04-smoke` **When** the workflow dispatches **Then** the run summary shows `shell` as `Success`, `markdown` as `Skipped`, `actionlint` as `Skipped`.
- **FR-2**: A draft PR demonstrates run P2: a markdown-only commit triggers `markdown` and skips the other two.
  - **Given** commit P2 pushed to the smoke branch **When** the workflow dispatches **Then** the run summary shows `markdown` as `Success`, `shell` as `Skipped`, `actionlint` as `Skipped`.
- **FR-3**: A draft PR demonstrates run P3: a workflow-only commit triggers `actionlint` and skips the other two.
  - **Given** commit P3 pushed to the smoke branch **When** the workflow dispatches **Then** the run summary shows `actionlint` as `Success`, `shell` as `Skipped`, `markdown` as `Skipped`.
- **FR-4**: A throwaway branch demonstrates run N1: a shell file with SC2154 violation fails the `shell` job.
  - **Given** commit N1 pushed to the negatives branch **When** the workflow dispatches **Then** the `shell` job is `Failure` and the job log contains "SC2154".
- **FR-5**: Run N2 demonstrates a broken-link markdown file fails the `markdown` job.
  - **Given** commit N2 pushed **When** the workflow dispatches **Then** the `markdown` job is `Failure` and the job log identifies `https://this-domain-definitely-does-not-exist.invalid`.
- **FR-6**: Run N3 demonstrates a workflow syntax error fails the `actionlint` job.
  - **Given** commit N3 pushed **When** the workflow dispatches **Then** the `actionlint` job is `Failure` and the job log identifies the syntactically-invalid key.
- **FR-7**: All six run URLs are recorded in PLAN-016-2's "Verification Log" section with the table format from Implementation Details.
  - **Given** the smoke test executed **When** I read `PLAN-016-2-shell-markdown-workflow-validation.md` at HEAD **Then** the "Verification Log" section exists with six populated rows (3 positive + 3 negative) and a closing assertion that "All six runs behaved as expected."
- **FR-8**: `plugins/autonomous-dev/docs/runbooks/ci-status-checks.md` exists and lists exactly seven required check names (`paths-filter`, `typecheck`, `lint`, `test`, `shell`, `markdown`, `actionlint`).
  - **Given** the repo at HEAD **When** I read the runbook **Then** the seven names appear in a bulleted list with a one-line attribution to their owning plan/spec.
- **FR-9**: The `paths-filter` job from PLAN-016-1 continues to pass on every smoke-test run.
  - **Given** any of the six smoke-test runs **When** the workflow dispatches **Then** `paths-filter` shows `Success`.
- **FR-10**: All smoke-test branches and PRs are cleaned up (deleted or closed without merge) after the verification log is captured.
  - **Given** the verification log is committed **When** I list open PRs and branches **Then** no `ci/spec-016-2-04-smoke*` branches or PRs remain.

### Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| Time to execute the full smoke test | < 30 minutes wall-clock (operator-driven) | Operator log of start + end time |
| Each individual job within a run | < 2 minutes wall-clock | GitHub Actions run summary, per PLAN-016-2 § Definition of Done |
| Reproducibility | Smoke-test procedure is replayable from the spec alone with no tribal knowledge | Operator runs the test by reading only this spec + the linked sibling specs |

## Dependencies

- **SPEC-016-2-01**: provides the `shell` job under test in P1/N1.
- **SPEC-016-2-02**: provides the `markdown` job under test in P2/N2.
- **SPEC-016-2-03**: provides the `actionlint` job under test in P3/N3.
- **PLAN-016-1**: provides `paths-filter` outputs that gate every conditional run.
- Operator with write access to the repository (to push smoke-test branches and open draft PRs).

## Notes

- Skip-merge discipline: every smoke-test PR is closed without merging. The smoke test is a verification artifact, not a code-landing artifact.
- The runbook (`ci-status-checks.md`) intentionally lists ALL seven required checks, not just the three from PLAN-016-2. This makes it a single point of truth for the admin doing branch-protection setup. PLAN-016-1 owns the first four entries; this spec owns the last three; PLAN-016-3 and PLAN-016-4 will append their own entries when those plans land.
- If a smoke-test run produces an unexpected outcome (e.g., `shell` succeeds when it should fail), the failure is a regression in the underlying spec (016-2-01/02/03), NOT in this spec. Re-run after the underlying fix; do not patch around the issue here.
- `Skipped` GitHub status checks are treated as passing by branch protection. This is the design — it lets us require the conditional checks unconditionally without blocking unrelated PRs. This semantic is documented in the runbook.
- This spec deliberately does NOT configure the branch-protection rule itself. Branch protection is a repo-admin operation handled out-of-band per PLAN-016-2 § Out of Scope.
