# SPEC-031-1-03: Path-Drift Matrix Population, Spot-Check, and Commit

## Metadata
- **Parent Plan**: PLAN-031-1 (path-drift sweep)
- **Parent TDD**: TDD-031-spec-reconciliation-path-vitest-bats (§5.1, §6.5, §8.1)
- **Parent PRD**: PRD-016-test-suite-stabilization (G-07, FR-1650, G-3105)
- **Tasks Covered**: PLAN-031-1 task 4 (matrix rows), task 5 (spot-check), task 6 (commit)
- **SPECs amended by this spec**: 0 SPECs under docs/specs/ (this spec only writes to the matrix file)
- **Estimated effort**: 50 minutes (~30 min matrix rows + ~15 min spot-check + ~5 min commit)
- **Status**: Draft
- **Depends on**: SPEC-031-1-02 (sed sweep applied; modified-SPEC list staged but not committed)

## Summary
Record every amended SPEC from SPEC-031-1-02's sweep as a row in the
`## Path drift (PLAN-031-1)` section of the reconciliation matrix, perform
a 3-SPEC spot-check confirming substituted paths resolve to extant files,
and produce the single atomic commit that closes PLAN-031-1.

## Functional Requirements

- **FR-1**: For every SPEC modified by SPEC-031-1-02, a row MUST be appended
  to the `## Path drift (PLAN-031-1)` section of
  `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md`.
  Row format:
  ```
  | SPEC-NNN-N-NN | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | <notes> |
  ```
  Task: PLAN-031-1 task 4.
- **FR-2**: The row count in the Path drift section MUST equal the
  modified-SPEC count from `git diff --stat plugins/autonomous-dev/docs/specs/`
  (post-SPEC-031-1-02). Mismatches are hard failures.
- **FR-3**: Rows MUST be sorted alphabetically by SPEC ID.
- **FR-4**: Three amended SPECs MUST be selected at random and spot-checked:
  for each, identify a `plugins/autonomous-dev-portal/server/...` path in
  the diff, run `test -e <path>`, and record the SPEC ID + path + result
  in the matrix preamble's "Spot-checks" subsection. Task: PLAN-031-1 task 5.
- **FR-5**: Any SPEC where the substituted path's target does NOT exist
  (per `test -e`) MUST receive a row whose Notes column flags it as Open
  Question OQ-31-03 follow-up. The SPEC content is NOT amended further by
  this spec (TDD §5.4 reliability principle).
- **FR-6**: A single atomic commit MUST be created on the TDD-031 branch
  with the exact message:
  ```
  docs(specs): PLAN-031-1 path-drift sweep — src/portal → plugins/autonomous-dev-portal/server (~17 SPECs)
  ```
  The commit body MUST list the affected-SPEC count, the verification grep
  result (`zero remaining`), and the three spot-check results. Task:
  PLAN-031-1 task 6.

## Non-Functional Requirements

| Requirement | Target | Measurement Method |
|-------------|--------|---------------------|
| Matrix table well-formed | All rows have exactly 5 columns separated by `\|` | `awk -F'\|' 'NF != 7' <matrix>` returns no rows in the Path drift section |
| Row sort order | Alphabetic by SPEC ID | `sort -c` on the SPEC ID column passes |
| Commit atomicity | Single commit, no preceding/following tag | `git log -1 --stat` shows ~18 files (17 SPECs + 1 matrix file) |
| Spot-check coverage | 3 distinct SPECs, each with a checked path | Matrix preamble lists 3 named SPECs with `test -e` results |

## Patterns to Find/Replace

This spec performs **no SPEC content substitutions**. It only writes to the
matrix file.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md` | Modify | Append rows to `## Path drift (PLAN-031-1)` section; populate spot-check log in preamble |

## Verification Commands

```bash
# 1. Count amended SPECs from SPEC-031-1-02's staged changes
amended=$(git diff --name-only --cached plugins/autonomous-dev/docs/specs/ | wc -l)
echo "Amended SPECs: $amended"

# 2. Count Path drift rows in the matrix (excludes header + separator lines)
rows=$(awk '/^## Path drift/,/^---$/' plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md \
  | grep -E "^\| SPEC-" | wc -l)
echo "Path drift rows: $rows"

# 3. Row count must equal amended-SPEC count
test "$amended" = "$rows"

# 4. Rows are sorted alphabetically
awk '/^## Path drift/,/^---$/' plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md \
  | grep -E "^\| SPEC-" | awk -F'|' '{print $2}' | sort -c

# 5. Spot-check section is populated (3 SPECs named)
grep -A 5 "Path drift (PLAN-031-1 task 5)" plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md \
  | grep -c "SPEC-"   # must be >= 3

# 6. Commit produced
git log -1 --pretty=%s | grep -F "PLAN-031-1 path-drift sweep"
```

## Acceptance Criteria

```
Given SPEC-031-1-02 staged ~17 amended SPECs
When the matrix Path drift section is populated
Then the section contains one row per amended SPEC
And the row count equals the staged-SPEC count exactly
And each row's Action column reads `s|src/portal/|plugins/autonomous-dev-portal/server/|`
And rows are sorted alphabetically by SPEC ID
```

```
Given three amended SPECs are selected at random for spot-checking
When each spec is opened and a `plugins/autonomous-dev-portal/server/...` path is extracted
Then `test -e <path>` is executed for that path
And the result (PASS or FAIL) is recorded in the matrix preamble's spot-check section
And all three SPECs are named with their checked paths
```

```
Given a spot-checked path does NOT exist (test -e returns 1)
When the matrix row for that SPEC is written
Then the Notes column flags the row as Open Question OQ-31-03
And the SPEC content is NOT amended further in this spec
And the row is still counted in the row total (not skipped)
```

```
Given the matrix is fully populated and spot-checks are recorded
When `git commit` runs
Then a single atomic commit is created on branch docs/plans-from-tdd-031 (or sub-branch)
And the commit subject reads exactly:
  "docs(specs): PLAN-031-1 path-drift sweep — src/portal → plugins/autonomous-dev-portal/server (~17 SPECs)"
And the commit body lists the affected-SPEC count, the verification grep result, and the three spot-check results
And `git log -1 --stat` shows ~18 files changed (17 SPECs + 1 matrix file)
```

```
Given the audit count from SPEC-031-1-01 is N
When matrix population completes
Then the matrix preamble's "Audit counts" row for Path drift shows Observed=N
And if |N - 17| > 3, the Notes column contains a divergence note
```

## Rollback Plan

If the matrix rows are incorrectly populated (wrong count, missing rows, bad
sort order), revert the matrix file:
```bash
git checkout -- plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md
```
The SPEC-031-1-02 changes remain staged for re-population.

If the commit has been created and a problem surfaces:
```bash
git reset --soft HEAD^   # un-commit, keep changes staged
# fix issues, then re-commit
```

PR-level revert (if the PR is already open):
```bash
git revert <commit-sha>
```
This restores the SPEC corpus exactly to its pre-PLAN-031-1 state.

## Implementation Notes

- The matrix is the source of truth for the PR description's per-SPEC summary
  (PLAN-031-4 task 5 reads it). Get the format right here so PLAN-031-4 does
  not need to re-process the data.
- The "Approver" column defaults to `@pwatson` per PLAN-031-1's example. Adjust
  if the orchestrator config specifies a different default approver.
- For spot-check selection, use a deterministic-but-unbiased method (e.g.,
  `awk` over the staged-file list with a fixed seed, or pick first / middle /
  last). Document the selection method in the matrix preamble for
  reproducibility.
- The TDD OQ-31-03 case (substituted path does not exist because file was
  renamed, not relocated) is expected to be rare but not zero. Do not invent
  a path; do not delete the cite. Flag in Notes; PLAN-031-4 handles via
  verification script.

## Out of Scope

- Re-applying or modifying the sed substitution (handled by SPEC-031-1-02).
- Vitest, bats, or `vi.*` amendments.
- Authoring the verification script (PLAN-031-4 / SPEC-031-4-01).
- Fixing SPECs whose substituted paths don't resolve (TDD OQ-31-03; deferred).
- Production code changes (NG-3103).
- Re-deriving SPEC content (NG-3101).
