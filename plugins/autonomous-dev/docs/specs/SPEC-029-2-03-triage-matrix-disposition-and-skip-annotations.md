# SPEC-029-2-03: Triage Matrix — Disposition, Skip Annotations, and DELETE Execution

## Metadata
- **Parent Plan**: PLAN-029-2 (Test Failure Triage Matrix Authoring & Disposition)
- **Parent TDD**: TDD-029
- **Parent PRD**: PRD-016
- **Tasks Covered**: PLAN-029-2 Task 4 (disposition each row) + PLAN-029-2 Task 5 (land `describe.skip` / `it.skip` annotations) + PLAN-029-2 Task 6 (DELETE row execution, if any)
- **Estimated effort**: 2 days (~1 day disposition + ~0.5 day skip annotations + ~0.5 day DELETE execution; budget allows for 0 deletes in first pass)
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/docs/triage/PRD-016-test-failures.md` (modifications) plus per-row test-file modifications and DELETE-row file removals
- **Depends on**: SPEC-029-2-02 (provides every row with a populated `Category` and `Notes` hypothesis)

## Description

Decide and record the disposition (`FIX (this-PR)` / `FIX (next-PR)` / `FIX (next-sprint)` / `SKIP-WITH-NOTE` / `DELETE`) for every triage matrix row, name a single human Owner per row, link a SPEC id or follow-up issue, and **execute** the SKIP-WITH-NOTE and DELETE dispositions in code. After this spec ships, every row's Disposition / Owner / Linked cells are populated; every SKIP-WITH-NOTE row has a corresponding `describe.skip(...)` or `it.skip(...)` with a `// SKIP per PRD-016 triage row N: <reason>` comment in the test file; every DELETE row has the three FR-1613 fields populated and a corresponding `git rm` commit.

This is the largest spec in the PLAN-029-2 series and produces multiple commits (one per Task plus per-skip-annotation per-DELETE micro-commits). The granular commit discipline keeps individual file changes (especially `.skip` granularity) reviewable.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `docs/triage/PRD-016-test-failures.md` | Modify | Fill Disposition, Owner, Linked SPEC / Issue cells; expand Notes for DELETE rows; update Summary per-disposition counts |
| `plugins/autonomous-dev/tests/<paths>/<file>.test.ts` | Modify (per SKIP-WITH-NOTE row) | Convert targeted `describe(...)` to `describe.skip(...)` or `it(...)` to `it.skip(...)`; add `// SKIP per PRD-016 triage row N: <reason>` comment |
| `plugins/autonomous-dev/tests/<paths>/<file>.test.ts` | Delete (per DELETE row) | `git rm` after FR-1613 fields and approval are recorded |

Commits:

1. **Task 4 commit**: matrix Disposition / Owner / Linked / expanded-Notes update (one commit, all rows).
2. **Task 5 commits**: one commit per SKIP-WITH-NOTE row (small, reviewable diffs).
3. **Task 6 commits**: one commit per DELETE row (small, reviewable diffs; only if any DELETE rows exist).

## Implementation Details

### Task 4 — Disposition each row

For each row in the data table:

#### Step 1: Apply the disposition decision rules (TDD-029 §6.3)

| Row Category | Default Disposition | Notes |
|---|---|---|
| `harness-residue` | `FIX (this-PR)` | The PLAN-029-1 migration is the fix. The row records the diagnosis; no further code change required. |
| `regression` | `FIX (next-PR)` or `FIX (next-sprint)` | Per PRD-016 NG-01, regression fixes ship as separate PRs. Pick the bucket by severity: P0 → `next-PR`; P1/P2 → `next-sprint`. |
| `fixture` | `FIX (this-PR)` if trivially repairable in this PR (e.g., one-line fixture path typo); else `FIX (next-PR)` | Trivial fixture fixes can land here; non-trivial fixture rework defers. |
| `flake` | `SKIP-WITH-NOTE` | Pending the PLAN-029-4 5-rerun confirmation (FR-1615). Notes references the future flake-check workflow run. |
| `legacy` (production code under test is gone) | `DELETE` | Requires the three FR-1613 fields. |

#### Step 2: Fill the Disposition cell

Replace the Disposition `TBD` with the chosen value verbatim. Allowed values:

- `FIX (this-PR)`
- `FIX (next-PR)`
- `FIX (next-sprint)`
- `SKIP-WITH-NOTE`
- `DELETE`

The parens-bracketed ETA bucket on FIX rows is mandatory per FR-1611.

#### Step 3: Fill the Owner cell

Replace the Owner `TBD` with a single GitHub handle (e.g., `@pwatson`). Rules:

- Single human, not a team (`@team-name` is rejected).
- Not `TBD`. If no owner is identifiable, the row's category is suspect — re-open SPEC-029-2-02 categorisation rather than ship `TBD`.
- The Owner for a `regression` or `fixture` row is the human who will write the FIX in the linked PR / sprint.
- The Owner for a `SKIP-WITH-NOTE` row is the human responsible for re-evaluating the skip after PLAN-029-4 reruns.
- The Owner for a `harness-residue` row is the human who landed the SPEC-029-1-* commit that fixed it (typically `@pwatson` for this work).
- The Owner for a `DELETE` row MUST be different from the named approver in step 5.

#### Step 4: Fill the Linked SPEC / Issue cell

Replace the Linked `TBD` with one of:

- A SPEC id (e.g., `SPEC-006-3-02`) — for FIX rows whose follow-up work has an existing SPEC.
- A GitHub issue URL — for FIX rows whose follow-up work is tracked as an issue.
- `n/a` — for `harness-residue` rows where the SPEC-029-1-* migration commit IS the fix and there is no further work.
- `issue #TBD` — for `flake` rows pending PLAN-029-4 (the issue id is filled when PLAN-029-4 lands; a `TBD` here is permitted ONLY for this case and is documented in Notes).

#### Step 5: For DELETE rows, expand the Notes cell with the FR-1613 three fields

If Disposition is `DELETE`, the Notes cell expands from a one-line hypothesis into a multi-field block. Format:

```
legacy-rationale: <why the test is legacy; cite the TDD that removed the production code if applicable>; prod-code-status: <live | removed-in-<commit-or-PR>>; approved-by: @<handle> on YYYY-MM-DD
```

The three fields are semicolon-separated on one cell line. Markdown table cells do not split across visual rows; semicolons keep the cell parseable.

The `approved-by` handle MUST be different from the row's Owner (FR-1613). The approver's sign-off MUST be a captured PR comment from the named handle (e.g., a GitHub PR review or comment on the Spec PR that reads "approve DELETE for row N"). The approval date is the date of the comment.

#### Step 6: Update the Summary

After all rows have Disposition / Owner / Linked filled, update the Summary section:

```
- Generated from `npx jest --runInBand` run on YYYY-MM-DD; N rows.
- Per-category counts: regression=X, fixture=Y, flake=Z, harness-residue=W. (from SPEC-029-2-02)
- Per-disposition counts: FIX(this-PR)=A, FIX(next-PR)=B, FIX(next-sprint)=C, SKIP-WITH-NOTE=D, DELETE=E.
```

`A + B + C + D + E` MUST equal the row count `N`.

#### Step 7: Sanity checks

```
$ grep -cE "^\| [0-9]+ \|.*\| TBD \|" docs/triage/PRD-016-test-failures.md
0    # zero TBD values anywhere

$ grep -cE "^\| [0-9]+ \|.*\| FIX \(.*\) \|.*\| @[a-zA-Z0-9-]+ \|" docs/triage/PRD-016-test-failures.md
A+B+C    # FIX rows with a parens-bucketed ETA and a @-handle Owner

$ grep -cE "^\| [0-9]+ \|.*\| SKIP-WITH-NOTE \|" docs/triage/PRD-016-test-failures.md
D    # equals SKIP-WITH-NOTE count

$ grep -cE "^\| [0-9]+ \|.*\| DELETE \|.*\| approved-by: @" docs/triage/PRD-016-test-failures.md
E    # equals DELETE count; every DELETE has approved-by
```

#### Step 8: Task 4 commit

```
docs(triage): disposition PRD-016 triage matrix rows (FIX/SKIP/DELETE)

For each of N rows in docs/triage/PRD-016-test-failures.md:
  - Fill Disposition with one of {FIX (this-PR), FIX (next-PR),
    FIX (next-sprint), SKIP-WITH-NOTE, DELETE}.
  - Fill Owner with a single @-handle.
  - Fill Linked SPEC / Issue with a SPEC id, issue URL, or n/a
    (issue #TBD permitted only for flake rows pending PLAN-029-4).
  - Expand Notes with FR-1613 three fields for DELETE rows.

Per-disposition counts:
  FIX(this-PR)=A, FIX(next-PR)=B, FIX(next-sprint)=C,
  SKIP-WITH-NOTE=D, DELETE=E. Total: N.

SKIP-WITH-NOTE annotations and DELETE file removals follow as
per-row commits in this spec.

Refs PRD-016 FR-1610, FR-1611, FR-1613; TDD-029 §6.3; PLAN-029-2 Task 4.
```

### Task 5 — Land `describe.skip` / `it.skip` annotations

For each row with Disposition `SKIP-WITH-NOTE`, in Row order:

#### Step 1: Identify granularity

Read the test file at the row's Suite path. Decide whether to skip:

- The whole `describe(...)` block (use `describe.skip(...)`), if the entire suite is the failure unit.
- A single `it(...)` block (use `it.skip(...)`), if only one case fails and the suite is otherwise green.

The row's Notes column already records granularity hints from SPEC-029-2-02 (e.g., "test_register_agent fails; rest pass"). Honor it.

#### Step 2: Apply the skip and the comment

Insert an inline comment on the line immediately above the targeted `describe` or `it`:

```ts
// SKIP per PRD-016 triage row 17: timer-mock leak; tracked in issue #TBD
describe.skip('CoordinatorSuite', () => {
  // ...
});
```

Or for a single case:

```ts
describe('CoordinatorSuite', () => {
  // SKIP per PRD-016 triage row 17: timer-mock leak; tracked in issue #TBD
  it.skip('handles concurrent ticks', async () => {
    // ...
  });
});
```

The comment text MUST:

1. Start with `// SKIP per PRD-016 triage row N:` where `N` is the row id (a single integer).
2. Include a one-line reason matching the row's Notes column (modulo trimming to one line).

Do NOT add extra blank lines around the skip. Do NOT remove the original test body — `describe.skip` / `it.skip` keeps the body but jest reports the suite as pending.

#### Step 3: Verify the skip

```
$ cd plugins/autonomous-dev
$ npx jest <suite-path> --runInBand
```

Expected:

- jest emits a `pending` or skipped count for the targeted block.
- jest does NOT emit a FAIL for the targeted block.
- All other blocks in the same file behave as before.

#### Step 4: Per-row commit

Each SKIP-WITH-NOTE annotation lands as its own commit. The diff is one or two lines (the `.skip` and the comment). Body:

```
test(skip): row N SKIP-WITH-NOTE — <suite-path> <describe-or-it-name>

<one-line reason verbatim from Notes>

This skip lives until row N's Owner re-evaluates after PLAN-029-4's
flake-check rerun (or the linked SPEC / issue ships a fix).

Refs PRD-016 FR-1612, triage row N; TDD-029 §6.3; PLAN-029-2 Task 5.
```

### Step 5: Verify the SKIP count invariant

After all SKIP-WITH-NOTE annotations land:

```
$ git grep -c "SKIP per PRD-016 triage row" plugins/autonomous-dev/tests/
D    # MUST equal the SKIP-WITH-NOTE row count from Task 4
```

Mismatches block review. Common causes:

- A skip comment was forgotten on a row (count too low).
- A skip comment was duplicated across two test files (count too high).
- A skip comment used the wrong row id (no count change but matrix consistency broken).

If the count mismatches, find the missing/extra commit and fix it (add or remove the skip; re-commit).

### Task 6 — DELETE row execution

For each row with Disposition `DELETE`, in Row order:

#### Step 1: Confirm the FR-1613 fields are present

Re-read the row's Notes cell. All three fields (legacy-rationale, prod-code-status, approved-by) MUST be present. If any is missing, return to Task 4 step 5 and fix the matrix BEFORE deleting any file.

#### Step 2: Confirm the approval is captured

The approver named in the `approved-by` field MUST have left a PR comment on the SPEC-029-2-03 PR explicitly approving the DELETE for row N. A Slack screenshot does not suffice; the approval is a permanent record in the PR. If approval is not captured, do NOT delete; surface the gap as a PR comment and pause.

#### Step 3: Delete the test file

```
$ git rm plugins/autonomous-dev/tests/<path>/<file>.test.ts
```

#### Step 4: Per-row DELETE commit

```
test(delete): row N DELETE — <suite-path>

legacy-rationale: <verbatim from row's Notes>
prod-code-status: <verbatim from row's Notes>
approved-by: @<handle> on YYYY-MM-DD (PR comment <permalink-or-id>)

Refs PRD-016 FR-1613, triage row N; TDD-029 §6.3; PLAN-029-2 Task 6.
```

The commit body MUST cite all three FR-1613 fields. The commit MUST NOT bundle the deletion with any other change.

### What NOT to do

- Do NOT bulk-rewrite Disposition / Owner / Linked across all rows in a single sweep without verifying each row's Category aligns with the chosen Disposition. The decision rules from Task 4 step 1 are per-row.
- Do NOT collapse multiple SKIP-WITH-NOTE annotations into a single commit. The per-row commit discipline keeps each `.skip` diff small (1-2 lines) and reviewable. A single-commit sweep hides granularity errors.
- Do NOT skip more than the Notes column says to skip. If Notes says "test_register_agent fails", do NOT use `describe.skip` to suppress the whole suite. Wider skips are reviewer-rejected per PLAN-029-2 R-205.
- Do NOT delete a file before all three FR-1613 fields are populated AND the named approver has commented approval on the PR. Bulk DELETEs are explicitly rejected at review (FR-1613).
- Do NOT use `xdescribe` / `xit`. Use `describe.skip` / `it.skip`. The grep `git grep -c "SKIP per PRD-016 triage row"` searches for the comment, but reviewers will reject `xit` style as inconsistent with the project's jest convention.
- Do NOT modify a `.skip`'d test's body. The skip preserves the body so a future re-enable is a one-line `.skip` removal.
- Do NOT widen scope to fix any FAIL row in this spec. Per PRD-016 NG-01, regression fixes ship as separate PRs. The Disposition `FIX (next-PR)` is the contract.

## Acceptance Criteria

Disposition (Task 4):

- [ ] Every row in `docs/triage/PRD-016-test-failures.md` has a `Disposition` cell drawn from `{FIX (this-PR), FIX (next-PR), FIX (next-sprint), SKIP-WITH-NOTE, DELETE}`. No `TBD` values.
- [ ] Every row has an `Owner` cell with exactly one GitHub handle in `@<handle>` form. No teams, no `TBD`.
- [ ] Every row has a `Linked SPEC / Issue` cell. `n/a` allowed for `harness-residue` rows; `issue #TBD` allowed only for `flake` rows pending PLAN-029-4.
- [ ] Every FIX row has a parens-bracketed ETA bucket (`(this-PR)`, `(next-PR)`, or `(next-sprint)`).
- [ ] Every DELETE row's Notes cell contains all three FR-1613 fields (`legacy-rationale:`, `prod-code-status:`, `approved-by:`), separated by semicolons.
- [ ] Every DELETE row's Owner is different from the `approved-by` handle.
- [ ] Summary section's per-disposition counts equal the actual row distribution; sum equals total row count.
- [ ] `grep -cE "^\| [0-9]+ \|.*\| TBD \|" docs/triage/PRD-016-test-failures.md` returns 0.
- [ ] Task 4 commit body matches the §Task 4 step 8 template; references `PRD-016 FR-1610, FR-1611, FR-1613; TDD-029 §6.3; PLAN-029-2 Task 4`.

SKIP annotations (Task 5):

- [ ] Every SKIP-WITH-NOTE row has a corresponding `describe.skip(...)` or `it.skip(...)` in the test file at the row's Suite path.
- [ ] Every skip is preceded by `// SKIP per PRD-016 triage row N: <reason>` on the line immediately above; the row id matches the matrix; the reason matches the matrix's Notes column.
- [ ] `git grep -c "SKIP per PRD-016 triage row" plugins/autonomous-dev/tests/` equals the SKIP-WITH-NOTE row count from the matrix.
- [ ] Each SKIP-WITH-NOTE annotation lands as its own commit (one row → one commit). Verified by `git log --oneline` showing one commit per row.
- [ ] Each SKIP commit body matches the §Task 5 step 4 template; references `PRD-016 FR-1612, triage row N; TDD-029 §6.3; PLAN-029-2 Task 5`.
- [ ] `npx jest <suite-path> --runInBand` for each SKIP-WITH-NOTE suite reports the targeted block as `pending` / skipped (not FAIL).
- [ ] No skip is wider than the Notes column documents (no `describe.skip` covering a whole suite when only one `it` was meant to be skipped).

DELETE execution (Task 6):

- [ ] Every DELETE row has a corresponding `git rm` commit deleting the test file at the row's Suite path.
- [ ] Each DELETE commit body cites all three FR-1613 fields and the approver's PR-comment permalink/id.
- [ ] Each DELETE commit's diff is exactly the file deletion (no other changes bundled).
- [ ] No file is deleted whose row's Notes cell is missing any of the three FR-1613 fields.
- [ ] No file is deleted whose `approved-by` handle did not actually leave a PR comment approving the DELETE.

Cross-cutting:

- [ ] Total commit count on this spec's branch range: 1 (Task 4 matrix update) + D (one per SKIP) + E (one per DELETE), where D and E are the counts from the matrix Summary.
- [ ] No production-code files modified. Verified by `git diff --name-only HEAD~<commit-count>..HEAD | grep -v "tests/\|docs/triage/"` returning nothing.

## Dependencies

- **Blocked by**: SPEC-029-2-02 (categorisation; Disposition decision depends on Category).
- **Blocks**: SPEC-029-2-04 (final coherence pass). The end-state jest run requires every FAIL row to be SKIP-WITH-NOTE-annotated or DELETED; un-skipped FAILs would break SPEC-029-2-04's acceptance.
- **Blocks**: SPEC-029-3-02, SPEC-029-3-04 (CI gate). The `--ci` flag turns the build red on any non-skipped failure; until this spec lands skips for every dispositioned failure, the CI gate cannot ship green.

## Notes

- This spec is the longest in the PLAN-029-2 series because it produces multiple commits across multiple files. Budget the day per the §Estimated effort cell rather than trying to squeeze it into a single sitting; the small-commit discipline benefits from fresh attention per row.
- The `git grep -c "SKIP per PRD-016 triage row"` invariant is the spec's keystone consistency check. If the grep count drifts from the matrix's SKIP-WITH-NOTE count at any time during implementation, stop and reconcile before continuing.
- The "approver must be different from owner" rule for DELETE (FR-1613) is a two-person-integrity guard. It is not optional. Self-approved DELETEs are explicitly rejected at review.
- `FIX (this-PR)` for `harness-residue` rows is conceptually accurate but the actual fix landed in SPEC-029-1-* commits. The Disposition cell records the disposition that ships with this PR — the row is "FIXED in this PR" in the sense that no further FAIL action is needed. The Notes column from SPEC-029-2-02 already documents the harness-residue diagnosis.
- A `flake` row's Linked cell value of `issue #TBD` is the only legitimate `TBD`-flavored value in the post-disposition matrix. PLAN-029-4 is the spec where that issue id materialises; this spec's contract is to hand off the row, not block on PLAN-029-4.
- If a `regression` row's severity is uncertain (P0 vs P1+), default to `FIX (next-PR)`. `next-sprint` is a longer commitment; choosing `next-PR` is conservative.
- A reviewer's checklist for this PR: (1) eyeball every row's Disposition vs Category for consistency, (2) `git grep -c "SKIP per PRD-016 triage row"` and confirm the count matches the matrix, (3) for each DELETE commit, click through to the approver's PR comment, (4) read every skip's Notes line and confirm the reason is concrete enough to act on after a PLAN-029-4 rerun.
- The expected SKIP-WITH-NOTE count is small (~5-10 from the FR-1614 named flake suspects). The expected DELETE count for the first pass is 0. These low counts make the per-row commit overhead manageable.
