# SPEC-031-3-01: Bats-Reference Audit + Per-SPEC Case (a)/(b) Decision

## Metadata
- **Parent Plan**: PLAN-031-3 (bats → jest reconciliation)
- **Parent TDD**: TDD-031-spec-reconciliation-path-vitest-bats (§5.3, §6.5)
- **Parent PRD**: PRD-016-test-suite-stabilization (G-08, FR-1652)
- **Tasks Covered**: PLAN-031-3 task 1 (audit), task 2 (per-SPEC case decision)
- **SPECs amended by this spec**: 0 (this spec only freezes scope and produces a decision list)
- **Estimated effort**: 70 minutes (~10 min audit + ~60 min per-SPEC decision)
- **Status**: Draft
- **Depends on**: SPEC-031-1-01 (matrix scaffold; pre-stubbed `## Bats (PLAN-031-3)` section)

## Summary
Freeze the scope of the bats reconciliation by enumerating every SPEC under
`plugins/autonomous-dev/docs/specs/` that cites a `.bats` file or a
`tests/unit/test_*.sh` Bats path, then produce a per-SPEC case (a)/(b)
decision list — case (a) = a Jest equivalent exists; case (b) = no
replacement, retired. The decision list drives the manual amendment work
in SPEC-031-3-02; this spec ships the audit and the classifications only.

## Functional Requirements

- **FR-1**: An audit run MUST execute
  `grep -rlnE "\.bats|tests/unit/test_.*\.sh" plugins/autonomous-dev/docs/specs/ | sort`
  and capture the resulting file list. Count is documented in the matrix
  preamble's Bats-section "Audit counts" row. Task: PLAN-031-3 task 1.
- **FR-2**: If the audit count diverges from TDD §3.1's expected ~15 by more
  than ±3, the divergence MUST be recorded in the matrix preamble before
  proceeding. The plan does not bake 15 in as a hard number.
- **FR-3**: For each SPEC in the audit list, a per-SPEC decision MUST be
  recorded with the following fields:
  | Field | Description |
  |-------|-------------|
  | SPEC ID | e.g., `SPEC-002-1-05` |
  | Bats path | The exact string cited in the SPEC (e.g., `tests/unit/test_daemon_lifecycle.sh`) |
  | Case | One of: `(a)` or `(b)` |
  | Jest path | Required if case (a); blank if case (b) |
  | Notes | Free-text reason; required if case (b) or partial (a) |
- **FR-4**: Case (a) classification MUST be gated on `test -e <jest-path>`.
  A Jest path that does not resolve cannot be used to justify case (a); the
  decision falls back to case (b) with a Notes annotation. Task: PLAN-031-3
  task 2 step 4.
- **FR-5**: Jest-equivalent search MUST run
  `find plugins/autonomous-dev -name "*.test.ts"` and filter by name root
  (e.g., `daemon-lifecycle`, `daemon_lifecycle`). The search method MUST be
  documented per row so the reviewer can audit the classification.
- **FR-6**: A SPEC whose Bats reference appears inside a deliberate
  "rejected alternative considered" passage MUST be flagged as a historical
  carve-out, analogous to PLAN-031-2 task 2. These are NOT classified
  case (a) or case (b); they get a `Historical` action in the matrix and
  are hand-amended with a clarifying prefix in SPEC-031-3-02.
- **FR-7**: The decision list MUST be persisted in the matrix preamble's
  Bats-section "Decision log" subsection (committed in SPEC-031-3-03), with
  one row per audited SPEC. The list is the authoritative input to
  SPEC-031-3-02.

## Non-Functional Requirements

| Requirement | Target | Measurement Method |
|-------------|--------|---------------------|
| Audit completeness | Every SPEC matching the regex is in the list | `grep -c` against the regex equals the row count |
| Case-(a) gate | 100% of case-(a) Jest paths resolve | `while read; do test -e $jp; done` returns 0 for every row |
| Decision-list determinism | Same audit produces same list ordering | Re-run the audit; output `diff` shows no change |
| Per-row search transparency | Each row records the search method used | Notes column non-empty for every row |

## Patterns to Find/Replace

This spec performs **no SPEC content substitutions**. It produces a decision
list that drives subsequent amendment work.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| (working scratch) | Create | Decision list captured for hand-off to SPEC-031-3-02; persisted to matrix preamble in SPEC-031-3-03 |

This spec produces no committed artifact on its own; the audit count and
decision list are integrated into the matrix file by SPEC-031-3-03.

## Verification Commands

```bash
# 1. Audit pass
grep -rlnE "\.bats|tests/unit/test_.*\.sh" \
  plugins/autonomous-dev/docs/specs/ | sort > /tmp/bats-audit.txt
wc -l /tmp/bats-audit.txt

# 2. Per-SPEC: extract Bats path(s) cited
while IFS= read -r spec; do
  echo "=== $spec ==="
  grep -nE "\.bats|tests/unit/test_.*\.sh" "$spec"
done < /tmp/bats-audit.txt

# 3. Per-SPEC: candidate Jest equivalent search
# Example for tests/unit/test_daemon_lifecycle.sh:
find plugins/autonomous-dev -name "*.test.ts" | grep -i "daemon.*lifecycle"

# 4. Case-(a) gate: each cited Jest path must exist
# (Run after the decision list is drafted; use it to validate.)
while IFS='|' read -r spec batspath case jestpath notes; do
  [[ "$case" = "(a)" ]] && test -e "$jestpath" || \
    echo "FAIL: case-(a) jest path missing: $spec → $jestpath"
done < /tmp/decision-list.psv
```

## Acceptance Criteria

```
Given the audit regex `\.bats|tests/unit/test_.*\.sh` is run over docs/specs/
When the matching file list is captured
Then every SPEC containing a Bats reference appears in the list
And the count is recorded with the audit drift indicator (within/outside ±3 of 15)
And the list is sorted alphabetically by SPEC path
```

```
Given a SPEC in the audit list cites `tests/unit/test_<name>.sh`
When the Jest-equivalent search runs `find ... -name "*.test.ts" | grep <name>`
And a candidate Jest file is found
And `test -e <candidate>` returns 0
And the SPEC's intent (per a brief read of the surrounding prose) matches the candidate
Then the SPEC is classified case (a) with the Jest path recorded
```

```
Given a SPEC in the audit list cites a Bats path
When no Jest candidate is found OR the candidate's coverage diverges from the SPEC's intent
Then the SPEC is classified case (b)
And the Notes column records what was searched and why no clean match exists
```

```
Given a SPEC's Bats reference appears inside a "rejected alternatives" passage
When the surrounding prose is read in context
Then the SPEC is flagged `Historical` (not case (a) or case (b))
And SPEC-031-3-02 hand-amends with a clarifying "Historical:" prefix instead of replacing
```

```
Given a candidate Jest path was identified for case (a)
When `test -e <jest-path>` returns 1 (file does not exist)
Then the classification falls back to case (b)
And the Notes column documents the failed candidate and the search performed
```

```
Given the audit count diverges from TDD §3.1's 15 by more than ±3
When the divergence is observed
Then the matrix preamble records the actual N and the divergence note
And SPEC-031-3-01 still proceeds (count drift is documented, not a hard stop)
```

## Rollback Plan

This spec produces no committed artifact. If the decision list is wrong,
discard `/tmp/decision-list.psv` and re-run the audit. SPEC-031-3-02 has
not yet started, so there is nothing in the working tree to revert.

If the decision list has already been integrated into the matrix preamble
(by SPEC-031-3-03), revert the matrix preamble's "Decision log" subsection
only:
```bash
git checkout -- plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md
```

## Implementation Notes

- The Bats file paths in SPECs may have minor lexical variations
  (`test_daemon_lifecycle.sh` vs `test-daemon-lifecycle.sh`). Search using
  both `_` and `-` separators when looking for the Jest equivalent.
- A "name match" alone is insufficient evidence for case (a). Read the SPEC's
  description of what the test covers, then read the Jest file's `describe`
  blocks. If the coverage is materially different, classify case (b) with a
  Notes annotation rather than overstating the equivalence.
- The decision list ordering matters: SPEC-031-3-02 walks the list top-to-
  bottom. Sort it alphabetically by SPEC ID for stable diffs.
- A pipe-separated values file (PSV) is the intended scratch format because
  Bats paths and Jest paths often contain `/` characters that break CSV.
- Per TDD OQ-31-04: do NOT backfill missing Jest tests in this work. Case (b)
  is a legitimate classification; SPEC backfill is a separate effort.

## Out of Scope

- Applying SPEC amendments (handled by SPEC-031-3-02).
- Authoring matrix rows (handled by SPEC-031-3-03).
- Path-drift or vitest amendments (PLAN-031-1 / PLAN-031-2).
- The verification script and CI guard (PLAN-031-4).
- Re-creating retired Bats files as Jest equivalents (NG-3105 / PRD-016 NG-03).
- Authoring new Jest tests to cover the retired Bats surface.
- Re-deriving SPEC content (NG-3101).
- Production code changes (NG-3103).
