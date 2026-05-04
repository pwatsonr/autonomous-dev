# SPEC-031-1-01: Path-Drift Audit + Reconciliation Matrix Scaffold

## Metadata
- **Parent Plan**: PLAN-031-1 (path-drift sweep)
- **Parent TDD**: TDD-031-spec-reconciliation-path-vitest-bats
- **Parent PRD**: PRD-016-test-suite-stabilization (G-07, FR-1650)
- **Tasks Covered**: PLAN-031-1 task 1 (audit pass), task 2 (matrix scaffold)
- **SPECs amended by this spec**: 0 (this spec creates the bookkeeping artifact only)
- **Estimated effort**: 30 minutes (~10 min audit + ~20 min scaffold)
- **Status**: Draft

## Summary
Freeze the scope of the path-drift sweep by enumerating every SPEC under
`plugins/autonomous-dev/docs/specs/` that contains the literal substring
`src/portal/`, and create the shared reconciliation matrix file that PLAN-031-1
through PLAN-031-3 will append rows to. This spec ships zero SPEC amendments;
it produces the audit list and the empty matrix that subsequent specs consume.

## Functional Requirements

- **FR-1**: An audit run MUST enumerate every SPEC file matching
  `src/portal/` (literal substring; case-sensitive). The frozen list MUST be
  recorded with file count and sorted file paths. Task: PLAN-031-1 task 1.
- **FR-2**: A new file `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md`
  MUST exist after this spec lands, containing:
  - A title and preamble linking back to PRD-016 and TDD-031.
  - Three pre-stubbed class sections: `## Path drift (PLAN-031-1)`,
    `## Vitest (PLAN-031-2)`, `## Bats (PLAN-031-3)`.
  - Each section MUST contain an empty markdown table with header row
    `| SPEC | Class | Action | Approver | Notes |` and the standard
    separator row.
  Task: PLAN-031-1 task 2.
- **FR-3**: The matrix preamble MUST record the audit count from FR-1
  alongside TDD §3.1's expected ~17. If the actual count drifts from 17 by
  more than ±3, the preamble MUST include an explicit note flagging the
  divergence.

## Non-Functional Requirements

| Requirement | Target | Measurement Method |
|-------------|--------|---------------------|
| Markdown lints clean | 0 errors from `markdownlint plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md` | Run `markdownlint` (or equivalent project lint) before commit |
| File created in correct location | Exact path `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md` | `test -f <path>` returns 0 |
| Audit reproducibility | Identical file list on two consecutive `grep` runs | Re-run command, diff the outputs; must be empty |

## Patterns to Find/Replace

This spec performs **no substitutions**. Its grep is read-only:

```bash
grep -rln "src/portal/" plugins/autonomous-dev/docs/specs/ | sort
```

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md` | Create | New triage artifact; canonical bookkeeping file for PLAN-031-1/2/3 |

The directory `plugins/autonomous-dev/docs/triage/` may not yet exist; create
it if necessary.

## Matrix Template (verbatim starting content)

```markdown
# PRD-016 SPEC Reconciliation Matrix

**Parent PRD**: [PRD-016 Test-Suite Stabilization](../prd/PRD-016-test-suite-stabilization.md)
**Parent TDD**: [TDD-031 SPEC Reconciliation](../tdd/TDD-031-spec-reconciliation-path-vitest-bats.md)
**Status**: In progress

## Preamble

This matrix records every SPEC amended by the TDD-031 reconciliation sweep,
grouped by drift class. One row per amended SPEC. Authoritative bookkeeping
for the PR; reviewers spot-check rows rather than every diff.

### Audit counts (frozen at PLAN-031-1 task 1)

| Class | Expected (TDD §3.1) | Observed | Notes |
|-------|---------------------|----------|-------|
| Path drift | ~17 | <FILL> | <NOTE if drift > ±3> |
| Vitest | ~26 | TBD (PLAN-031-2) | |
| Bats | ~15 | TBD (PLAN-031-3) | |

### Spot-checks (3 per class; populated as plans land)

- Path drift (PLAN-031-1 task 5): TBD
- Vitest (PLAN-031-2 task 6): TBD
- Bats (PLAN-031-3 task 5): TBD

### Verification log (PLAN-031-4 task 2)

TBD — populated when verification script self-tests run.

### Enforcement mechanism

TBD — populated by PLAN-031-4 with the script path, CI step name, and the
local invocation command.

---

## Path drift (PLAN-031-1)

| SPEC | Class | Action | Approver | Notes |
|------|-------|--------|----------|-------|

---

## Vitest (PLAN-031-2)

| SPEC | Class | Action | Approver | Notes |
|------|-------|--------|----------|-------|

---

## Bats (PLAN-031-3)

| SPEC | Class | Action | Approver | Notes |
|------|-------|--------|----------|-------|
```

## Verification Commands

```bash
# 1. Audit produces a non-empty file list (count typically ~17)
grep -rln "src/portal/" plugins/autonomous-dev/docs/specs/ | sort | tee /tmp/path-drift-audit.txt
wc -l /tmp/path-drift-audit.txt

# 2. Matrix file exists at the canonical path
test -f plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md

# 3. Matrix has the three pre-stubbed sections
grep -E "^## (Path drift|Vitest|Bats)" plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md | wc -l   # must be 3
```

## Acceptance Criteria

```
Given the SPEC corpus at plugins/autonomous-dev/docs/specs/
When `grep -rln "src/portal/"` runs against that directory
Then it returns a non-empty list of files
And the file count is recorded in the matrix preamble
And if the count diverges from 17 by more than 3, a divergence note is added
```

```
Given that PLAN-031-1 task 2 is being executed
When the matrix file is written to plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md
Then `test -f <path>` returns 0
And the file contains the title, preamble, and three pre-stubbed class sections
And each class section contains an empty table with the canonical header row
```

```
Given a fresh clone with no triage directory
When the spec is executed
Then the directory plugins/autonomous-dev/docs/triage/ is created
And no other directories or files are created outside that path
```

```
Given the audit run completes
When the file list is captured
Then the same `grep` command run again produces an identical, sorted file list
```

## Rollback Plan

This spec creates a single new file plus (possibly) a single new directory.
Rollback is `rm plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md`
and (if newly created) `rmdir plugins/autonomous-dev/docs/triage/`. No SPECs
under `docs/specs/` are touched, so reverting this spec leaves the SPEC corpus
in its pre-TDD-031 state.

## Implementation Notes

- The matrix file is the **single source of truth** for the reconciliation.
  Do not duplicate row data into commit messages or PR descriptions; reference
  the matrix.
- PLAN-031-2 and PLAN-031-3 append to the pre-stubbed sections without
  rewriting the file. Preserve the section anchors exactly as templated above.
- The audit count is captured at the moment of execution. If new SPECs land
  between this spec and SPEC-031-1-02, the count may shift; the divergence
  note in the preamble is the safety valve.

## Out of Scope

- Any substitution inside a SPEC under `docs/specs/` (deferred to SPEC-031-1-02).
- Auditing the `src/portal` (no trailing slash) form (TDD OQ-31-01; deferred).
- Auditing vitest or bats tokens (PLAN-031-2 / PLAN-031-3).
