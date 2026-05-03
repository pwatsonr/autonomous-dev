# PLAN-031-1: Path-Drift Sweep (`src/portal/` → `plugins/autonomous-dev-portal/server/`)

## Metadata
- **Parent TDD**: TDD-031-spec-reconciliation-path-vitest-bats
- **Parent PRD**: PRD-016-test-suite-stabilization (G-07, FR-1650)
- **Estimated effort**: 0.5 day (~30 min sweep + 1.5h matrix authoring + review)
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P1

## Objective
Reconcile path drift in approximately 17 SPEC files where the SPEC body cites
`src/portal/...` paths that were relocated to
`plugins/autonomous-dev-portal/server/...` during the portal extraction. After this
plan lands, every `src/portal/` substring is gone from
`plugins/autonomous-dev/docs/specs/**/*.md`, and every cited path under
`plugins/autonomous-dev-portal/server/...` resolves to a real file in the tree.

This is the first of four sequential commits inside the single TDD-031 doc-only PR
(per TDD §8.1). It is mechanical and deterministic: a tree-aware sed substitution
plus a per-SPEC matrix row recording the amendment.

## Scope

### In Scope
- A pre-sweep audit producing a frozen list of affected SPEC files (the output of
  `grep -rln "src/portal/" plugins/autonomous-dev/docs/specs/`), saved into the
  reconciliation matrix as the authoritative N for this class.
- The mechanical substitution `s|src/portal/|plugins/autonomous-dev-portal/server/|g`
  applied across `plugins/autonomous-dev/docs/specs/**/*.md` per TDD §5.1.
- A new file `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md`
  with one row per amended SPEC (class=Path, action, approver) — created by this
  plan and appended to by PLAN-031-2 and PLAN-031-3.
- A post-sweep verification step: `grep -rln "src/portal/" plugins/autonomous-dev/docs/specs/`
  must return zero results.
- A spot-check of three randomly-chosen amended SPECs confirming the substituted
  path resolves to an extant file under
  `plugins/autonomous-dev-portal/server/...`.

### Out of Scope
- The case-insensitive prose form `src/portal` without trailing slash (TDD OQ-31-01,
  OQ-31-06) — captured as a follow-up note in the matrix; deferred to a future pass
  if the verification script in PLAN-031-4 reports residual occurrences.
- Vitest-token amendments — PLAN-031-2.
- Bats-reference reconciliation — PLAN-031-3.
- The verification script and CI guard — PLAN-031-4.
- Any production code changes (NG-3103). If a substituted path does not resolve
  because a file was renamed (not just relocated), the row is flagged Open Question
  per TDD OQ-31-03; the SPEC is not invented or deleted in this plan.
- Re-deriving SPEC content (NG-3101 / PRD-016 NG-05).

## Tasks

1. **Audit pass: enumerate affected SPECs** — Run
   `grep -rln "src/portal/" plugins/autonomous-dev/docs/specs/ | sort` and capture
   the file list. Confirm count matches TDD §3.1's expected ~17 (note any drift
   from that count in the matrix preamble).
   - Files to create: none (capture in working scratch only)
   - Acceptance criteria: A frozen file list exists. Count is documented in the
     matrix preamble. If count diverges from 17 by more than ±3, pause and re-read
     the TDD §3.1 audit notes before proceeding.
   - Estimated effort: 10 min

2. **Create reconciliation matrix scaffold** — Author
   `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md` with the
   header, preamble linking back to PRD-016 and TDD-031, and an empty markdown
   table with columns `SPEC | Class | Action | Approver | Notes`. Three class
   sections (`## Path drift (PLAN-031-1)`, `## Vitest (PLAN-031-2)`,
   `## Bats (PLAN-031-3)`) are pre-stubbed so PLAN-031-2 and PLAN-031-3 append
   without restructuring.
   - Files to create: `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md`
   - Acceptance criteria: File exists. Contains preamble, three class sections,
     empty tables. Markdown lints clean (no broken pipes / column-count mismatches).
   - Estimated effort: 20 min

3. **Apply the path-drift sweep** — Run the BSD-sed-compatible substitution per
   TDD §5.1:
   ```bash
   find plugins/autonomous-dev/docs/specs -name "*.md" -exec \
     sed -i.bak 's|src/portal/|plugins/autonomous-dev-portal/server/|g' {} \;
   find plugins/autonomous-dev/docs/specs -name "*.md.bak" -delete
   ```
   Stage all amended SPECs but do not commit yet.
   - Files to modify: ~17 SPEC files under `plugins/autonomous-dev/docs/specs/`
     (exact list from task 1).
   - Acceptance criteria: `git diff --stat plugins/autonomous-dev/docs/specs/`
     shows the expected ~17 modified files. No `.md.bak` files remain in the
     working tree. `grep -rln "src/portal/" plugins/autonomous-dev/docs/specs/`
     returns empty.
   - Estimated effort: 5 min

4. **Populate matrix Path-drift section** — For each amended SPEC, add a row of
   the form:
   `| SPEC-NNN-N-NN | Path | s\|src/portal/\|plugins/autonomous-dev-portal/server/\| | @pwatson | <notes if any> |`
   The Notes column captures any SPEC where the substituted path's target does
   not exist (these become Open Questions for PLAN-031-4 to surface in the
   verification script).
   - Files to modify: `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md`
   - Acceptance criteria: One row per amended SPEC. Row count equals modified-file
     count from task 3. Rows are alphabetically sorted by SPEC ID.
   - Estimated effort: 30 min

5. **Spot-check three amended SPECs** — Pick three amended SPECs at random (e.g.,
   `awk` over the file list), open each, identify a `plugins/autonomous-dev-portal/server/...`
   path mentioned in the diff, and run `test -e <path>` to confirm it resolves.
   Log the three checks in the matrix preamble.
   - Files to modify: `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md`
     (preamble only)
   - Acceptance criteria: Three named SPECs + their checked paths + the
     `test -e` result are recorded. All three resolve. If any does not resolve,
     the row gets an Open Question note and the issue is escalated to PLAN-031-4
     for verification-script triage rather than fixed in this plan.
   - Estimated effort: 15 min

6. **Commit** — Single commit on branch
   `docs/plans-from-tdd-031` (or sub-branch per orchestrator config) with message:
   `docs(specs): PLAN-031-1 path-drift sweep — src/portal → plugins/autonomous-dev-portal/server (~17 SPECs)`.
   The commit body lists the affected-SPEC count, the verification-grep result
   (`zero remaining`), and the three spot-check results.
   - Files to modify: none beyond what tasks 3-5 already staged.
   - Acceptance criteria: Single atomic commit. Message follows the template.
     `git log -1 --stat` shows ~18 files changed (17 SPECs + 1 matrix file).
   - Estimated effort: 5 min

## Dependencies & Integration Points

**Exposes to other plans:**
- The reconciliation matrix file
  (`plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md`) is the
  canonical bookkeeping artifact. PLAN-031-2 and PLAN-031-3 append rows to their
  pre-stubbed sections without rewriting the file.
- The matrix preamble's "spot-check" log is the human evidence that this plan's
  sweep was reviewed; PLAN-031-4's verification script provides the mechanical
  evidence.

**Consumes from other plans:**
- None. This plan is the head of the TDD-031 chain.

## Testing Strategy

- **Pre-sweep audit (task 1):** Confirms scope before substitution; mismatched
  counts are caught here, not after the diff is applied.
- **Post-sweep mechanical check (task 3):**
  `grep -rln "src/portal/" plugins/autonomous-dev/docs/specs/` must return empty.
  This is the necessary-but-not-sufficient gate.
- **Spot-check (task 5):** Three random amended SPECs are read by hand; their
  substituted paths must resolve. Catches the "looks right but file actually
  renamed not relocated" failure mode (TDD OQ-31-03).
- **No new tests added.** This plan ships zero executable code; verification is
  by grep + filesystem checks. PLAN-031-4 provides the codified, automatable
  verification gate.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| The sed substitution lands inside a code block / fenced text in a way that breaks markdown rendering. | Low | Low | The substitution is a simple prefix swap; markdown renders the new path as plain text exactly as it rendered the old. Reviewers can spot-check rendered output via the PR's Files tab. |
| A substituted path looks valid but the target file was renamed (not relocated), so the cite is now wrong in a different way. | Medium | Medium | Spot-check (task 5) catches a subset; PLAN-031-4's verification script catches the rest mechanically. Per TDD OQ-31-03, mismatches become matrix Open Questions, not silent errors. |
| Affected SPEC count diverges materially from the TDD's ~17 (e.g., new SPECs landed since the audit). | Medium | Low | Task 1 freezes the count and pauses on >±3 drift; the matrix preamble records the actual N. The plan does not bake 17 in as a hard number. |
| Misclassifying a `src/portal` mention without trailing slash (TDD OQ-31-01) — the sweep does not catch it; the SPEC retains drift. | High | Low | Out-of-scope per the plan's Scope section; PLAN-031-4's verification script greps for these as a follow-up signal, and a future small PR cleans them up. Documented in the matrix preamble as a known carve-out. |
| The new triage file path conflicts with an existing artifact. | Low | Low | Path `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md` is verified non-existent in task 2; if it does exist (created by a sibling plan branch), the plan switches to append-only mode. |

## Definition of Done

- [ ] `grep -rln "src/portal/" plugins/autonomous-dev/docs/specs/` returns empty.
- [ ] `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md` exists
      with a populated `## Path drift (PLAN-031-1)` table.
- [ ] Matrix row count equals the modified-SPEC count from `git diff --stat`.
- [ ] Three spot-checked amended SPECs are recorded in the matrix preamble with
      `test -e` results.
- [ ] No `.md.bak` files remain in the working tree.
- [ ] Single commit on the TDD-031 branch with the prescribed message.
- [ ] No production code (anything outside `plugins/autonomous-dev/docs/`) is
      modified by this plan.
- [ ] Any unresolvable substituted paths are recorded as Open Questions in the
      matrix and surfaced in the PR description for PLAN-031-4 follow-up.
