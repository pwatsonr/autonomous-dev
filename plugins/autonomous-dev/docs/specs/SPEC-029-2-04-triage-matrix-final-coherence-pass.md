# SPEC-029-2-04: Triage Matrix — Final Coherence Pass

## Metadata
- **Parent Plan**: PLAN-029-2 (Test Failure Triage Matrix Authoring & Disposition)
- **Parent TDD**: TDD-029
- **Parent PRD**: PRD-016
- **Tasks Covered**: PLAN-029-2 Task 7 (final coherence pass: re-run jest, reconcile any newly-revealed FAIL, confirm matrix consistency, finalise summary)
- **Estimated effort**: 3 hours (~1h jest re-run + log analysis, ~1h reconciliation if any new rows surface, ~1h matrix finalisation and PR-readiness)
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/docs/triage/PRD-016-test-failures.md` (final touch-up modifications)
- **Depends on**: SPEC-029-2-01, SPEC-029-2-02, SPEC-029-2-03 (all matrix population work must be complete)

## Description

Re-run `npx jest --runInBand` against the post-disposition tree (after SPEC-029-2-03's `.skip` annotations and DELETE commits). Confirm the run produces zero un-dispositioned FAILs (every FAIL is now either skipped via SPEC-029-2-03 or has been deleted). If the SKIP-WITH-NOTE annotations themselves un-mask new FAILs (a suite that was previously masked because an earlier suite crashed the worker), add rows for those new FAILs and loop back through SPEC-029-2-02 / SPEC-029-2-03's procedures for the new rows. Update the matrix's bottom-line summary to reflect the final state. The deliverable bridges PLAN-029-2's "matrix is populated" to PLAN-029-3's "CI gate can ship green" precondition.

This is a small spec by line count but high-impact: it is the final gate before SPEC-029-3 can proceed. A SPEC-029-3 PR that runs `npx jest --runInBand --ci` against an un-coherent matrix will be red on day one; this spec's job is to ensure that does not happen.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `docs/triage/PRD-016-test-failures.md` | Modify | Append rows for any newly-revealed FAILs; update Summary; finalise YYYY-MM-DD |
| `plugins/autonomous-dev/tests/<paths>/<file>.test.ts` | Modify (if new SKIP-WITH-NOTE rows surface) | Add `describe.skip` / `it.skip` for any new rows per SPEC-029-2-03 procedure |

Commits:

- **Coherence-loop commits** (zero or more): for each newly-revealed FAIL, one commit per the SPEC-029-2-03 per-row procedure (matrix row addition + skip annotation; or DELETE with FR-1613 fields if applicable).
- **Final commit** (always): matrix Summary section finalisation with the post-loop counts.

## Implementation Details

### Step 1: Re-run jest against the post-disposition tree

From `plugins/autonomous-dev/`:

```
$ npx jest --runInBand 2>&1 | tee /tmp/jest-postdisposition-$(date +%Y%m%d-%H%M%S).log
```

Read the captured log carefully. Expected outcomes:

- jest exits with a summary, no worker crash.
- Every previously-FAILing suite either PASSES (e.g., `harness-residue` rows whose migration fix is now visible because no upstream failure masks the suite), is reported as `pending` / skipped (SPEC-029-2-03 `.skip` annotations), or is gone from the report (DELETE rows).
- Some new FAIL suites MAY appear: these are suites that were previously hidden because an upstream `process.exit` aborted the worker before they ran. The triage matrix did not include them; they need rows now.

### Step 2: Diff the post-disposition FAIL list against the matrix

Extract the new FAIL list:

```
$ grep -E "^FAIL " /tmp/jest-postdisposition-*.log | awk '{print $2}' | sort -u > /tmp/postdisp-fails.txt
```

Extract the matrix's existing un-handled paths (rows whose Disposition is NOT `SKIP-WITH-NOTE` and NOT `DELETE`, since those are expected to be absent from the FAIL list now):

```
$ grep -E "^\| [0-9]+ \|" docs/triage/PRD-016-test-failures.md \
    | grep -v "SKIP-WITH-NOTE\|DELETE" \
    | awk -F"|" '{print $3}' \
    | tr -d ' ' \
    | sort -u > /tmp/matrix-unhandled.txt
```

Compute the diff:

```
$ comm -23 /tmp/postdisp-fails.txt /tmp/matrix-unhandled.txt
```

Each line in the output is a FAIL suite path that does NOT have a matrix row for a non-skipped disposition. These are the newly-revealed FAILs that need rows.

If the diff is empty, skip to Step 5 (Final Summary).

### Step 3: Reconcile newly-revealed FAILs

For each path emitted by Step 2's diff:

1. Append a new row to the matrix's data table with the next monotonic Row id, the verbatim Suite path, and `TBD` placeholders for Category / Disposition / Owner / Linked / Notes (per SPEC-029-2-01 schema).
2. Apply the SPEC-029-2-02 per-row categorisation procedure: reproduce the failure (`npx jest <suite-path>`), inspect the test and production code, and pick a Category + Notes hypothesis. Replace the `TBD`s for those cells.
3. Apply the SPEC-029-2-03 per-row disposition procedure: pick a Disposition, name an Owner, fill Linked. If the disposition is `SKIP-WITH-NOTE`, land the `describe.skip` / `it.skip` + `// SKIP per PRD-016 triage row N: <reason>` annotation in the test file (one commit per row per SPEC-029-2-03 step 4).

Each new row + its skip annotation lands as the same kind of small per-row commit SPEC-029-2-03 used. Body:

```
test(skip): row N (post-disposition reconciliation) SKIP-WITH-NOTE — <suite-path>

Newly-revealed FAIL after SPEC-029-2-03 unmasked it. Categorised and
dispositioned per the SPEC-029-2-02/03 per-row procedure.

<one-line reason>

Refs PRD-016 FR-1610, FR-1611, FR-1612, triage row N; TDD-029 §6.3;
PLAN-029-2 Task 7 (coherence loop).
```

### Step 4: Re-run jest after each loop iteration

After every reconciliation commit (or batch of commits), re-run:

```
$ npx jest --runInBand 2>&1 | tail -50
```

Confirm the FAIL count is dropping toward zero. If a reconciliation commit reveals YET ANOTHER previously-masked suite, repeat Steps 2–3. The loop terminates when:

- `grep -E "^FAIL " <log>` returns zero non-skipped lines, OR
- The same set of new FAILs surfaces twice in a row (no progress; the upstream fix is incomplete and needs investigation outside this spec — surface as a PR comment and pause).

### Step 5: Confirm matrix internal consistency

After the loop terminates (zero un-handled FAILs), run the consistency checks:

```
$ # No TBD anywhere
$ grep -cE "^\| [0-9]+ \|.*\| TBD \|" docs/triage/PRD-016-test-failures.md
0

$ # SKIP grep matches matrix count
$ MATRIX_SKIPS=$(grep -cE "^\| [0-9]+ \|.*\| SKIP-WITH-NOTE \|" docs/triage/PRD-016-test-failures.md)
$ TREE_SKIPS=$(git grep -c "SKIP per PRD-016 triage row" plugins/autonomous-dev/tests/ | awk -F: '{s+=$NF} END {print s}')
$ test "$MATRIX_SKIPS" = "$TREE_SKIPS" || echo "MISMATCH: matrix=$MATRIX_SKIPS tree=$TREE_SKIPS"

$ # Row IDs are unique and monotonic from 1
$ grep -oE "^\| [0-9]+ \|" docs/triage/PRD-016-test-failures.md | grep -oE "[0-9]+" | sort -n | uniq -d
(empty: no duplicate row ids)

$ # FAIL + DELETE counts match the original PLAN-029-1 capture (no rows lost in transcription)
$ ORIGINAL_FAIL_COUNT=<from SPEC-029-1-05 captured log>
$ MATRIX_TOTAL=$(grep -cE "^\| [0-9]+ \|" docs/triage/PRD-016-test-failures.md)
$ FR1614_CARRYOVERS=<count from SPEC-029-2-01 step 4>
$ POST_DISP_NEW=$(<count of rows added in this spec's coherence loop>)
$ test "$MATRIX_TOTAL" = "$((ORIGINAL_FAIL_COUNT + FR1614_CARRYOVERS + POST_DISP_NEW))" \
    || echo "MISMATCH: total=$MATRIX_TOTAL expected=$((ORIGINAL_FAIL_COUNT + FR1614_CARRYOVERS + POST_DISP_NEW))"
```

All four checks MUST pass. Any mismatch blocks merge.

### Step 6: Finalise the Summary section

Update the Summary section with the final counts:

```
- Generated from `npx jest --runInBand` run on YYYY-MM-DD; finalised YYYY-MM-DD; N rows.
- Per-category counts: regression=X, fixture=Y, flake=Z, harness-residue=W. Total: N.
- Per-disposition counts: FIX(this-PR)=A, FIX(next-PR)=B, FIX(next-sprint)=C, SKIP-WITH-NOTE=D, DELETE=E. Total: N.
- Coherence-loop additions: P new rows surfaced after SPEC-029-2-03's skips unmasked them.
- Post-disposition jest run: zero non-skipped FAILs. Captured at <log-path or PR-description-anchor>.
```

`P` is the count of rows added during this spec's coherence loop (zero is a valid value).

### Step 7: Final commit

```
docs(triage): finalise PRD-016 test failure triage matrix (SPEC-029-2-04)

Final coherence pass per PLAN-029-2 Task 7:
  - Re-ran `npx jest --runInBand` against the post-disposition tree.
  - <P> previously-masked FAILs surfaced and were rowed + dispositioned
    per the SPEC-029-2-02/03 per-row procedure.
  - Zero non-skipped FAILs in the final run.
  - Matrix internal consistency verified:
      * No TBD cells.
      * git grep "SKIP per PRD-016 triage row" count == matrix
        SKIP-WITH-NOTE count.
      * Row IDs unique and monotonic.
      * Total rows == original FAIL + FR-1614 carryovers + coherence-loop
        additions.

Summary section finalised. Matrix is now ready for SPEC-029-3-* (CI
gate) — `npx jest --runInBand --ci` will exit 0 against this tree.

Refs PRD-016 FR-1610, FR-1614; TDD-029 §6; PLAN-029-2 Task 7.
```

### What NOT to do

- Do NOT skip the post-disposition jest re-run. The whole point of this spec is to verify the matrix is internally consistent against the actual jest output, not against the matrix's own metadata.
- Do NOT bulk-add coherence-loop rows in a single commit. Each new FAIL goes through the SPEC-029-2-02/03 per-row procedure; bulk additions hide categorisation rationale.
- Do NOT lower the bar on Notes hypotheses for coherence-loop rows. Newly-revealed failures are NOT a license for vague hypotheses; same diagnostic depth as the original rows.
- Do NOT loop indefinitely. If the same FAIL surfaces twice without progress, pause and surface the underlying issue (likely a `beforeAll` regression in a SPEC-029-1-* commit) as a PR comment. Do not paper over instability.
- Do NOT modify SPEC-029-2-02's Category cells or SPEC-029-2-03's Disposition cells for already-rowed entries. This spec only ADDS rows (or in degenerate case, no rows). Re-categorisation is a re-do of SPEC-029-2-02, not a Task 7 activity.
- Do NOT advance to SPEC-029-3-* before this spec's final jest run shows zero non-skipped FAILs. SPEC-029-3-02's `--ci` flag has no allowlist; any leftover FAIL breaks the CI gate.

## Acceptance Criteria

- [ ] Post-disposition `npx jest --runInBand` from `plugins/autonomous-dev/` exits with zero non-skipped FAIL suites. Captured log attached to PR description or as workflow artifact.
- [ ] If any newly-revealed FAILs surfaced, each has a corresponding row in `docs/triage/PRD-016-test-failures.md` with non-`TBD` Category, Disposition, Owner, Linked, Notes (matching SPEC-029-2-02/03 cell expectations).
- [ ] If any SKIP-WITH-NOTE rows were added during the coherence loop, each has a corresponding `describe.skip` / `it.skip` annotation with the `// SKIP per PRD-016 triage row N: <reason>` comment.
- [ ] `git grep -c "SKIP per PRD-016 triage row" plugins/autonomous-dev/tests/` equals the SKIP-WITH-NOTE count in the matrix (the post-coherence-loop count, including any additions from this spec).
- [ ] Row IDs are unique and monotonic from 1 (no duplicates, no gaps).
- [ ] No `TBD` values anywhere in the data table or Notes column. Verified by `grep -cE "^\| [0-9]+ \|.*\| TBD \|" docs/triage/PRD-016-test-failures.md` returning 0.
- [ ] Matrix Summary section is finalised with: original capture date, finalisation date, total rows, per-category counts (totalling row count), per-disposition counts (totalling row count), coherence-loop additions count, and a reference to the post-disposition log.
- [ ] Final commit body matches the §Step 7 template; references `PRD-016 FR-1610, FR-1614; TDD-029 §6; PLAN-029-2 Task 7`.
- [ ] Each coherence-loop addition lands as its own commit (per the SPEC-029-2-03 per-row discipline). One commit per added row.
- [ ] No matrix cells whose Disposition was `FIX (next-PR)` or `FIX (next-sprint)` were rewritten in this spec; this spec only ADDS rows or finalises Summary.
- [ ] No production-code files modified. Verified by `git diff --name-only <spec-base>..HEAD | grep -v "tests/\|docs/triage/"` returning nothing.

## Dependencies

- **Blocked by**: SPEC-029-2-01, SPEC-029-2-02, SPEC-029-2-03. The coherence loop only meaningfully runs after all three predecessor specs have populated the matrix and applied skip annotations.
- **Blocks**: SPEC-029-3-02 (CI grep + replace carve-out with `--ci`). The `--ci` flag has no allowlist; ship after this spec confirms zero non-skipped FAILs.
- **Blocks**: SPEC-029-3-04 (CI gate self-test). The self-test relies on a clean tree.

## Notes

- The expected `P` (coherence-loop additions) value is small (often zero). Most jest harness migrations do not unmask many additional suites because the `process.exit` was at end-of-file, not mid-stream. If `P > 5`, surface that as PR-description signal — it suggests the migration tree had more masked failures than expected and may justify reopening triage scope.
- The "same FAIL surfaces twice without progress" termination condition is rare but real. It happens when a `beforeAll` introduced by SPEC-029-1-* is itself flaky and fails the suite at random. Diagnosis is not in this spec's scope; the right response is to pause and surface the issue.
- The grep-based matrix consistency checks (Step 5) are deliberately Bash-friendly so they can be embedded into a future CI job (SPEC-029-3-02 covers the `process.exit` grep but a follow-up could add a "matrix consistency" grep to fail PRs whose matrix drifts from the test tree).
- The "no TBD anywhere" check is the strongest single signal of matrix completeness. Reviewers running this grep on the SPEC-029-2-04 PR can verify the entire SPEC-029-2-* series in one command.
- The final commit's Summary update is small (a few line edits). Keeping it as a separate commit (not merged with coherence-loop additions) makes the SPEC-029-2-04 PR's narrative clear: "loop until done, then finalise."
- After this spec ships, the matrix is a permanent fixture. Future PRs that add new test suites whose first run fails are expected to add a row to this matrix as part of their own review (the matrix is open-ended). Documenting this expectation in the SPEC-029-2-04 PR description seeds the convention.
- A reviewer's checklist for this PR: (1) read the post-disposition jest log to confirm zero non-skipped FAILs, (2) run the four consistency-check greps from Step 5, (3) eyeball the Summary section's counts against the data table, (4) verify each coherence-loop commit has a per-row body matching SPEC-029-2-03's template.
