# SPEC-031-4-03: PR Description Per-SPEC Summary + Matrix Preamble Update + Closing Commit

## Metadata
- **Parent Plan**: PLAN-031-4 (verification script + CI guard)
- **Parent TDD**: TDD-031-spec-reconciliation-path-vitest-bats (§6.4, §6.5, §8.1, G-3105)
- **Parent PRD**: PRD-016-test-suite-stabilization (G-08, FR-1654, G-3105)
- **Tasks Covered**: PLAN-031-4 task 5 (PR per-SPEC summary), task 6 (matrix preamble enforcement note), task 7 (closing commit)
- **SPECs amended by this spec**: 0 (this spec writes to the matrix file and the PR description, then commits the script + workflow + matrix changes)
- **Estimated effort**: 45 minutes (~30 min PR summary authoring + ~10 min matrix preamble update + ~5 min commit)
- **Status**: Draft
- **Depends on**: SPEC-031-4-01 (script + verification log), SPEC-031-4-02 (CI step + red/green run URLs)

## Summary
Aggregate the matrix rows from PLAN-031-1/2/3 into a reviewer-friendly
per-SPEC summary table at the top of the TDD-031 PR description, update
the matrix preamble with an enforcement-mechanism note pointing at the
new script and CI step, and produce the single atomic commit that closes
PLAN-031-4 and the TDD-031 doc-only PR.

## Functional Requirements

- **FR-1**: The TDD-031 PR description MUST contain a per-SPEC summary
  table at its top section, grouped by drift class (Path, Vitest, Bats),
  with one row per amended SPEC across all three classes. Row format:
  ```
  | SPEC ID | Class | Action summary | Diff link |
  ```
  The Diff link MUST be a `#diff-...` anchor that resolves to the SPEC's
  diff hunk in the PR's Files Changed view. Task: PLAN-031-4 task 5.
- **FR-2**: The summary's row count MUST equal the sum of rows across the
  three matrix sections (`## Path drift`, `## Vitest`, `## Bats`).
  Discrepancies are hard failures.
- **FR-3**: At least three randomly-chosen Diff-link anchors MUST be
  click-tested before the PR is opened for review. Each anchor MUST
  resolve to the correct diff hunk. The three tests MUST be recorded in
  the matrix preamble.
- **FR-4**: For large summary tables (>30 rows), the table MUST be paged
  into a `<details><summary>...</summary>...</details>` block per
  TDD §6.4 to keep the PR body scannable. The first 5 rows of each
  class MAY remain outside the `<details>` block as a glanceable
  preview.
- **FR-5**: The matrix preamble (`plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md`)
  MUST gain an "Enforcement mechanism" subsection naming:
  - The script path: `scripts/verify-spec-reconciliation.sh`
  - The CI step name: `spec-reconciliation`
  - The local invocation hint: `bash scripts/verify-spec-reconciliation.sh`
  - A statement that any future SPEC reintroducing the drift tokens will
    fail CI on this step.
  Task: PLAN-031-4 task 6.
- **FR-6**: The matrix preamble MUST also include the "CI guard self-test"
  subsection populated by SPEC-031-4-02 with:
  - The red run URL (drift introduced)
  - The green run URL (drift removed)
  - The throwaway-branch deletion confirmation
- **FR-7**: A single atomic commit MUST be created on the TDD-031 branch
  with the exact message:
  ```
  docs(specs): PLAN-031-4 verification script + CI guard for SPEC reconciliation
  ```
  The commit body MUST list:
  - The four checks implemented by the script.
  - The five paired self-test results (from SPEC-031-4-01 FR-7).
  - The two CI run URLs (red and green) from SPEC-031-4-02.
  - The matrix preamble updates.
  Task: PLAN-031-4 task 7.
- **FR-8**: The closing commit MUST stage exactly three files (or paths):
  - `scripts/verify-spec-reconciliation.sh` (new)
  - `.github/workflows/ci.yml` (modified)
  - `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md` (modified)
  Any other staged files indicate scope leakage and the commit is held.
- **FR-9**: Per OQ-31-07: any pre-existing path drift surfaced by the
  script's check (4) on this PR's branch MUST be reconciled in this PR
  itself — add a row to the matrix's Path drift section, amend the
  offending SPEC, include the amendment in the PLAN-031-1 (or this)
  commit. If the surfaced count exceeds 3, the issue is escalated to
  the reviewer for a scoping decision before the PR is opened.

## Non-Functional Requirements

| Requirement | Target | Measurement Method |
|-------------|--------|---------------------|
| Summary completeness | Sum of class-section row counts equals summary row count | `awk` extraction across the three matrix sections vs. PR description table |
| Diff-link integrity | 3-of-3 random click-tests resolve | Manual click test recorded in matrix preamble |
| Commit atomicity | Single commit with exactly 3 file changes | `git log -1 --stat` shows exactly 3 files |
| Enforcement note completeness | All four required elements present (script path, CI step name, invocation hint, future-CI-fail statement) | `grep -c` for each in the matrix preamble |
| PR body scannability | First-screen view shows summary preview without scrolling past metadata | Manual check; `<details>` collapse used for tables >30 rows |

## Patterns to Find/Replace

This spec performs no SPEC content substitutions. It writes to the
matrix file and the PR description, then commits the prior
PLAN-031-4 artifacts.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md` | Modify | Add "Enforcement mechanism" subsection; populate "CI guard self-test" subsection with run URLs and branch-deletion confirmation |
| TDD-031 PR description | Modify (out-of-tree) | Add per-SPEC summary table at the top, grouped by class |

The script (`scripts/verify-spec-reconciliation.sh`) and workflow
(`.github/workflows/ci.yml`) are NOT modified by this spec; SPEC-031-4-01
and SPEC-031-4-02 produced their working-tree state, but neither
committed. This spec produces the closing commit that captures all three
files plus the matrix updates.

## Verification Commands

```bash
# 1. Matrix preamble has Enforcement mechanism subsection
grep -A 6 "Enforcement mechanism" \
  plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md \
  | grep -F "scripts/verify-spec-reconciliation.sh"
grep -A 6 "Enforcement mechanism" \
  plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md \
  | grep -F "spec-reconciliation"
grep -A 6 "Enforcement mechanism" \
  plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md \
  | grep -F "bash scripts/verify-spec-reconciliation.sh"

# 2. Matrix preamble has CI guard self-test subsection
grep -A 6 "CI guard self-test" \
  plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md \
  | grep -E "https://github\.com/.*/actions/runs/" | wc -l   # >= 2

# 3. PR description summary row count = sum of matrix section rows
path=$(awk '/^## Path drift/,/^---$/' plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md | grep -cE "^\| SPEC-")
vitest=$(awk '/^## Vitest/,/^---$/' plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md | grep -cE "^\| SPEC-")
bats=$(awk '/^## Bats/,/^---$/' plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md | grep -cE "^\| SPEC-")
echo "Total: $((path + vitest + bats))"
# This total must equal the PR description's per-SPEC summary table row count.

# 4. Closing commit
git log -1 --pretty=%s | grep -F \
  "PLAN-031-4 verification script + CI guard"

# 5. Closing commit stages exactly 3 files
git log -1 --stat | tail -1   # "3 files changed, ..."
git show --name-only HEAD | tail -n +2 | sort > /tmp/staged.txt
cat <<EOF | sort > /tmp/expected.txt
scripts/verify-spec-reconciliation.sh
.github/workflows/ci.yml
plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md
EOF
diff /tmp/staged.txt /tmp/expected.txt   # must be empty

# 6. Verification script passes on the post-commit tree
bash scripts/verify-spec-reconciliation.sh
test "$?" = "0"
```

## Acceptance Criteria

```
Given the matrix sections from PLAN-031-1/2/3 are populated
When SPEC-031-4-03 authors the PR description's per-SPEC summary
Then the summary table appears at the top of the PR body
And the table is grouped by drift class (Path, Vitest, Bats)
And each row has SPEC ID, class, action summary, and a Diff link anchor
And the total row count equals the sum of rows across the three matrix sections
```

```
Given the summary table contains more than 30 rows
When the PR body is rendered
Then the bulk of the table is wrapped in a `<details>` block
And the first 5 rows per class remain visible as a preview (or all rows if a class has < 5)
```

```
Given three diff-link anchors are selected at random from the summary
When each anchor is clicked
Then the browser navigates to the correct diff hunk in the PR's Files Changed view
And the three click-test results are recorded in the matrix preamble
```

```
Given the matrix preamble is being updated
When the Enforcement mechanism subsection is added
Then it names `scripts/verify-spec-reconciliation.sh`
And it names the CI step `spec-reconciliation`
And it includes the local invocation hint `bash scripts/verify-spec-reconciliation.sh`
And it states that future SPECs reintroducing drift tokens will fail CI on this step
```

```
Given the CI guard self-test subsection is populated by SPEC-031-4-02's run URLs
When SPEC-031-4-03 reads the matrix preamble
Then both the red run URL (drift) and the green run URL (clean) are present
And a confirmation that the throwaway branch is deleted is recorded
```

```
Given all preceding state (script, workflow, matrix updates) is staged
When `git commit` runs
Then a single atomic commit is created on the TDD-031 branch
And the commit subject reads exactly:
  "docs(specs): PLAN-031-4 verification script + CI guard for SPEC reconciliation"
And the commit body lists the four checks, the five self-test results, the two CI run URLs, and the matrix preamble updates
And `git log -1 --stat` shows exactly 3 files changed:
  scripts/verify-spec-reconciliation.sh, .github/workflows/ci.yml, and PRD-016-spec-reconciliation.md
```

```
Given the verification script is run on the post-commit tree
When `bash scripts/verify-spec-reconciliation.sh` executes
Then it exits 0
And the final line of stdout is `PASS`
```

```
Given check (4) of the verification script surfaces a pre-existing path that does not resolve
When the surfaced count is <= 3
Then this spec reconciles each surfaced drift in this PR (matrix row + SPEC amendment in the PLAN-031-1 commit's scope)
And if the count > 3, the issue is escalated to the reviewer for a scoping decision before opening the PR
```

## Rollback Plan

If the closing commit captures the wrong file set (FR-8 violation):
```bash
git reset --soft HEAD^   # un-commit, keep changes staged
# Re-stage exactly the three intended files; re-commit with the same exact subject
```

If the matrix preamble updates are wrong:
```bash
git checkout -- plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md
# Re-author the Enforcement mechanism / CI guard self-test subsections
```

If the PR description summary is wrong (counts off, broken anchors):
- Edit the PR description directly via `gh pr edit <pr> --body-file
  /tmp/new-body.md` (or via the GitHub UI). No commit revert is needed
  for PR-description fixes.

If a fundamental issue requires PR-level rollback:
```bash
# After PR is open:
gh pr close <pr>
git push origin --delete docs/plans-from-tdd-031
# Restart from a clean main branch.
```

## Implementation Notes

- The PR description's per-SPEC summary is intentionally hand-authored
  (not auto-generated) per TDD §8.1. The matrix is the source of truth;
  the summary is a reviewer-friendly view of it. If a CLI exists later
  to generate the summary, it can be added as a PLAN-031-4 follow-up,
  but this spec ships the hand-authored version.
- Diff-link anchors take the form `#diff-<sha-of-file-path>`. GitHub
  generates these deterministically; you can construct them by hashing
  the file path with the same algorithm GitHub uses, OR (simpler) open
  the PR's Files Changed view, copy the anchor for each row, and paste
  it into the summary. Three click-tests confirm the latter approach
  worked.
- The closing commit is the LAST commit on the TDD-031 PR branch. After
  it lands, the PR is ready for review. Do NOT add follow-up commits
  to address review feedback by amending; create new commits per
  Git Safety Protocol.
- Per OQ-31-07: the script's check (4) may surface drift in SPECs
  unrelated to the three TDD-031 classes. The plan budget accommodates
  ≤3 such follow-ups in this PR. If the script reports >3, the issue
  is a scoping signal — the reviewer decides whether to expand
  TDD-031's scope or defer the additional drift to a follow-up PR.
- The "Approver" column in matrix rows defaults to `@pwatson` per
  PLAN-031-1's example. If the orchestrator config specifies a
  different default approver, all PLAN-031-* matrix rows use that
  value uniformly.
- The PR description summary's Action-summary column should be brief
  (one short phrase), not the full matrix Action string. Example:
  Path-drift row → `src/portal/ → plugins/autonomous-dev-portal/server/`;
  Vitest token row → `Vitest → Jest`; Bats case (b) → `Retired`.

## Out of Scope

- Authoring the verification script (handled by SPEC-031-4-01).
- Wiring the script into CI (handled by SPEC-031-4-02).
- The throwaway-branch self-test PR (handled by SPEC-031-4-02).
- The five local self-tests (handled by SPEC-031-4-01).
- Any SPEC-content amendments (PLAN-031-1/2/3 specs).
- Adding branch-protection configuration that requires the
  `spec-reconciliation` check (out of band; repo-admin task).
- Auto-generating the PR description summary from the matrix (TDD §8.1
  prefers hand-authored).
- Modifying any SPEC outside the OQ-31-07 follow-up budget (≤3
  surfaced-drift amendments).
