# PLAN-031-4: Verification Script + CI Guard (Re-Drift Prevention)

## Metadata
- **Parent TDD**: TDD-031-spec-reconciliation-path-vitest-bats
- **Parent PRD**: PRD-016-test-suite-stabilization (G-08, FR-1654)
- **Estimated effort**: ~0.5 day (~30 min script authoring + ~15 min CI wiring + ~30 min self-test PR + ~30 min PR description authoring)
- **Dependencies**: []
- **Blocked by**: [PLAN-031-1, PLAN-031-2, PLAN-031-3]
- **Priority**: P1

## Objective
Codify the TDD-031 verification gate as an executable artifact and wire it into
CI so the three drift classes (path drift, vitest references, bats references)
cannot recur. Ship `scripts/verify-spec-reconciliation.sh` per TDD §5.4 and add
a new step to `.github/workflows/ci.yml` that runs it on every PR.

After this plan lands, PR builds fail if any future SPEC introduces
`src/portal/`, the `vitest` token, or a `.bats` / `tests/unit/test_*.sh`
reference, or if any cited `plugins/autonomous-dev/...` path in a SPEC does not
resolve to a real file.

This is the fourth and final commit inside the single TDD-031 doc-only PR
(per TDD §8.1).

## Scope

### In Scope
- A new bash script `scripts/verify-spec-reconciliation.sh` implementing the
  four checks from TDD §5.4:
  1. No remaining `src/portal/` references in SPEC files.
  2. No remaining `vitest` references (case-insensitive, word-boundary).
  3. No remaining bare bats references
     (`.bats` or `tests/unit/test_.*\.sh`).
  4. Every cited `plugins/autonomous-dev[-portal]?/...\.(ts|js|md|json|yml|yaml)`
     path inside any SPEC under `plugins/autonomous-dev/docs/specs/` resolves
     to an extant file.
- The script:
  - Uses `set -euo pipefail`.
  - Names offending SPECs and tokens in failure messages so future violators
    get actionable feedback (TDD §6.5).
  - Exits 0 on PASS and non-zero with a clear final line on FAIL.
- A new CI step in `.github/workflows/ci.yml` named `spec-reconciliation` that
  invokes the script. Runs on every PR (no path filter — the script is fast
  and the cost of missing a reintroduced drift exceeds the cost of running it
  unconditionally).
- A self-test artifact in the PR description (TDD §9.2): a throwaway-branch
  experiment showing that the new CI step fails when a deliberate
  `src/portal/` reference is added to a SPEC, and passes when the reference is
  removed. The artifact is two run URLs (one red, one green) plus a note
  confirming the throwaway branch is deleted.
- The PR description's per-SPEC summary (TDD §6.4 / G-3105): a table that
  aggregates the matrix rows from PLAN-031-1/2/3 grouped by drift class, with
  each row linking to the amended SPEC's diff anchor. The summary is generated
  by hand from the matrix, not auto-generated, because TDD §8.1 prefers
  reviewer-readable prose over machine output.
- A note in the matrix preamble pointing at the new script and CI step as the
  durable enforcement mechanism.

### Out of Scope
- Authoring the actual amendments (handled by PLAN-031-1/2/3).
- Markdown AST-level checks (TDD §7.2 — rejected as too much machinery).
- LLM-driven SPEC review (TDD §7.1 — rejected as non-deterministic).
- Splitting the verification into TDD-029's harness-migration CI gate (TDD
  OQ-31-02 — separate step is preferred).
- Whitelisting historical-context SPECs identified in PLAN-031-2 task 2 /
  PLAN-031-3 (out of scope; those SPECs were carved out of the sweep and the
  script's grep MUST report zero hits — historical-context entries are
  rewritten with a "Historical:" prefix that does not contain the bare
  drift token).
- Updating any existing TDD-029 CI gate (sibling concern; coordinated via the
  PR coordination notes but not implemented here).
- Caching or parallelising the script's path-existence check across PRs;
  current TDD-031 corpus is small enough that <500 ms is sufficient.

## Tasks

1. **Author `scripts/verify-spec-reconciliation.sh`** — Implement the four
   checks from TDD §5.4. Use POSIX-portable bash where possible (the CI
   runner is Ubuntu, but the script should also run on macOS for local
   pre-PR checks). Include a usage banner and a final PASS/FAIL line.
   - Files to create: `scripts/verify-spec-reconciliation.sh`
   - Acceptance criteria: File exists, is `chmod +x`, starts with
     `#!/usr/bin/env bash` and `set -euo pipefail`. Running it locally on a
     clean post-PLAN-031-3 working tree exits 0 and prints a final `PASS`.
     Running it after introducing `src/portal/foo.ts` into a SPEC exits
     non-zero and names the offending SPEC.
   - Estimated effort: 30 min

2. **Local self-tests of the script** — On the working tree:
   - **Negative test 1 (path drift):** Add `src/portal/foo.ts` to a SPEC,
     run the script, confirm it fails with check (1)'s message. Revert.
   - **Negative test 2 (vitest):** Add a `vitest` mention to a SPEC, run,
     confirm it fails with check (2)'s message. Revert.
   - **Negative test 3 (bats):** Add a `.bats` reference, run, confirm it
     fails with check (3)'s message. Revert.
   - **Negative test 4 (path-existence):** Add a fictional
     `plugins/autonomous-dev/never-existed.ts` cite to a SPEC, run, confirm
     it fails with check (4)'s message naming the missing path. Revert.
   - **Positive test:** Run on the clean tree; confirm PASS.
   The five runs are documented in the matrix preamble's "Verification log"
   subsection.
   - Files to modify: matrix preamble only (revert all SPEC scratch edits).
   - Acceptance criteria: Five runs documented with expected vs observed
     outcomes. Working tree is clean after the tests.
   - Estimated effort: 30 min

3. **Wire the script into `.github/workflows/ci.yml`** — Add a new job (or
   step inside an existing doc-validation job, depending on the workflow's
   structure as of branch `docs/plans-from-tdd-031` head). The new job:
   - Has a stable name (`spec-reconciliation`) for branch-protection
     stability.
   - Runs `bash scripts/verify-spec-reconciliation.sh`.
   - Uses `ubuntu-latest`.
   - Does not gate on any path filter (TDD §6.6: <500 ms cost is negligible).
   - Reports failure with the script's stderr surfaced to the Actions log.
   - Files to modify: `.github/workflows/ci.yml`.
   - Acceptance criteria: New job/step appears in the workflow. `actionlint`
     passes against the modified workflow (PLAN-016-2's
     `.github/actionlint.yaml` policy). On a clean PR the job passes.
   - Estimated effort: 15 min

4. **Throwaway-branch self-test PR (CI guard self-test, TDD §9.2)** — On a
   throwaway branch off `docs/plans-from-tdd-031`:
   - Add `src/portal/test.ts` to a SPEC and push. Confirm CI fails on the
     new `spec-reconciliation` step. Capture run URL.
   - Remove the bad reference and push. Confirm CI passes. Capture run URL.
   - Close the throwaway PR (do not merge); delete the throwaway branch.
   The two run URLs and the deletion confirmation are recorded in the main
   PR's description.
   - Files to modify: none on the main TDD-031 branch.
   - Acceptance criteria: Two run URLs captured (one red, one green) plus a
     confirmation that the throwaway branch is deleted. Recorded in the PR
     description.
   - Estimated effort: 30 min

5. **Author the PR description's per-SPEC summary** — Per TDD §6.4 / G-3105.
   Aggregate the rows from PLAN-031-1/2/3's matrix sections into a single
   reviewer-friendly table at the top of the PR body, grouped by drift class
   (Path, Vitest, Bats). Each row has SPEC ID, class, action summary, and
   a link anchor (e.g., `#diff-...`) to the amended file. The summary is
   hand-authored, not generated; the matrix is the source of truth.
   - Files to modify: PR description (out-of-tree; no commit).
   - Acceptance criteria: The PR body's first section is a per-SPEC summary
     table. Total row count equals the sum of rows across the three matrix
     sections. Three links are clicked at random and resolve to the correct
     diff hunks.
   - Estimated effort: 30 min

6. **Update matrix preamble with enforcement-mechanism note** — Add a short
   paragraph in `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md`
   pointing at `scripts/verify-spec-reconciliation.sh` and the CI step as the
   durable enforcement mechanism. State that any future SPEC reintroducing
   the drift tokens will fail CI.
   - Files to modify: `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md`
   - Acceptance criteria: Preamble mentions the script path and the CI step
     name. Includes the local invocation hint
     (`bash scripts/verify-spec-reconciliation.sh`).
   - Estimated effort: 10 min

7. **Commit** — Single commit on the TDD-031 branch:
   `docs(specs): PLAN-031-4 verification script + CI guard for SPEC reconciliation`.
   Body lists the four checks, the five self-test results from task 2, the
   two run URLs from task 4, and the matrix-preamble update.
   - Files to modify: none beyond what tasks 1-3, 6 staged.
   - Acceptance criteria: Single atomic commit including the script, the
     workflow change, and the matrix preamble update. `git log -1 --stat`
     shows three files (script, workflow, matrix).
   - Estimated effort: 5 min

## Dependencies & Integration Points

**Exposes to other plans:**
- A reusable verification script (`scripts/verify-spec-reconciliation.sh`)
  callable by future maintenance PRs that touch SPECs.
- A stable CI step name (`spec-reconciliation`) for branch-protection rules.
- Sets the precedent that SPEC-corpus hygiene is enforced mechanically;
  future SPEC-drift PRDs (analogous to PRD-016) can extend or alias the same
  pattern.

**Consumes from other plans:**
- **PLAN-031-1, PLAN-031-2, PLAN-031-3** (all blocking): the script's checks
  (1)/(2)/(3) MUST pass on the clean post-amendment tree. If any of those
  plans incompletely sweeps its drift class, this plan's CI step will fail
  on the integration commit.
- The matrix file authored by PLAN-031-1 and appended to by PLAN-031-2/3 is
  the source for the PR description's per-SPEC summary.
- Implicit dependency on `.github/workflows/ci.yml` being a valid actionlint
  target (per PLAN-016-2). If the workflow has structural issues from a
  sibling change, this plan surfaces them via the new step's `actionlint`
  pass.

## Testing Strategy

- **Local script self-tests (task 2):** Five runs covering each check in
  isolation plus a positive run. This is the highest-signal test of the
  script's correctness.
- **CI guard self-test PR (task 4):** Two runs (one red, one green) on a
  throwaway PR confirming the gate fires in CI as well as locally. The
  throwaway branch is deleted post-test.
- **Integration check at PR time:** Once all four PLAN-031-* commits are on
  the branch, the new `spec-reconciliation` CI step runs and must pass. A
  failure here means at least one of PLAN-031-1/2/3's sweeps was
  incomplete; the failure points at the offending SPEC.
- **No unit tests for the bash script.** The script is a thin grep wrapper;
  upstream `grep` and `bash` have their own test suites. Coverage is
  contractual: each of the four checks has a paired negative test in
  task 2.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| The script's path-existence check (4) flags pre-existing path drift in SPECs that are NOT part of the three TDD-031 drift classes (e.g., a typo in a path cite). | Medium | Medium | Per TDD OQ-31-07, surfaced drift IS reconciled in this PR — add a row to the matrix and amend the SPEC. The plan budget accommodates a small (≤3) number of such follow-ups; if more surface, the issue is escalated to the PR reviewer for a scoping decision. |
| `grep -rohE` syntax differs between BSD and GNU grep, breaking local-vs-CI parity. | Medium | Low | Test the script on macOS (BSD grep) and Linux (GNU grep) during task 2. Use POSIX-portable patterns where possible; if BSD-specific behavior is unavoidable, document the constraint in the script header. |
| The CI workflow's modification accidentally breaks an existing job. | Low | High | Run `actionlint` locally before pushing. Task 3's acceptance criterion includes actionlint passing. The throwaway-branch test (task 4) confirms the change does not break unrelated jobs. |
| The path-existence check's regex over-matches (e.g., catches a path inside a code-block string literal that is intentionally fictional). | Low | Low | The regex is anchored on the `plugins/autonomous-dev` prefix; intentionally-fictional paths in SPECs are rare. If a false positive surfaces, the SPEC is amended to wrap the fictional path in something like `<placeholder>` so the regex misses it; this is an acceptable cost of the durable check. |
| The PR description's per-SPEC summary table is large enough to make the PR body unwieldy. | Medium | Low | TDD §6.4 explicitly favors reviewer-friendly summaries over auto-generated dumps. If the table is large, the summary is paged into a `<details>` block. |
| The throwaway-branch self-test PR is accidentally merged. | Very Low | Medium | Task 4's deletion confirmation is part of the DoD; reviewer must see the branch deleted before approving the main TDD-031 PR. |
| A future contributor disables the CI step locally (`if: false`) and the protection lapses. | Low | Medium | Branch-protection rules require the `spec-reconciliation` check to pass; disabling locally cannot bypass the rule. This requires repo-admin enforcement out of band. |

## Definition of Done

- [ ] `scripts/verify-spec-reconciliation.sh` exists, is `chmod +x`, and runs
      to PASS on the clean post-PLAN-031-3 tree.
- [ ] All five local self-tests (4 negative, 1 positive) from task 2 are
      documented in the matrix preamble's Verification log.
- [ ] `.github/workflows/ci.yml` includes a `spec-reconciliation` job/step
      that invokes the script unconditionally on every PR.
- [ ] `actionlint` passes against the modified workflow.
- [ ] Throwaway-branch self-test produces one red run URL and one green run
      URL; both URLs are recorded in the main PR description.
- [ ] Throwaway branch is deleted before the main PR is approved.
- [ ] Matrix preamble references the script path, CI step name, and local
      invocation command.
- [ ] The PR description's per-SPEC summary table aggregates all
      PLAN-031-1/2/3 matrix rows grouped by class, with a row count equal to
      the sum of the three sections' row counts.
- [ ] Single commit on the TDD-031 branch with the prescribed message.
- [ ] No production code (outside `scripts/` and `.github/workflows/`) is
      modified by this plan.
