# PLAN-029-2: Test Failure Triage Matrix Authoring & Disposition

| Field                | Value                                                              |
|----------------------|--------------------------------------------------------------------|
| **Parent TDD**       | TDD-029: Jest Harness Migration, Failure Triage, and CI Gate       |
| **Parent PRD**       | PRD-016: Test-Suite Stabilization & Jest Harness Migration         |
| **Plan ID**          | PLAN-029-2                                                         |
| **Version**          | 1.0                                                                |
| **Date**             | 2026-05-02                                                         |
| **Status**           | Draft                                                              |
| **Priority**         | P0                                                                 |
| **Estimated effort** | 3 days                                                             |
| **Sibling plans**    | PLAN-029-1 (harness migration), PLAN-029-3 (CI gate)               |

## Objective

Author `docs/triage/PRD-016-test-failures.md` and populate it with one row per FAIL suite
surfaced by the post-migration `npx jest --runInBand` run captured in PLAN-029-1 Task 6.
Each row gets a category (`regression` / `fixture` / `flake` / `harness-residue`), a
disposition (`FIX` / `SKIP-WITH-NOTE` / `DELETE`), a named owner, a linked SPEC or
follow-up issue, and a one-line root-cause hypothesis. For SKIP-WITH-NOTE rows, this plan
also lands the `describe.skip` / `it.skip` annotations in the migrated suites with the
mandated `// SKIP per PRD-016 triage row N: <reason>` comment so the rationale travels
with the code (FR-1612). The plan deliverable bridges PLAN-029-1's "we can now see all
the failures" to PLAN-029-3's "CI fails on any non-skipped failure."

## Scope

### In Scope

- Create `docs/triage/PRD-016-test-failures.md` (and `docs/triage/` directory) at repo
  root per TDD-029 §6.1. Path is repo-root, not `plugins/autonomous-dev/docs/`, because
  the matrix covers both the autonomous-dev plugin and any portal-side suites.
- Populate the matrix per TDD-029 §6.1 schema:
  - Columns: Row, Suite path, Category, Disposition, Owner, Linked SPEC / Issue, Notes.
  - Row IDs are monotonic integers; they double as citation keys for SKIP comments.
- Cover at minimum the 11 named suites from PRD-016 FR-1614:
  `parallel/*`, `agent-factory/improvement/*` (subset), `notifications/*`,
  `escalation/response-handler.integration`, `safety/security-audit`,
  `intake/__tests__/core/reconciliation_repair`, `intake/notifications/notification_engine`,
  `tests/core/test_handoff_manager`, `full-collection-run`, `governance-lifecycle`,
  `scrub-integration`. Plus every additional FAIL suite surfaced by the PLAN-029-1
  post-migration run.
- Apply the FR-1611 / FR-1612 / FR-1613 disposition rules:
  - **FIX** rows include an ETA bucket (`this-PR` / `next-PR` / `next-sprint`) and a
    one-line root-cause hypothesis.
  - **SKIP-WITH-NOTE** rows are landed in the test files as `describe.skip(...)` or
    `it.skip(...)` with a comment `// SKIP per PRD-016 triage row N: <reason>`. The
    matrix Notes column references the line where the skip lives.
  - **DELETE** rows include all three required fields per FR-1613: legacy rationale,
    proof the production code under test is gone (or unchanged), and a named approver
    distinct from the row's Owner.
- Verify the SKIP comment count matches the SKIP-WITH-NOTE row count: `git grep -n "SKIP
  per PRD-016 triage row" | wc -l` equals the count of SKIP-WITH-NOTE rows in the
  matrix.
- Author `docs/triage/PRD-016-test-failures.md` schema header (the table heading row +
  the column-semantics legend from TDD-029 §6.2) so future maintainers can extend the
  matrix without re-deriving the schema.

### Out of Scope

- Custom-harness file migration (delivered by **PLAN-029-1**; this plan reads its
  captured FAIL list).
- ESLint rule, CI grep step, JUnit XML reporter, `--ci` flag wiring,
  `tests/_meta/test-no-process-exit.test.ts` (delivered by **PLAN-029-3**).
- Production-code fixes for any `regression`-categorised row. Per PRD-016 NG-01, those
  ship as separate PRs; this plan only assigns the disposition and owner.
- Re-run of suites for flake confirmation. The matrix records the `flake` candidate;
  the 5-rerun workflow (`.github/workflows/flake-check.yml`) is **PLAN-029-4** (P1
  fast-follow per TDD-029 §12), not this plan.
- TDD-014 / TDD-015 / TDD-019 closeout work — owned by TDD-030.
- SPEC reconciliation — owned by TDD-031.

## Tasks

### Task 1 — Create the triage matrix file with schema header

Create `docs/triage/` if absent, then create `docs/triage/PRD-016-test-failures.md`. The
file's header section contains:

1. Title and parent-PRD link.
2. The column legend table from TDD-029 §6.2 (column / allowed values / purpose).
3. The disposition rules summary from TDD-029 §6.3 (FIX ETA buckets, SKIP-WITH-NOTE
   annotation format, DELETE three-field requirement).
4. An empty data table with the column header row from TDD-029 §6.1.

Files to create:

- `docs/triage/PRD-016-test-failures.md`

Acceptance:

- File exists at the documented path.
- Markdown renders correctly (header table + empty data table with column headers).
- Cross-references to PRD-016 FR-1610–FR-1615 and TDD-029 §6 are present in the header.

Estimated effort: 2h.

### Task 2 — Ingest the post-migration FAIL list from PLAN-029-1

Read the captured `npx jest --runInBand` log handed off from PLAN-029-1 Task 6. Extract
the list of FAIL suite paths exactly as jest emits them (relative to
`plugins/autonomous-dev/`). For each FAIL:

1. Append a row to the matrix with monotonic row ID, the verbatim suite path, and
   placeholder values for Category / Disposition / Owner / Linked / Notes (`TBD`).
2. Confirm the 11 named PRD-016 FR-1614 suites are all represented; if any are missing
   from the captured log, add them with a Notes annotation `not surfaced in
   post-migration run; carried over from PRD-016 FR-1614`.
3. Note the total FAIL count at the bottom of the file as `Generated from npx jest run
   <date>; N rows`.

Files to modify:

- `docs/triage/PRD-016-test-failures.md`

Acceptance:

- Every FAIL suite from the captured log has a row.
- All 11 PRD-016 FR-1614 named suites have a row.
- Row IDs are unique, monotonic integers starting from 1.

Estimated effort: 3h.

### Task 3 — Categorise each row

For each row, classify the failure as one of TDD-029 §6.1's allowed values:

- **`regression`**: The production code under test misbehaves; the test is correct.
- **`fixture`**: The test is correct but the test fixture (data, mock setup, env var) is
  stale or wrong.
- **`flake`**: The test passes/fails non-deterministically (candidate label only;
  PLAN-029-4 confirms via 5-rerun workflow).
- **`harness-residue`**: The test was failing only because of the harness pattern; the
  PLAN-029-1 migration itself fixes it. (These rows resolve to FIX `this-PR` with the
  migration commit as the fix.)

Procedure:

1. For each row, run `npx jest <suite-path>` once and read the failure output.
2. Inspect the test file and the production code it covers.
3. Pick a category with a one-line justification recorded in Notes.

Files to modify:

- `docs/triage/PRD-016-test-failures.md`

Acceptance:

- Every row has a Category value drawn from the allowed set.
- Notes column has at least a one-line root-cause hypothesis per row (FR-1611).
- A summary line at the end of the file records the per-category counts.

Estimated effort: 1 day (~30 min per row × ~16 rows expected; budget allows for ~30 rows).

### Task 4 — Disposition each row (FIX / SKIP-WITH-NOTE / DELETE)

For each categorised row, decide the disposition per TDD-029 §6.3 rules:

- **`harness-residue`** rows → FIX `this-PR` (the migration is the fix).
- **`regression`** rows → FIX `next-PR` or `next-sprint` per severity. Per PRD-016
  NG-01, regression fixes are out of scope here; the disposition records the work, the
  Owner is named, and a follow-up issue / SPEC link is recorded.
- **`fixture`** rows → FIX `this-PR` if trivially repairable in the matrix PR (e.g.,
  fixture path typo); otherwise FIX `next-PR`.
- **`flake`** candidates → SKIP-WITH-NOTE pending the PLAN-029-4 5-rerun confirmation
  (FR-1615). Note column references the future flake-check workflow run id.
- **`legacy`** suites whose covered production code is gone → DELETE, with all three
  FR-1613 fields populated:
  1. Why legacy (what TDD removed the production code).
  2. Whether covered code is still live (yes/no with a path reference; if `no`, name
     the commit/PR that removed it).
  3. A named approver other than the row's Owner.

Procedure:

1. For each row, write the Disposition cell (`FIX (this-PR)`, `FIX (next-PR)`, `FIX
   (next-sprint)`, `SKIP-WITH-NOTE`, or `DELETE`).
2. Fill the Owner cell with a single GitHub handle (no team aliases, no `TBD`).
3. Fill the Linked cell with a SPEC id, GitHub issue url, or `n/a`.
4. For DELETE rows, expand the Notes cell to include the three FR-1613 fields.

Files to modify:

- `docs/triage/PRD-016-test-failures.md`

Acceptance:

- No row has Disposition `TBD` or Owner `TBD`.
- Every FIX row has an ETA bucket in parens.
- Every DELETE row has the three FR-1613 fields populated.
- Counts at the bottom of the file: `N FIX (this-PR), N FIX (next-PR), N FIX
  (next-sprint), N SKIP-WITH-NOTE, N DELETE`.

Estimated effort: 1 day.

### Task 5 — Land `describe.skip` / `it.skip` annotations for SKIP-WITH-NOTE rows

For each row with Disposition `SKIP-WITH-NOTE`:

1. Open the test file at the path in the row.
2. Convert the targeted `describe(...)` to `describe.skip(...)` or the targeted
   `it(...)` to `it.skip(...)` per the granularity recorded in the Notes column.
3. Add an inline comment immediately above the skip:

   ```ts
   // SKIP per PRD-016 triage row 17: timer-mock leak; tracked in issue #TBD
   describe.skip('CoordinatorSuite', () => { ... });
   ```

4. The reason text in the comment matches the Notes column verbatim (modulo trimming
   to one line).

Verification step (machine-checkable):

```
$ git grep -cn "SKIP per PRD-016 triage row" plugins/autonomous-dev/tests/
```

returns exactly the count of SKIP-WITH-NOTE rows in the matrix. Mismatches block
review.

Files to modify: variable (one per SKIP-WITH-NOTE row).

Acceptance:

- Every SKIP-WITH-NOTE row has a corresponding comment in the matching test file.
- The grep count matches the SKIP-WITH-NOTE row count.
- Each migrated `describe.skip` / `it.skip` lands as its own commit (small, reviewable)
  with body referencing the row id: `Refs PRD-016 triage row N (PLAN-029-2)`.

Estimated effort: 0.5 day.

### Task 6 — DELETE row execution (if any)

For each row with Disposition `DELETE`:

1. Confirm the three FR-1613 fields are present in Notes.
2. Confirm the named approver has signed off (PR comment from the approver, captured
   in the matrix Notes as `approved-by: @handle on YYYY-MM-DD`).
3. Delete the test file in a single commit. Body: `Delete legacy test per PRD-016
   triage row N. Approved-by: @<approver>. Refs PLAN-029-2.`

Files to delete: variable (zero or more).

Acceptance:

- Every DELETE in the matrix has a corresponding `git rm` commit.
- Each delete commit cites the row id and the approver.
- No file is deleted that lacks all three FR-1613 fields.

Estimated effort: 0.5 day (likely 0 deletes in the first pass; budget allows for
small).

### Task 7 — Final coherence pass

1. Re-run `npx jest --runInBand` from `plugins/autonomous-dev/`. Every suite must now
   either PASS or be `.skip`-annotated; no un-dispositioned FAIL.
2. Reconcile any newly-revealed FAIL suite (a suite that the SKIP-WITH-NOTE annotations
   themselves un-masked by letting jest get further into the run) by adding a row to
   the matrix and looping back through Tasks 3–5.
3. Confirm the matrix's FAIL count + DELETE count = the original FAIL count from
   PLAN-029-1 (no rows lost in the transcription).
4. Update the matrix's bottom-line summary.

Acceptance:

- `npx jest --runInBand` produces a PASS/PENDING summary; no un-handled FAIL rows.
- Matrix is internally consistent: row count, category counts, disposition counts all
  add up.

Estimated effort: 3h.

## Acceptance Criteria

- `docs/triage/PRD-016-test-failures.md` exists with the schema header and full data
  table populated (PRD-016 FR-1610).
- Every FAIL suite from the post-migration `npx jest --runInBand` log has a row
  (PRD-016 FR-1614 + open-ended additions).
- Every row has Category, Disposition, Owner, Linked SPEC/Issue, and Notes filled —
  no `TBD` values (PRD-016 FR-1610).
- Every FIX row has an ETA bucket (`this-PR` / `next-PR` / `next-sprint`) (PRD-016
  FR-1611).
- Every SKIP-WITH-NOTE row corresponds to a `describe.skip` or `it.skip` in the test
  file with a `// SKIP per PRD-016 triage row N: <reason>` comment (PRD-016 FR-1612).
- `git grep -c "SKIP per PRD-016 triage row" plugins/autonomous-dev/tests/` equals
  the count of SKIP-WITH-NOTE rows in the matrix.
- Every DELETE row has the three FR-1613 fields populated (legacy rationale, prod-code-
  live status, named approver) and a corresponding `git rm` commit.
- After the plan ships, `npx jest --runInBand` from `plugins/autonomous-dev/` produces
  zero non-skipped FAIL suites (sets up PRD-016 G-09 and unblocks PLAN-029-3's `--ci`
  flag).

## Testing

- **Matrix consistency:** `git grep -c "SKIP per PRD-016 triage row"` matches matrix
  SKIP-WITH-NOTE row count. Manual cross-check.
- **End-state jest run:** `npx jest --runInBand` from `plugins/autonomous-dev/` exits
  with zero non-skipped failures.
- **No new test cases** authored. The matrix is a documentation deliverable; the
  `.skip` annotations are surface modifications, not new logic.
- **Per-row verification** (Task 7): re-run the suite associated with each row to
  confirm the captured failure mode still reproduces (or is now resolved by an
  in-this-PR skip).

## Risks

| ID    | Risk                                                                                                                                    | Probability | Impact | Mitigation                                                                                                                                                                                                  |
|-------|-----------------------------------------------------------------------------------------------------------------------------------------|-------------|--------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| R-201 | A `flake`-tagged row is actually a real regression masked by retry semantics; SKIP-WITH-NOTE hides a production bug.                    | Medium      | High   | PLAN-029-4 (P1 fast-follow) lands the `.github/workflows/flake-check.yml` 5-rerun workflow. PRD-016 FR-1615 mandates 5 reruns before flake classification sticks; consistent fails auto-promote to `regression`. |
| R-202 | Bulk DELETE without all FR-1613 fields slips through review.                                                                            | Low         | High   | The acceptance criteria require all three fields per DELETE row. Reviewer checklist at the top of the matrix file calls them out. PLAN-029-3's CI grep can be extended to fail on `DELETE` rows missing fields.   |
| R-203 | Post-migration FAIL count exceeds the matrix's expected ~16–20 rows (PRD-016 R-08). Triage scope balloons.                              | Medium      | Medium | Per PRD-016 OQ-07 / TDD-029 OQ-29-06: if FAIL > 50, escalate to PRD-016A (harness migration) + PRD-016B (triage) split. PLAN-029-2 then re-scopes; PLAN-029-1 still merges as foundation.                            |
| R-204 | The Owner field lists a single human but that human is unavailable (vacation, departed) by the time the FIX is due.                     | Low         | Medium | Owner re-assignment is a matrix amendment, not a re-author. The matrix is a living doc; subsequent PRs amend the Owner cell. Matrix header documents the amendment process.                                          |
| R-205 | A `describe.skip` annotation accidentally skips more cases than intended (e.g., wraps a whole `describe` when only one `it` should skip). | Medium      | Medium | Each SKIP-WITH-NOTE annotation lands as its own commit so the diff is one or two lines. Reviewer confirms granularity matches the Notes column. Task 5 explicitly records granularity in Notes.                       |
| R-206 | Triage authors disagree on category for ambiguous failures (e.g., flake vs regression).                                                  | Medium      | Low    | Default to `regression` when in doubt — flakes can be re-categorised after the 5-rerun confirmation; mis-categorising a regression as a flake is the more dangerous error. Documented in the matrix header guidance.   |

## Definition of Done

- [ ] `docs/triage/PRD-016-test-failures.md` exists at repo root with schema header.
- [ ] Every FAIL suite from PLAN-029-1's post-migration log has a row.
- [ ] All 11 PRD-016 FR-1614 named suites have a row.
- [ ] No row has `TBD` for Category, Disposition, Owner, Linked, or Notes.
- [ ] Every FIX row has an ETA bucket.
- [ ] Every SKIP-WITH-NOTE row has a corresponding `// SKIP per PRD-016 triage row N`
      comment in the test file.
- [ ] `git grep -c "SKIP per PRD-016 triage row" plugins/autonomous-dev/tests/` equals
      the SKIP-WITH-NOTE row count.
- [ ] Every DELETE row has the three FR-1613 fields populated and a corresponding
      `git rm` commit.
- [ ] `npx jest --runInBand` from `plugins/autonomous-dev/` exits with zero non-skipped
      failures.
- [ ] Matrix bottom-line summary records per-category and per-disposition counts.

## Dependencies

### Parent TDD

- **TDD-029** §6 (Triage Matrix Schema), §10.1 (phase 4–5 of rollout).

### Parent PRD

- **PRD-016** §7.2 (FR-1610 through FR-1615), §7.6 (categorisation taxonomy), §9
  (acceptance), §10 R-04, R-07, R-08.

### Blocked By

- **PLAN-029-1** — needs the captured `npx jest --runInBand` FAIL list from Task 6.

### Blocks Downstream Plans

- **PLAN-029-3** — the CI gate's `--ci` flag turns the build red on any non-skipped
  failure. Until PLAN-029-2 lands SKIP-WITH-NOTE annotations for every dispositioned
  failure, PLAN-029-3 cannot ship without breaking the build.
- **PLAN-029-4** (flake re-classification workflow, P1 fast-follow per TDD-029 §12) —
  reads the matrix's `flake`-tagged rows and re-runs them 5x to confirm classification.

### Integration Points

- The matrix's row IDs are the citation keys for SKIP comments, downstream tracking
  issues, and any future PRs that reference a triage decision.
- A future PR that adds a new test suite which fails on first run is expected to add a
  row to this matrix as part of its own review (matrix is a permanent fixture).
