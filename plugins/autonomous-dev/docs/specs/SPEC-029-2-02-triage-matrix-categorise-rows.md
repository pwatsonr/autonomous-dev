# SPEC-029-2-02: Triage Matrix — Categorise Each FAIL Row

## Metadata
- **Parent Plan**: PLAN-029-2 (Test Failure Triage Matrix Authoring & Disposition)
- **Parent TDD**: TDD-029
- **Parent PRD**: PRD-016
- **Tasks Covered**: PLAN-029-2 Task 3 (categorise each row as `regression` / `fixture` / `flake` / `harness-residue` with one-line root-cause hypothesis)
- **Estimated effort**: 1 day (~30 min per row × 16 rows expected; budget allows ~30 rows)
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/docs/triage/PRD-016-test-failures.md` (modifications)
- **Depends on**: SPEC-029-2-01 (provides the seeded matrix file and FAIL-list rows with `TBD` cells)

## Description

Replace the `TBD` value in the `Category` cell of every row in `docs/triage/PRD-016-test-failures.md` with one of the four allowed values from TDD-029 §6.1: `regression`, `fixture`, `flake`, or `harness-residue`. For every row, also replace the `Notes` cell's `TBD` placeholder with a one-line root-cause hypothesis as required by PRD-016 FR-1611. This spec covers the diagnostic step of triage; it does NOT decide what to do about each failure (FIX / SKIP-WITH-NOTE / DELETE) — that disposition step is SPEC-029-2-03.

The output of this spec is a single commit modifying `docs/triage/PRD-016-test-failures.md`. The Category column transitions from all-`TBD` to fully populated; the Notes column transitions from all-`TBD` to fully populated with one-line hypotheses; Disposition / Owner / Linked cells remain `TBD` (filled in SPEC-029-2-03). The Summary section gains per-category counts.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `docs/triage/PRD-016-test-failures.md` | Modify | Fill Category and Notes cells; update Summary per-category counts |

One commit. Body references `Refs PRD-016 FR-1610, FR-1611; TDD-029 §6.1, §6.4; PLAN-029-2 Task 3`.

## Implementation Details

### Per-row procedure

For each row in the data table, in Row order:

#### Step 1: Reproduce the failure

```
$ cd plugins/autonomous-dev
$ npx jest <suite-path> --runInBand
```

Where `<suite-path>` is the verbatim Suite path from the row. Capture:

- The FAIL test name(s).
- The error message and stack trace.
- Any `console.log` output emitted by the suite.

If the suite now PASSES (no FAIL output), the row's category is `harness-residue` — the migration itself fixed it. Document this outcome in step 4's hypothesis.

If the suite cannot be located (path drift since SPEC-029-2-01 seeded the row), record the row's Notes cell as `path-drift; suite missing as of <date>` and skip steps 2–3. Set Category to `harness-residue` with the rationale that the harness migration removed the file. Surface the discrepancy as a PR comment.

#### Step 2: Inspect the test file

Open the test file at the row's Suite path. Identify:

- What the test asserts (the `expect(...)` chains or `assert(...)` calls).
- Which production module it exercises (the `import` statements).
- Whether the failure is in setup (`beforeAll` / `beforeEach`) or in an `it(...)` body.
- Whether the test relies on timing (`setTimeout`, `setInterval`, `jest.useFakeTimers`), filesystem state, network state, or daemon state.

#### Step 3: Inspect the production module under test

Open the production module the test imports. Determine:

- Whether the module's behavior matches what the test asserts (production correct → test correct → mismatch is a regression in either direction).
- Whether the module reads from a fixture file, mocked module, or env var that may have drifted.
- Whether the module spawns child processes, opens sockets, or has other timing-dependent behavior.

#### Step 4: Choose a category and hypothesis

Apply the decision tree:

1. **If the suite passes after the migration** → Category `harness-residue`. Notes: `harness-residue: failure was the harness pattern; migration fixes it.`
2. **If the failure reproduces deterministically AND the test's assertions match documented production behavior** → Category `regression`. Notes: a one-line hypothesis pointing at the production-code suspect, e.g., `regression: <module>.<function> returns null instead of [] when input is empty`.
3. **If the failure reproduces deterministically AND the test's assertions reference a fixture/mock/env that has drifted** → Category `fixture`. Notes: `fixture: <fixture-path-or-mock> is stale; expected <X>, found <Y>`.
4. **If the failure reproduces non-deterministically (i.e., re-running 2–3 times locally yields a mix of pass and fail)** → Category `flake` (candidate label only). Notes: `flake-candidate: passes <N>/<M> reruns; PLAN-029-4 5-rerun confirmation required (FR-1615)`.
5. **If unsure** → default to `regression` per TDD-029 §6.4 / PLAN-029-2 R-206. Mis-categorising a regression as a flake is the dangerous direction; prefer the conservative call.

For categories 2–5, the Notes hypothesis MUST cite a concrete artifact (file path, function name, fixture name, env var). A vague hypothesis like `regression: probably a race condition` is rejected at review.

#### Step 5: Update the matrix row

Edit `docs/triage/PRD-016-test-failures.md`:

1. Replace the row's `Category` cell `TBD` with the chosen value.
2. Replace the row's `Notes` cell `TBD` with the one-line hypothesis.
3. Leave Disposition / Owner / Linked cells as `TBD` (SPEC-029-2-03 fills these).

Example transitions:

```
Before:
| 1 | tests/parallel/test-parallel-coordinator.test.ts | TBD | TBD | TBD | TBD | TBD |

After:
| 1 | tests/parallel/test-parallel-coordinator.test.ts | regression | TBD | TBD | TBD | regression: ParallelCoordinator.tick() drops events under contention; suspected timer-mock leak |
```

#### Step 6: Move to the next row

Repeat steps 1–5 until every row has a Category != `TBD` and a Notes != `TBD`.

### Update the Summary section

After all rows are categorised, recount and update the Summary section:

```
- Generated from `npx jest --runInBand` run on YYYY-MM-DD; N rows.
- Per-category counts: regression=X, fixture=Y, flake=Z, harness-residue=W.
- Per-disposition counts: TBD (filled by SPEC-029-2-03).
```

`X + Y + Z + W` MUST equal the total row count `N`. Mismatches mean a row was missed.

### Sanity checks (run before commit)

```
$ grep -cE "^\| [0-9]+ \|.*\| TBD \| TBD \| TBD \| TBD \| TBD \|" docs/triage/PRD-016-test-failures.md
0

$ grep -cE "^\| [0-9]+ \|.*\| (regression|fixture|flake|harness-residue) \|" docs/triage/PRD-016-test-failures.md
N    # equals the total row count
```

The first grep MUST return 0 (no fully-TBD rows). The second grep MUST equal the total row count (every row has a valid Category).

### Commit

```
docs(triage): categorise PRD-016 triage matrix rows (regression/fixture/flake/harness-residue)

For each of N rows in docs/triage/PRD-016-test-failures.md, replace the
Category TBD with one of {regression, fixture, flake, harness-residue}
and the Notes TBD with a one-line root-cause hypothesis citing a
concrete production-code or fixture artifact (FR-1611).

Per-category counts:
  regression=X
  fixture=Y
  flake=Z
  harness-residue=W
Total: N (matches data-table row count).

Disposition / Owner / Linked cells remain TBD; filled in SPEC-029-2-03.

Refs PRD-016 FR-1610, FR-1611; TDD-029 §6.1, §6.4; PLAN-029-2 Task 3.
```

### What NOT to do

- Do NOT fill Disposition, Owner, or Linked cells in this spec. Those are SPEC-029-2-03's responsibility. Keeping the work split prevents commits with sweeping cell rewrites that hide categorisation rationale under disposition churn.
- Do NOT modify any test file (`plugins/autonomous-dev/tests/**`) or production source file. Categorisation is a reading-and-recording activity. The `npx jest <suite>` reproduction in step 1 is read-only.
- Do NOT skip the per-suite reproduction in step 1. The Category cell's accuracy depends on confirming the failure mode actually occurs against the post-migration tree.
- Do NOT use a Category value outside the allowed set (`regression`, `fixture`, `flake`, `harness-residue`). Subsequent specs grep for these exact strings.
- Do NOT pre-bias toward `flake` for hard-to-reproduce failures. Per TDD-029 §6.4, mis-categorising a regression as a flake is more dangerous than the inverse; default to `regression` when unsure.
- Do NOT collapse multiple TBD rows into one bulk update without per-row diagnostic notes. The hypothesis cell is per-row evidence; bulk fills lose evidence.

## Acceptance Criteria

- [ ] Every row in `docs/triage/PRD-016-test-failures.md`'s data table has a `Category` cell populated with one of `regression`, `fixture`, `flake`, or `harness-residue`. No `TBD` values in the Category column.
- [ ] Every row has a `Notes` cell populated with a one-line root-cause hypothesis citing a concrete artifact (file path, function name, fixture name, or env var). No `TBD` values in the Notes column.
- [ ] Disposition, Owner, and Linked SPEC / Issue cells remain `TBD` (no premature fill).
- [ ] The Summary section's per-category counts equal the actual row distribution: `regression + fixture + flake + harness-residue == total row count`.
- [ ] `grep -cE "^\| [0-9]+ \|.*\| TBD \| TBD \| TBD \| TBD \| TBD \|" docs/triage/PRD-016-test-failures.md` returns 0.
- [ ] `grep -cE "^\| [0-9]+ \|.*\| (regression|fixture|flake|harness-residue) \|" docs/triage/PRD-016-test-failures.md` equals the total row count.
- [ ] One commit modifies only `docs/triage/PRD-016-test-failures.md`. No test files, production source files, or other docs are touched. Verified by `git diff --name-only HEAD~1..HEAD` returning exactly the matrix path.
- [ ] Commit body matches the §Implementation Details Commit template; references `PRD-016 FR-1610, FR-1611; TDD-029 §6.1, §6.4; PLAN-029-2 Task 3`.
- [ ] For each row whose Category is `regression`, the Notes hypothesis names a specific production-code artifact (module + function or method).
- [ ] For each row whose Category is `fixture`, the Notes hypothesis names a specific fixture path, mock module, or env var.
- [ ] For each row whose Category is `flake`, the Notes hypothesis records the rerun ratio (`<N>/<M>`) and references FR-1615 / PLAN-029-4.
- [ ] For each row whose Category is `harness-residue`, the per-suite jest reproduction in step 1 was confirmed to PASS (the migration fixed it).

## Dependencies

- **Blocked by**: SPEC-029-2-01 (provides the seeded matrix file and `TBD`-filled rows).
- **Blocks**: SPEC-029-2-03 (disposition + skip annotations). The Disposition cell's value depends on the Category — `harness-residue` rows resolve to `FIX (this-PR)`; `regression` and `fixture` rows pick FIX bucket per severity; `flake` rows resolve to `SKIP-WITH-NOTE` pending PLAN-029-4. SPEC-029-2-03 cannot run before this spec finishes.
- **Blocks**: SPEC-029-2-04 (final coherence pass).

## Notes

- The per-row reproduction in step 1 is the single most important step of this spec. The matrix's authority comes from being a faithful diagnostic record, not an aggregated guess. If a reviewer cannot trust that step 1 was run for every row, the matrix is decorative.
- A row's hypothesis must cite a concrete artifact because subsequent owners (named in SPEC-029-2-03) need a starting point for the FIX work. A vague hypothesis like `probably a race` is one Slack thread away from "I gave up"; a hypothesis like `ParallelCoordinator.tick() drops events under contention; suspected timer-mock leak` tells the next owner exactly which file to open.
- The TDD-029 §6.4 "default to regression when unsure" rule is non-negotiable for this spec. The asymmetric cost (a hidden regression is much worse than a deferred flake confirmation) drives this preference. PLAN-029-4 will catch over-classified regressions on rerun; SPEC-029-2-03's `flake` → `SKIP-WITH-NOTE` rule explicitly references the rerun workflow.
- The summary update (per-category counts) is machine-checkable. A reviewer can `grep -c "regression" docs/triage/PRD-016-test-failures.md` (excluding the legend lines) to verify the count, which makes the commit's claim falsifiable.
- If the post-migration tree itself is unstable (e.g., a flaky `beforeAll` in one of the SPEC-029-1-* migrations regresses categorisation), surface the issue as a PR comment and pause this spec. Do not proceed with categorisation against a moving target. Re-run after upstream fixes.
- A row whose Suite path is missing post-migration (path drift) is a corner case. The fallback rule (Category `harness-residue` with an explanatory note) keeps the row in the matrix while signalling that the suite is gone. Future SPECs may delete the row entirely; for this spec, presence + accurate notes is the deliverable.
