# SPEC-031-4-02: CI Workflow Integration + Throwaway-Branch Self-Test PR

## Metadata
- **Parent Plan**: PLAN-031-4 (verification script + CI guard)
- **Parent TDD**: TDD-031-spec-reconciliation-path-vitest-bats (§3.3, §5.4, §8.4, §9.2)
- **Parent PRD**: PRD-016-test-suite-stabilization (G-08, FR-1654)
- **Tasks Covered**: PLAN-031-4 task 3 (wire script into CI), task 4 (throwaway-branch self-test PR)
- **SPECs amended by this spec**: 0 (this spec adds a CI step and runs a transient self-test PR)
- **Estimated effort**: 45 minutes (~15 min CI wiring + ~30 min throwaway-branch PR)
- **Status**: Draft
- **Depends on**: SPEC-031-4-01 (verify-spec-reconciliation.sh exists, executable, passes locally on a clean tree)

## Summary
Wire `scripts/verify-spec-reconciliation.sh` into `.github/workflows/ci.yml`
as a stable `spec-reconciliation` job/step that runs unconditionally on
every PR, then exercise the gate end-to-end via a throwaway-branch self-
test PR that captures one red CI run (drift introduced) and one green CI
run (drift removed). Branch and self-test PR are deleted before the main
TDD-031 PR is approved.

## Functional Requirements

- **FR-1**: `.github/workflows/ci.yml` MUST gain a stable-named CI step
  or job whose `name` (or job key) is `spec-reconciliation`. Whether it
  is a new top-level job or a step inside an existing doc-validation job
  is a workflow-structure judgment call left to the implementer; in
  either case the stable name MUST be present so branch-protection rules
  can target it.
  - Implementation note: if the workflow already has a `lint` or
    `docs-validation` job, prefer adding a step inside it (saves runner
    spin-up time). Otherwise add a new job with `runs-on: ubuntu-latest`.
- **FR-2**: The new CI step MUST invoke `bash scripts/verify-spec-reconciliation.sh`.
  The step MUST NOT be guarded by a `paths` filter; per TDD §6.6 the
  ~500 ms cost is negligible and a `paths` filter could miss SPEC edits
  that come in via merges.
- **FR-3**: The new CI step's stderr (and stdout) MUST be visible in the
  Actions log so a future violator gets actionable feedback. Default
  GitHub Actions log surfacing is sufficient; no special log redirection
  is required.
- **FR-4**: `actionlint` MUST pass against the modified workflow per
  PLAN-016-2's `.github/actionlint.yaml` policy. Run locally:
  ```bash
  actionlint .github/workflows/ci.yml
  ```
  Task: PLAN-031-4 task 3 acceptance criterion.
- **FR-5**: A throwaway PR MUST be opened from a transient branch
  (suggested name: `tdd-031-self-test`) that:
  1. Adds `src/portal/test.ts` to a SPEC and pushes; CI must fail on the
     `spec-reconciliation` step. The red run URL MUST be captured.
  2. Removes the bad reference and pushes; CI must pass. The green run
     URL MUST be captured.
  3. The throwaway PR MUST be closed without merging.
  4. The throwaway branch MUST be deleted (`git push origin --delete
     tdd-031-self-test`).
  Task: PLAN-031-4 task 4.
- **FR-6**: The two run URLs (red and green) AND the branch-deletion
  confirmation MUST be recorded in the matrix preamble's "CI guard
  self-test" subsection (committed by SPEC-031-4-03).
- **FR-7**: The CI step MUST NOT modify any other CI step's behavior.
  Pre-existing jobs continue to run as before; the new step is purely
  additive.

## Non-Functional Requirements

| Requirement | Target | Measurement Method |
|-------------|--------|---------------------|
| CI step latency | < 30 s wall-clock (script ~500 ms + runner overhead) | Observed run time in the Actions log |
| Workflow validity | `actionlint` passes | `actionlint .github/workflows/ci.yml; echo $?` returns 0 |
| Stable job/step name | Exactly `spec-reconciliation` | Grep the workflow YAML for the literal name |
| Self-test reproducibility | Red run reproduces failure cleanly; green run reproduces pass cleanly | The two captured run URLs |
| No regression in pre-existing jobs | Pre-existing jobs continue to pass | The throwaway-branch green run shows all jobs green, not just the new one |

## Patterns to Find/Replace

This spec performs no SPEC content substitutions. It modifies one CI
workflow file and runs a transient self-test PR.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `.github/workflows/ci.yml` | Modify | Add `spec-reconciliation` step (or job) invoking the verification script |

No new files are created. The throwaway branch and PR are out-of-tree
artifacts; their evidence (run URLs) is recorded in the matrix preamble
by SPEC-031-4-03.

## Verification Commands

```bash
# 1. Stable name present in the workflow
grep -E "name: spec-reconciliation|^\s+spec-reconciliation:" \
  .github/workflows/ci.yml

# 2. Script invocation present
grep -E "verify-spec-reconciliation\.sh" .github/workflows/ci.yml

# 3. No `paths:` filter on the new step (FR-2)
# Inspect manually; the new step's parent job/step block must not have a
# paths-on-pull-request filter that would skip non-docs PRs.

# 4. Actionlint passes
actionlint .github/workflows/ci.yml
test "$?" = "0"

# 5. The pre-existing jobs are still present (no regressions)
# (Compare job names before/after the edit; manual diff review.)
git diff .github/workflows/ci.yml | grep -E "^- " | grep -v "spec-reconciliation"
# Should show only additions (+), no deletions of pre-existing jobs.

# 6. Throwaway-PR self-test
# (Performed on the throwaway branch; documented out-of-band.)
# Red run:   gh pr view <throwaway-pr> --json url,statusCheckRollup
# Green run: gh pr view <throwaway-pr> --json url,statusCheckRollup
# Branch deletion:
#   git push origin --delete tdd-031-self-test
#   ! git ls-remote --heads origin tdd-031-self-test | grep tdd-031-self-test
```

## Acceptance Criteria

```
Given the verification script exists at scripts/verify-spec-reconciliation.sh
When SPEC-031-4-02 wires it into CI
Then `.github/workflows/ci.yml` contains a step or job named `spec-reconciliation`
And the step invokes `bash scripts/verify-spec-reconciliation.sh`
And the step has no `paths:` filter that would skip non-docs PRs
```

```
Given the workflow YAML has been edited
When `actionlint .github/workflows/ci.yml` is run
Then exit code is 0
And no warnings or errors are reported
```

```
Given the workflow modification is committed
When the main TDD-031 PR runs CI
Then the `spec-reconciliation` step appears in the Actions log
And on a clean post-PLAN-031-3 tree, the step passes (exit 0)
And pre-existing jobs continue to pass
```

```
Given a throwaway branch is created with a deliberate `src/portal/test.ts` SPEC injection
When CI runs on the throwaway PR
Then the `spec-reconciliation` step fails (red)
And the failure message names the offending SPEC
And the run URL is captured for the matrix preamble
```

```
Given the throwaway branch removes the bad reference and pushes
When CI re-runs
Then the `spec-reconciliation` step passes (green)
And the run URL is captured for the matrix preamble
```

```
Given both red and green run URLs are captured
When the throwaway PR is closed without merging
And the throwaway branch is deleted
Then `git ls-remote --heads origin tdd-031-self-test` returns empty
And the deletion confirmation is recorded in the matrix preamble
```

```
Given the new CI step is added
When a future SPEC introduces any of the three drift classes
Then CI fails on the `spec-reconciliation` step
And the failure points at the offending SPEC and token
And the contributor cannot merge without removing the drift
```

## Rollback Plan

If the workflow edit breaks an unrelated job:
```bash
git checkout -- .github/workflows/ci.yml
```
Re-author the new step from the TDD §5.4 reference.

If `actionlint` fails:
- Read the actionlint output; the message names the line and the
  violation.
- Fix the YAML syntax/structure; re-run `actionlint`.
- Do NOT silence actionlint with `# actionlint: ignore` directives.

If the throwaway PR is accidentally merged:
- Revert the merge commit immediately.
- Delete the throwaway branch.
- Note the incident in the matrix preamble.

If the throwaway branch fails to delete (e.g., permission issue):
- Try `gh api repos/:owner/:repo/git/refs/heads/tdd-031-self-test -X DELETE`.
- If still blocked, escalate to repo admin; do NOT proceed to PR
  approval until the branch is deleted.

## Implementation Notes

- The job/step decision (new top-level job vs. step inside existing job)
  depends on the workflow's structure at the time of branching off
  `docs/plans-from-tdd-031`. Read the workflow first; pick the option
  that minimizes runner spin-up overhead. A step inside a `lint` or
  `docs-validation` job is preferred when one exists.
- The stable name `spec-reconciliation` is for branch-protection
  durability. Do NOT rename it later; downstream branch-protection
  configuration depends on the literal string.
- Per OQ-31-02: this CI step is INTENTIONALLY separate from TDD-029's
  harness-migration gate. Do not consolidate them.
- The throwaway PR is a one-shot; do NOT merge it. The PR's purpose is
  to produce two run URLs proving the gate fires in CI as well as
  locally (TDD §9.2).
- If the repository has branch-protection rules that prevent deletion
  (e.g., default-branch protection), the throwaway branch MUST be a
  feature branch (not `main`/`master`) so `--delete` succeeds.
- Per FR-7, the new step is additive. Do NOT refactor pre-existing jobs
  in this spec; that is out of scope and would couple the doc-only PR
  to unrelated workflow refactors.
- The throwaway-branch test is the highest-signal proof that the gate
  works end-to-end. Local self-tests (SPEC-031-4-01) prove the script
  works; the throwaway PR proves CI invokes the script correctly.

## Out of Scope

- Authoring the verification script (handled by SPEC-031-4-01).
- The five local self-tests (handled by SPEC-031-4-01).
- The PR description's per-SPEC summary (handled by SPEC-031-4-03).
- Updating the matrix preamble's enforcement-mechanism note and CI guard
  self-test subsection (handled by SPEC-031-4-03).
- Modifying or refactoring pre-existing CI jobs.
- Coupling with TDD-029's harness-migration CI gate (OQ-31-02 explicitly
  rejected).
- Caching/parallelizing the verification script's path-existence check
  (TDD §6.6: not justified at current corpus size).
- Adding branch-protection configuration to require the new step (out
  of band; repo-admin task).
