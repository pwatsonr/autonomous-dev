# PLAN-031-3: Bats → Jest Reconciliation (Per-SPEC Manual Pass)

## Metadata
- **Parent TDD**: TDD-031-spec-reconciliation-path-vitest-bats
- **Parent PRD**: PRD-016-test-suite-stabilization (G-08, FR-1652)
- **Estimated effort**: ~1.5 hours (15 SPECs × ~5 min = 75 min hand-decisions + ~30 min matrix authoring + spot-check)
- **Dependencies**: []
- **Blocked by**: [PLAN-031-1] (matrix scaffold; pre-stubbed `## Bats (PLAN-031-3)` section)
- **Priority**: P1

## Objective
Reconcile approximately 15 SPEC files that cite `tests/unit/test_*.sh` Bats files
or `.bats`-suffixed files. Bats coverage was retired in favor of Jest-only; the
SPECs were not updated. Per TDD §5.3, this work cannot be sed-edited — every
reference is one of:
- **Case (a):** Bats file has a Jest equivalent → amend the SPEC to cite the Jest path.
- **Case (b):** Bats coverage was retired with no replacement → amend the SPEC to
  record the retirement explicitly (e.g., "Bats coverage retired in TDD-026-prep
  cleanup; no Jest replacement.").

After this plan lands, no SPEC under `plugins/autonomous-dev/docs/specs/` contains
the patterns `\.bats` or `tests/unit/test_.*\.sh`, and every amended SPEC has a
case-(a) or case-(b) decision recorded in the reconciliation matrix.

This is the third of four sequential commits inside the single TDD-031 doc-only
PR (per TDD §8.1).

## Scope

### In Scope
- A pre-sweep audit producing a frozen list of affected SPEC files via
  `grep -rlnE "\.bats|tests/unit/test_.*\.sh" plugins/autonomous-dev/docs/specs/`.
- Per-SPEC hand-decision (case (a) vs case (b)) for each affected SPEC.
- For case (a): identify the Jest equivalent path (typically under
  `plugins/autonomous-dev/tests/...`), confirm the file exists, amend the SPEC
  to cite it.
- For case (b): amend the SPEC's prose to add a one-sentence retirement note
  with a link back to PRD-016 §G-08 / TDD-031.
- Append rows to the `## Bats (PLAN-031-3)` matrix section, one row per amended
  SPEC, with `Action` column = `(a) → <jest path>` or `(b) Retired`.
- A post-sweep verification step:
  `grep -rlnE "\.bats|tests/unit/test_.*\.sh" plugins/autonomous-dev/docs/specs/`
  must return empty.

### Out of Scope
- Path-drift amendments — PLAN-031-1.
- Vitest-token sweep — PLAN-031-2.
- The verification script and CI guard — PLAN-031-4.
- Re-creating retired Bats files as Jest equivalents (NG-3105 / PRD-016 NG-03).
- Authoring new Jest tests to cover the retired Bats surface (NG-3105).
- Re-deriving SPEC content (NG-3101).
- Amending the actual Bats files (none should still exist; if they do, that is
  a separate cleanup tracked by TDD-029 / TDD-032).
- The case where the SPEC mentions Bats only in a "rejected alternative" passage
  (these are historical record; flagged in the matrix and left verbatim with a
  Notes-column annotation analogous to PLAN-031-2 task 2).

## Tasks

1. **Audit pass: enumerate affected SPECs** — Run
   `grep -rlnE "\.bats|tests/unit/test_.*\.sh" plugins/autonomous-dev/docs/specs/ | sort`
   and capture the file list. Compare against TDD §3.1's count of 15.
   - Files to create: none (working scratch only).
   - Acceptance criteria: Frozen list captured. Count documented in matrix
     preamble for the Bats section. Drift from 15 by more than ±3 triggers a
     pause.
   - Estimated effort: 10 min

2. **Per-SPEC case decision** — For each SPEC in the list from task 1:
   1. Open the SPEC and locate the Bats reference(s).
   2. Note the Bats file path (e.g., `tests/unit/test_daemon_lifecycle.sh`).
   3. Search for a Jest equivalent: `find plugins/autonomous-dev -name "*.test.ts"`
      filtered for plausible matches by name root. (e.g.,
      `daemon-lifecycle.test.ts`, `daemon_lifecycle.test.ts`).
   4. If a plausible Jest file exists and its description matches the SPEC's
      intent → case (a). Record the Jest path.
   5. If no Jest file exists OR existing files do not cover the SPEC's intent
      → case (b). Record "Retired, no Jest replacement."
   The result is a per-SPEC decision list paired with the chosen Action string.
   - Files to modify: none in this task.
   - Acceptance criteria: Decision list exists with one row per SPEC from
     task 1. Each row has SPEC ID, Bats path, case letter, and (for case (a))
     the Jest path. Each Jest path passes `test -e <path>` before the row is
     considered complete.
   - Estimated effort: 60 min (15 SPECs × ~4 min)

3. **Apply per-SPEC amendments** — For each row in the decision list:
   - **Case (a):** Replace the Bats path string with the Jest path. If the SPEC
     also has surrounding prose explaining the test choice (e.g., "we use Bats
     because…"), revise the prose to match the Jest reality.
   - **Case (b):** Replace the Bats reference with a one-sentence retirement
     note. Suggested template:
     `Bats coverage (originally <bats-path>) was retired in PRD-016 cleanup;
     no Jest replacement is currently planned.`
   Each amendment is a manual edit; `sed` is not used here because the
   substitutions are not uniform across SPECs.
   - Files to modify: ~15 SPEC files.
   - Acceptance criteria: `git diff` shows ~15 modified SPECs.
     `grep -rlnE "\.bats|tests/unit/test_.*\.sh" plugins/autonomous-dev/docs/specs/`
     returns empty (or returns only declared historical-context whitelist
     entries).
   - Estimated effort: 30 min

4. **Populate matrix Bats section** — For each amended SPEC, add a row:
   `| SPEC-NNN-N-NN | Bats | (a) → <jest path> | @pwatson | <notes> |` or
   `| SPEC-NNN-N-NN | Bats | (b) Retired | @pwatson | <notes> |`.
   Notes capture any (a)→(b) reclassifications the reviewer should know about
   (e.g., "Jest equivalent exists but covers only a subset of the original
   Bats scenarios").
   - Files to modify: `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md`
   - Acceptance criteria: Row count equals modified-SPEC count from task 3.
     Rows alphabetically sorted by SPEC ID. Action column values clearly
     classify as case (a) or case (b).
   - Estimated effort: 30 min

5. **Spot-check three amended SPECs** — Pick one case-(a), one case-(b), and
   one with a Notes annotation. Read each amended passage; confirm the case
   classification is justified and the new prose reads naturally per TDD §9.3.
   For the case-(a) SPEC, verify the cited Jest path resolves
   (`test -e <path>`).
   - Files to modify: matrix preamble only.
   - Acceptance criteria: Three SPECs named, three checks recorded.
   - Estimated effort: 15 min

6. **Commit** — Single commit on the TDD-031 branch:
   `docs(specs): PLAN-031-3 bats → jest reconciliation (~15 SPECs; case-(a)/(b) per-file decisions)`.
   Body lists case-(a) count, case-(b) count, and the three spot-check results.
   - Files to modify: none beyond what tasks 3-5 staged.
   - Acceptance criteria: Single atomic commit. `git log -1 --stat` shows
     amended SPECs + matrix update.
   - Estimated effort: 5 min

## Dependencies & Integration Points

**Exposes to other plans:**
- Final rows in the shared reconciliation matrix. PLAN-031-4's verification
  script reads the file count and compares against the post-sweep grep totals.
- Each case-(a) row's Jest path becomes a candidate for the verification
  script's path-existence check (PLAN-031-4 §5.4 check 4).

**Consumes from other plans:**
- **PLAN-031-1** (blocking): matrix scaffold with pre-stubbed
  `## Bats (PLAN-031-3)` section.

## Testing Strategy

- **Pre-sweep audit (task 1):** Freezes scope.
- **Per-SPEC decision (task 2):** Each case-(a) Jest path is verified to exist
  via `test -e` before the decision is finalized. This is the single highest-
  signal check for the bats class because misclassification (case (b) when
  case (a) exists, or vice versa) is the dominant failure mode.
- **Post-sweep mechanical check (task 3):**
  `grep -rlnE "\.bats|tests/unit/test_.*\.sh" plugins/autonomous-dev/docs/specs/`
  must return empty.
- **Spot-check (task 5):** Three amended SPECs read by a human reviewer for
  classification correctness and prose naturalness.
- **No executable tests added.**

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Case (a)/(b) misclassification: a SPEC is marked Retired when a Jest equivalent exists, silently dropping coverage from the SPEC corpus's view of reality. | Medium | Medium | Each case-(a) decision in task 2 is gated on `test -e <jest-path>`; each case-(b) decision must be recorded with a Notes annotation explaining the search performed. The spot-check (task 5) samples one case-(b) classification and confirms the search was thorough. |
| A "Jest equivalent" exists in name but covers different behavior than the original Bats test. | Medium | Medium | Task 2 step 4 includes a description-match check, not just a name-match check. Notes column flags partial matches (e.g., "Jest equivalent exists but covers only happy path"). PRD-016 NG-03 prevents widening coverage in this PR; the gap becomes a follow-up. |
| The 15-file count drifts since the audit. | Medium | Low | Task 1 re-audits and freezes the count. |
| Per-file manual editing introduces typos in adjacent SPEC text. | Medium | Low | The diff is reviewed at PR time. The verification grep in task 3 catches any residual `.bats` / `test_*.sh` strings; other typos surface during normal review. |
| A SPEC's Bats reference is inside a code fence that documents the original authoring decision (historical context), and rewriting it erases that record. | Low | Low | Treated like PLAN-031-2's historical-context carve-out: flagged in the matrix Notes column, hand-amended with a "Historical:" prefix rather than mechanically replaced. |
| The hand-edits land inconsistent retirement-note phrasing, making the SPEC corpus look unkempt. | Low | Low | Task 3 specifies a single suggested template for case (b). Reviewer can flag deviations during PR review; trivial to align in a follow-up. |

## Definition of Done

- [ ] `grep -rlnE "\.bats|tests/unit/test_.*\.sh" plugins/autonomous-dev/docs/specs/`
      returns empty (or only declared historical-context whitelist entries).
- [ ] `## Bats (PLAN-031-3)` matrix section is populated with one row per
      amended SPEC, sorted by SPEC ID, with Action column clearly indicating
      case (a) or case (b).
- [ ] Every case-(a) row's cited Jest path resolves to a real file in the tree
      (verified during task 2; re-verified mechanically by PLAN-031-4).
- [ ] Three spot-checks recorded in the matrix preamble for this section.
- [ ] Single commit on the TDD-031 branch with the prescribed message.
- [ ] No production code or test code is modified.
- [ ] No new Bats files created; no new Jest tests authored to cover retired
      Bats surface (NG-3105 / PRD-016 NG-03 respected).
