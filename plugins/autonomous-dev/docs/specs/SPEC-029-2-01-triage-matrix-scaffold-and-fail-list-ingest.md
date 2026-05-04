# SPEC-029-2-01: Triage Matrix Scaffold + FAIL-List Ingest

## Metadata
- **Parent Plan**: PLAN-029-2 (Test Failure Triage Matrix Authoring & Disposition)
- **Parent TDD**: TDD-029 (Jest Harness Migration, Failure Triage, and CI Gate)
- **Parent PRD**: PRD-016 (Test-Suite Stabilization & Jest Harness Migration)
- **Tasks Covered**: PLAN-029-2 Task 1 (create matrix file with schema header) + PLAN-029-2 Task 2 (ingest post-migration FAIL list from PLAN-029-1 Task 6)
- **Estimated effort**: 5 hours total (~2h scaffold + ~3h ingest)
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/docs/triage/PRD-016-test-failures.md` (repo-root path; not under `plugins/autonomous-dev/docs/`)
- **Depends on**: SPEC-029-1-05 (provides the captured `npx jest --runInBand` log + extracted FAIL-list artifact)

## Description

Create the canonical triage matrix file at `docs/triage/PRD-016-test-failures.md` (repo root) and seed it with one row per FAIL suite from the post-migration jest run captured in SPEC-029-1-05's end-of-plan verification step. This spec produces a **scaffold-and-stub** deliverable: the matrix structure is final (header, legend, disposition rules, data table headers) and every FAIL row is present, but the Category/Disposition/Owner/Linked/Notes cells contain `TBD` placeholders. Subsequent specs (SPEC-029-2-02 categorise, SPEC-029-2-03 disposition+skips, SPEC-029-2-04 final coherence) fill the placeholders.

The repo-root path (`docs/triage/`, not `plugins/autonomous-dev/docs/triage/`) is intentional per TDD-029 §6.1: the matrix covers both autonomous-dev plugin tests and portal-side suites, so it lives above any single plugin's docs tree.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `docs/triage/` | Create directory | Repo-root path; create with `mkdir -p` if absent |
| `docs/triage/PRD-016-test-failures.md` | Create | Full schema header + empty data table (Task 1) → seeded with rows (Task 2) |

Two commits:

1. **Task 1 commit**: matrix file with schema header and empty data table.
2. **Task 2 commit**: matrix file populated with one row per FAIL suite (cells `TBD` except Row + Suite path).

Each commit body references `Refs PRD-016 FR-1610, FR-1614; TDD-029 §6; PLAN-029-2 Task <N>`.

## Implementation Details

### Task 1 — Scaffold the matrix file

#### Step 1: Create the directory

From repo root:

```
$ mkdir -p docs/triage
```

If `docs/triage/` already exists from another track, skip. Do NOT delete or alter any other files in the directory.

#### Step 2: Author the matrix header

Write `docs/triage/PRD-016-test-failures.md` with the following structure (literal content; do not paraphrase):

```markdown
# PRD-016 Test Failure Triage Matrix

This document is the canonical disposition record for every FAIL suite surfaced
by `npx jest --runInBand` from `plugins/autonomous-dev/` after the
[PLAN-029-1 harness migration](../../plugins/autonomous-dev/docs/plans/PLAN-029-1-harness-migration.md)
unmasked them. Each row records what the failure is (`Category`), what we are
doing about it in the current PR (`Disposition`), and who owns the follow-up.

**Parent PRD:** [PRD-016 Test-Suite Stabilization](../../plugins/autonomous-dev/docs/prd/PRD-016-test-suite-stabilization.md)
**Parent TDD:** [TDD-029 Jest Harness Migration, Failure Triage, and CI Gate](../../plugins/autonomous-dev/docs/tdd/TDD-029-jest-harness-migration-and-ci-gate.md)
**Driving plan:** [PLAN-029-2 Failure Triage Matrix](../../plugins/autonomous-dev/docs/plans/PLAN-029-2-failure-triage-matrix.md)

Cross-references: PRD-016 FR-1610–FR-1615; TDD-029 §6.

## Column legend

| Column            | Allowed values                                                                 | Purpose                                                                                |
|-------------------|--------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------|
| Row               | Monotonic integer starting at 1                                                | Citation key in `// SKIP per PRD-016 triage row N: <reason>` annotations (FR-1612)     |
| Suite path        | Relative path from `plugins/autonomous-dev/`, exactly as jest emits it         | Must match the jest summary verbatim                                                    |
| Category          | `regression` \| `fixture` \| `flake` \| `harness-residue`                       | What kind of failure this is (TDD-029 §6.1)                                             |
| Disposition       | `FIX (this-PR)` \| `FIX (next-PR)` \| `FIX (next-sprint)` \| `SKIP-WITH-NOTE` \| `DELETE` | What action ships in this PR                                                            |
| Owner             | A single GitHub handle (e.g., `@pwatson`); NOT `TBD`, NOT a team alias          | Single named human responsible for the follow-up                                        |
| Linked SPEC/Issue | A SPEC id (e.g., `SPEC-006-3-02`), GitHub issue URL, or `n/a`                  | Where the follow-up lives                                                               |
| Notes             | Free text, ≤ 1 line for FIX/SKIP rows; expanded for DELETE rows (see below)    | One-sentence root-cause hypothesis (FR-1611) and any granularity / approver detail      |

## Disposition rules (TDD-029 §6.3)

- **FIX:** Includes an ETA bucket: `FIX (this-PR)` (follow-up commit on this branch),
  `FIX (next-PR)` (separate PR referencing PRD-016), or `FIX (next-sprint)`
  (tracking issue). Notes column carries the one-line root-cause hypothesis (FR-1611).
- **SKIP-WITH-NOTE:** Implemented as `describe.skip(...)` or `it.skip(...)` with
  an inline comment of the form `// SKIP per PRD-016 triage row N: <reason>`.
  The grep `git grep -c "SKIP per PRD-016 triage row" plugins/autonomous-dev/tests/`
  MUST equal the count of SKIP-WITH-NOTE rows in this matrix. Mismatches block
  review (FR-1612).
- **DELETE:** Notes cell MUST contain three fields, each on its own line or as a
  semicolon-separated list:
  1. `legacy-rationale: <why the test is legacy; cite the TDD that removed the
     production code if applicable>`
  2. `prod-code-status: <live | removed-in-<commit-or-PR>>`
  3. `approved-by: @<handle> on YYYY-MM-DD` (MUST be a different handle from the
     row's Owner)

  DELETE rows missing any of the three fields are rejected at review (FR-1613).

## Categorisation guidance (TDD-029 §6.1, §6.4)

- `regression` — production code under test misbehaves; the test is correct.
- `fixture` — test is correct but its fixture (data, mock, env var) is stale or wrong.
- `flake` — passes/fails non-deterministically. Candidate label only; PLAN-029-4
  (`flake-check.yml` 5-rerun workflow) confirms via FR-1615. When in doubt,
  default to `regression` — flakes can be re-categorised after rerun, but
  mis-categorising a regression as a flake is the more dangerous error.
- `harness-residue` — the test was failing because of the harness pattern; the
  PLAN-029-1 migration itself fixes it. Such rows resolve to `FIX (this-PR)`.

## Data table

| Row | Suite path | Category | Disposition | Owner | Linked SPEC / Issue | Notes |
|-----|------------|----------|-------------|-------|---------------------|-------|

<!-- Rows seeded in Task 2 of PLAN-029-2; populated in subsequent tasks. -->

## Summary

_(Populated in PLAN-029-2 Task 4; updated by Task 7.)_

- Generated from `npx jest --runInBand` run on YYYY-MM-DD.
- Total rows: N
- Per-category counts: regression=N, fixture=N, flake=N, harness-residue=N
- Per-disposition counts: FIX(this-PR)=N, FIX(next-PR)=N, FIX(next-sprint)=N, SKIP-WITH-NOTE=N, DELETE=N
```

#### Step 3: Verify Markdown rendering

Render the file locally (e.g., `npx markdownlint docs/triage/PRD-016-test-failures.md` if the repo lints markdown, or open in a Markdown previewer). Acceptance: the two tables (column legend + data table header row) render as tables, not as raw pipe-delimited text.

#### Step 4: Task 1 commit

```
docs(triage): scaffold PRD-016 test failure triage matrix

Create docs/triage/PRD-016-test-failures.md at repo root with:
  - Schema header and parent-PRD/TDD/plan cross-references.
  - Column legend (TDD-029 §6.2).
  - Disposition rules (FIX ETA buckets, SKIP-WITH-NOTE annotation
    format, DELETE three-field requirement).
  - Categorisation guidance (TDD-029 §6.1, §6.4).
  - Empty data table with column headers.
  - Summary placeholder.

Data rows are seeded in the Task 2 commit of this spec; subsequent
specs (SPEC-029-2-02..04) categorise, disposition, skip, and finalise.

Refs PRD-016 FR-1610; TDD-029 §6.1, §6.2, §6.3, §6.4; PLAN-029-2 Task 1.
```

### Task 2 — Ingest the post-migration FAIL list

#### Step 1: Locate the captured artifact

The artifact is produced by SPEC-029-1-05's end-of-plan verification step. It MAY be:

- The PR description of the SPEC-029-1-05 PR (a fenced block named "Post-migration FAIL list").
- A workflow artifact named `jest-postmigration-faillist.txt`.
- A local file path provided by the SPEC-029-1-05 implementer.

If the artifact is not visible at the start of this task, refuse to proceed and surface the dependency to the orchestrator. **Do not invent a FAIL list** — the matrix's authority comes from being a faithful copy of the actual jest output.

#### Step 2: Extract suite paths

From the captured log:

```
$ grep -E "^FAIL " <log-path> | awk '{print $2}' | sort -u
```

Each line is a path relative to `plugins/autonomous-dev/` (jest emits paths from the working directory of the run). Verify that paths look correct (e.g., `tests/parallel/test-parallel-coordinator.test.ts`, not absolute paths and not paths with leading `./`).

#### Step 3: Append rows to the matrix

For each unique FAIL suite path (in alphabetical order):

1. Compute the next monotonic Row id (start at 1; increment for each row).
2. Append a row to the data table with:
   - Row: the integer.
   - Suite path: the verbatim path from step 2.
   - Category: `TBD`
   - Disposition: `TBD`
   - Owner: `TBD`
   - Linked SPEC / Issue: `TBD`
   - Notes: `TBD`

Example seeded row:

```
| 1   | tests/parallel/test-parallel-coordinator.test.ts | TBD | TBD | TBD | TBD | TBD |
```

#### Step 4: Cover the FR-1614 named suites

Cross-check that all 11 PRD-016 FR-1614 named suites appear in the seeded rows:

1. `parallel/*` (one or more rows under `tests/parallel/`)
2. `agent-factory/improvement/*` (subset; one or more rows)
3. `notifications/*`
4. `escalation/response-handler.integration`
5. `safety/security-audit`
6. `intake/__tests__/core/reconciliation_repair`
7. `intake/notifications/notification_engine`
8. `tests/core/test_handoff_manager`
9. `full-collection-run`
10. `governance-lifecycle`
11. `scrub-integration`

For each FR-1614 entry NOT surfaced in the captured run, add a row anyway with:

- Suite path: the FR-1614 path verbatim.
- Notes: `not surfaced in post-migration run; carried over from PRD-016 FR-1614`.
- All other cells: `TBD`.

This guarantees full FR-1614 coverage even if the post-migration run masked a suite via prior failure.

#### Step 5: Update the Summary section

Replace the Summary section's placeholder line with:

```
- Generated from `npx jest --runInBand` run on YYYY-MM-DD; N rows.
- Per-category counts: TBD (filled by SPEC-029-2-02).
- Per-disposition counts: TBD (filled by SPEC-029-2-03).
```

Replace `YYYY-MM-DD` with the actual date the captured log was produced (NOT the date this commit lands). Replace `N` with the row count.

#### Step 6: Verify row count consistency

```
$ grep -cE "^\| [0-9]+" docs/triage/PRD-016-test-failures.md
```

This counts data rows. The number MUST equal:

- The unique FAIL count from `grep -cE "^FAIL " <log-path>` PLUS
- Any FR-1614 carry-overs added in step 4.

Mismatches mean a row was lost; re-do step 3.

#### Step 7: Task 2 commit

```
docs(triage): seed PRD-016 triage matrix with N FAIL-suite rows

Ingest the post-migration `npx jest --runInBand` FAIL list captured
by SPEC-029-1-05. Each FAIL suite gets a row with verbatim path and
TBD placeholders for Category, Disposition, Owner, Linked, Notes.

PRD-016 FR-1614 cross-check: all 11 named suites have rows. Suites
not surfaced in this run carry the note "carried over from PRD-016
FR-1614".

Total rows: N. Categorisation, disposition, and SKIP annotations land
in SPEC-029-2-02 and SPEC-029-2-03.

Refs PRD-016 FR-1610, FR-1614; TDD-029 §6.1, §6.5; PLAN-029-2 Task 2.
```

### What NOT to do

- Do NOT fill Category, Disposition, Owner, Linked, or Notes cells in this spec. Those are explicitly subsequent-spec work; pre-filling them creates merge conflicts with SPEC-029-2-02/03.
- Do NOT modify any test files in this spec. The matrix is documentation; `.skip` annotations live in SPEC-029-2-03.
- Do NOT place the matrix under `plugins/autonomous-dev/docs/triage/`. The repo-root path is mandated by TDD-029 §6.1 because the matrix covers both autonomous-dev and portal suites.
- Do NOT collapse the two tasks into one commit. The Task 1 / Task 2 split keeps the schema-author work separately reviewable from the data-ingest work, which is the entire point of one-commit-per-task discipline on this PR.
- Do NOT invent FAIL rows. If the captured log is missing or empty, refuse to proceed and escalate.
- Do NOT reorder the column legend or rename columns. Subsequent specs grep for these column names.

## Acceptance Criteria

Schema scaffold (Task 1):

- [ ] `docs/triage/PRD-016-test-failures.md` exists at repo root (path verified by `ls docs/triage/PRD-016-test-failures.md`).
- [ ] File header contains parent-PRD link, parent-TDD link, parent-plan link, and the cross-reference line `Cross-references: PRD-016 FR-1610–FR-1615; TDD-029 §6.`
- [ ] File contains a `## Column legend` section with the 7-row table from §6.2.
- [ ] File contains a `## Disposition rules (TDD-029 §6.3)` section listing FIX ETA buckets, SKIP-WITH-NOTE format, and the DELETE three-field requirement.
- [ ] File contains a `## Categorisation guidance` section listing the 4 allowed Category values with one-line definitions.
- [ ] File contains a `## Data table` section with the 7-column header row and an empty body (no data rows in the Task 1 commit).
- [ ] File contains a `## Summary` section with placeholders.
- [ ] Markdown renders correctly (verified via local preview).
- [ ] Task 1 commit body matches the §Implementation Details Task 1 step 4 template; references `PRD-016 FR-1610; TDD-029 §6.1, §6.2, §6.3, §6.4; PLAN-029-2 Task 1`.

FAIL-list ingest (Task 2):

- [ ] Every FAIL suite path from the SPEC-029-1-05 captured log has exactly one row in the data table.
- [ ] All 11 PRD-016 FR-1614 named suites are represented (either as a FAIL-list row or as a `carried over from PRD-016 FR-1614` row).
- [ ] Row IDs are unique monotonic integers starting at 1; no gaps; no duplicates.
- [ ] Suite path cells contain paths verbatim as jest emitted them (no leading `./`, no absolute paths, no trimming).
- [ ] Cells for Category, Disposition, Owner, Linked SPEC / Issue, and Notes contain `TBD` (except FR-1614 carry-overs whose Notes contain the documented carry-over text).
- [ ] Summary section's "Generated from..." line has a real date and a real row count.
- [ ] `grep -cE "^\| [0-9]+" docs/triage/PRD-016-test-failures.md` equals (unique FAIL count from log) + (FR-1614 carry-over count).
- [ ] Task 2 commit body matches the §Implementation Details Task 2 step 7 template; references `PRD-016 FR-1610, FR-1614; TDD-029 §6.1, §6.5; PLAN-029-2 Task 2`.
- [ ] No test files (`plugins/autonomous-dev/tests/**`) modified.
- [ ] No production-code files modified.
- [ ] No files outside `docs/triage/` modified.

## Dependencies

- **Blocked by**: SPEC-029-1-05 (provides the captured `npx jest --runInBand` log + extracted FAIL list). Without this artifact, Task 2 cannot proceed.
- **Blocks**: SPEC-029-2-02 (categorise rows). The matrix file and seeded rows are the input for categorisation.
- **Blocks**: SPEC-029-2-03 (disposition + skips). Disposition cells are filled on top of the rows seeded here.
- **Blocks**: SPEC-029-2-04 (final coherence pass). Re-runs jest against the now-skip-annotated tree.

## Notes

- The matrix is at repo-root `docs/triage/`, not under any plugin's docs tree, on purpose. PRD-016 covers both autonomous-dev and the portal; placing the matrix above the plugin boundary signals that ownership.
- The `TBD` placeholders are not optional cosmetics — they are intentional flags for the next spec author and prevent silent under-fill. SPEC-029-2-02 and SPEC-029-2-03's acceptance criteria explicitly require zero `TBD` values at end-of-spec, which makes the placeholders machine-checkable.
- Task 1 and Task 2 are split into two commits to keep the schema-author work reviewable in isolation. A reviewer can read the Task 1 diff and confirm the schema before scrolling through hundreds of seeded rows in the Task 2 diff.
- If the captured FAIL count exceeds 50, the row count alone may trigger PRD-016 OQ-07 (split into PRD-016A + PRD-016B). The trigger is recorded as a PR comment; this spec still ships the matrix as-is. SPEC-029-2-02 is the place to re-scope if the count is unmanageable.
- The carry-over note for FR-1614 suites that did NOT surface in the captured run is required so the matrix is a strict superset of FR-1614. Without it, a future jest configuration change that re-surfaces a suite would leave the matrix incomplete and trigger an FR-1614 audit fail.
- `git diff --stat` on the Task 2 commit will show one file changed with N+ lines added (one row per FAIL plus FR-1614 carry-overs). A noticeably smaller diff means rows were lost; re-do step 3.
