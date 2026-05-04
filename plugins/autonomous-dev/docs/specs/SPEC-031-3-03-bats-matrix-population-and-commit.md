# SPEC-031-3-03: Bats Matrix Population, Spot-Check, and Commit

## Metadata
- **Parent Plan**: PLAN-031-3 (bats → jest reconciliation)
- **Parent TDD**: TDD-031-spec-reconciliation-path-vitest-bats (§5.3, §6.5, §8.1, §9.3)
- **Parent PRD**: PRD-016-test-suite-stabilization (G-08, FR-1652, G-3105)
- **Tasks Covered**: PLAN-031-3 task 4 (matrix rows), task 5 (spot-check), task 6 (commit)
- **SPECs amended by this spec**: 0 SPECs under docs/specs/ (this spec only writes to the matrix file and commits)
- **Estimated effort**: 50 minutes (~30 min matrix rows + ~15 min spot-check + ~5 min commit)
- **Status**: Draft
- **Depends on**: SPEC-031-3-02 (per-SPEC amendments staged but not committed)

## Summary
Record every amended SPEC from SPEC-031-3-02 as a row in the
`## Bats (PLAN-031-3)` section of the reconciliation matrix, perform a
3-SPEC spot-check (one case (a), one case (b), one Notes-flagged) to
confirm classification correctness and prose naturalness, and produce the
single atomic commit that closes PLAN-031-3.

## Functional Requirements

- **FR-1**: For every SPEC modified by SPEC-031-3-02, a row MUST be appended
  to the `## Bats (PLAN-031-3)` section of
  `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md`.
  Row format:
  ```
  | SPEC-NNN-N-NN | Bats | (a) → <jest path>     | @pwatson | <notes> |
  | SPEC-NNN-N-NN | Bats | (b) Retired           | @pwatson | <notes> |
  | SPEC-NNN-N-NN | Bats | Historical            | @pwatson | <notes> |
  ```
  Task: PLAN-031-3 task 4.
- **FR-2**: The Action column MUST clearly classify each row as case (a),
  case (b), or Historical. Free-text Action strings that do not start with
  one of these three tokens are rejected at review.
- **FR-3**: For every case-(a) row, the cited Jest path MUST resolve at
  commit time:
  ```bash
  test -e "$jest_path"
  ```
  This re-verifies SPEC-031-3-01's gate (FR-4) at the moment of commit;
  any failure here indicates the file was renamed/moved between SPEC-031-3-01
  and SPEC-031-3-03. Such rows MUST be downgraded to case (b) with a Notes
  annotation citing OQ-31-03 before the commit lands.
- **FR-4**: The row count in the Bats section MUST equal the modified-SPEC
  count from `git diff --name-only --cached plugins/autonomous-dev/docs/specs/`
  PLUS the count of Historical-classified SPECs (which still appear in the
  matrix even though they may have minimal diffs).
- **FR-5**: Rows MUST be sorted alphabetically by SPEC ID.
- **FR-6**: Three amended SPECs MUST be selected for spot-checking, one of
  each Action sub-class:
  - One case (a)
  - One case (b)
  - One Historical OR one row whose Notes column flags a partial match
  Each spot-check MUST record: SPEC ID, the action applied, a one-line
  reviewer note confirming naturalness per TDD §9.3, and (for case (a))
  the result of `test -e <jest-path>`. Logged in the matrix preamble's
  Bats-section "Spot-checks" subsection. Task: PLAN-031-3 task 5.
- **FR-7**: A single atomic commit MUST be created on the TDD-031 branch
  with the exact message:
  ```
  docs(specs): PLAN-031-3 bats → jest reconciliation (~15 SPECs; case-(a)/(b) per-file decisions)
  ```
  The commit body MUST list:
  - Case-(a) count
  - Case-(b) count
  - Historical count (if non-zero)
  - The three spot-check results
  Task: PLAN-031-3 task 6.

## Non-Functional Requirements

| Requirement | Target | Measurement Method |
|-------------|--------|---------------------|
| Matrix table well-formed | Every row has 5 columns separated by `\|` | `awk -F'\|' 'NF != 7'` over the Bats section returns no rows |
| Row sort order | Alphabetic by SPEC ID | `sort -c` on the SPEC ID column passes |
| Action-column conformance | Every Action value starts with `(a)`, `(b)`, or `Historical` | `awk` extraction and grep validation |
| Case-(a) path-existence at commit | 100% pass | Loop over case-(a) rows; `test -e` each |
| Commit atomicity | Single commit | `git log -1 --stat` shows only the SPECs from SPEC-031-3-02 + the matrix file |

## Patterns to Find/Replace

This spec performs **no SPEC content substitutions**. It only writes to
the matrix file and produces the commit.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md` | Modify | Append rows to `## Bats (PLAN-031-3)` section; populate Bats spot-check log |

## Verification Commands

```bash
# 1. Count amended SPECs from SPEC-031-3-02's staged changes
amended=$(git diff --name-only --cached plugins/autonomous-dev/docs/specs/ | wc -l)
echo "Amended SPECs: $amended"

# 2. Count Bats rows in the matrix
rows=$(awk '/^## Bats \(PLAN-031-3\)/,/^---$/' \
  plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md \
  | grep -E "^\| SPEC-" | wc -l)
echo "Bats rows: $rows"

# 3. Row count must equal amended-SPEC count (modulo Historical inflation)
test "$amended" -le "$rows"   # rows >= amended (Historical may add)

# 4. Action column conformance
awk '/^## Bats \(PLAN-031-3\)/,/^---$/' \
  plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md \
  | grep -E "^\| SPEC-" | awk -F'|' '{print $4}' | \
  grep -vE "^\s*(\(a\)|\(b\)|Historical)" \
  && { echo "FAIL: non-conformant Action values"; exit 1; } || true

# 5. Sort order
awk '/^## Bats \(PLAN-031-3\)/,/^---$/' \
  plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md \
  | grep -E "^\| SPEC-" | awk -F'|' '{print $2}' | sort -c

# 6. Case-(a) path-existence re-verification at commit time
awk '/^## Bats \(PLAN-031-3\)/,/^---$/' \
  plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md \
  | grep -E "^\| SPEC-.* \(a\) → " | \
  sed -E 's/.*\(a\) → ([^ |]+).*/\1/' | \
  while read p; do test -e "$p" || echo "MISSING: $p"; done

# 7. Spot-check section is populated (3 SPECs named)
grep -A 5 "Bats (PLAN-031-3 task 5)" \
  plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md \
  | grep -c "SPEC-"   # must be >= 3

# 8. Commit produced with exact subject
git log -1 --pretty=%s | grep -F \
  "PLAN-031-3 bats → jest reconciliation"
```

## Acceptance Criteria

```
Given SPEC-031-3-02 staged ~15 amended SPECs
When SPEC-031-3-03 populates the matrix Bats section
Then the section contains one row per amended SPEC plus any Historical-classified rows
And every row's Action column starts with `(a)`, `(b)`, or `Historical`
And rows are sorted alphabetically by SPEC ID
```

```
Given a row in the Bats section is classified case (a)
When SPEC-031-3-03 verifies the row at commit time
Then `test -e <jest-path>` returns 0 for the row's Jest path
And if it returns 1, the row is downgraded to case (b) with an OQ-31-03 Notes annotation BEFORE the commit lands
```

```
Given three amended SPECs are selected for spot-checking, one per Action sub-class
When the reviewer reads each amended passage
Then naturalness per TDD §9.3 is confirmed (no orphaned "Bats" word, no broken sentences, retirement note reads grammatically)
And for the case-(a) SPEC, `test -e <jest-path>` is executed and the result recorded
And the SPEC ID, action, naturalness verdict, and (where applicable) test-e result are written to the matrix preamble
```

```
Given the matrix is populated and spot-checks recorded
When `git commit` runs
Then a single atomic commit is created on the TDD-031 branch
And the commit subject reads exactly:
  "docs(specs): PLAN-031-3 bats → jest reconciliation (~15 SPECs; case-(a)/(b) per-file decisions)"
And the commit body lists case-(a) count, case-(b) count, Historical count (if non-zero), and the three spot-check results
And `git log -1 --stat` shows the amended SPECs plus the matrix file (no other files)
```

```
Given a case-(b) row's Notes column claims "no Jest replacement"
When the reviewer reads the row
Then the Notes column states what was searched (e.g., "find . -name *.test.ts | grep daemon") and why no clean match exists
And the row is internally consistent: Action says `(b) Retired` and Notes does NOT cite a Jest path
```

```
Given a SPEC was classified Historical in SPEC-031-3-01
When SPEC-031-3-03 records the row
Then the row's Action column is `Historical`
And the SPEC is added to the matrix preamble's Historical whitelist for PLAN-031-4's grep
And the row's Notes column briefly explains why the SPEC is historical context (e.g., "alternative considered, retained verbatim per §X.Y")
```

## Rollback Plan

If matrix rows are incorrectly populated (wrong count, missing rows, bad
sort order, non-conformant Action values), revert the matrix file:
```bash
git checkout -- plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md
```
The SPEC-031-3-02 changes remain staged for re-population.

If the commit has been created and a problem surfaces:
```bash
git reset --soft HEAD^   # un-commit, keep changes staged
# fix issues, then re-commit with the same exact subject
```

PR-level revert (if the PR is already open):
```bash
git revert <commit-sha>
```
This restores the SPEC corpus exactly to its pre-PLAN-031-3 state.

## Implementation Notes

- The matrix is the source of truth for the PR description's per-SPEC summary
  (PLAN-031-4 task 5 reads it). Action-column conformance matters because
  PLAN-031-4 groups rows by class.
- Historical rows expand the row count beyond the diff count; this is
  expected. The verification commands account for the asymmetry by using
  `>=` rather than `=`.
- Spot-check selection: the three sub-classes (a / b / Historical-or-Notes)
  are intentional — together they cover the dominant failure modes
  (misclassification, partial match, historical erasure). If the decision
  list contains zero Historical rows, substitute a case-(b) Notes-flagged
  row to maintain the three-class coverage.
- The "Approver" column defaults to `@pwatson` per PLAN-031-3's example.
  Adjust if the orchestrator config specifies a different default.
- Per TDD §6.4 reliability principle: each Bats row is one revertable unit.
  If a misclassification is found post-merge, the row can be amended in a
  follow-up PR without re-running the entire reconciliation.

## Out of Scope

- Re-applying or modifying the per-SPEC amendments (handled by SPEC-031-3-02).
- Audit and case classification (handled by SPEC-031-3-01).
- Path-drift or vitest amendments (PLAN-031-1 / PLAN-031-2).
- The verification script and CI guard (PLAN-031-4).
- Fixing SPECs whose case-(a) Jest paths fail FR-3 with no obvious downgrade
  (these become matrix Open Questions; resolution is a follow-up PR).
- Production code changes (NG-3103).
- Re-deriving SPEC content (NG-3101).
