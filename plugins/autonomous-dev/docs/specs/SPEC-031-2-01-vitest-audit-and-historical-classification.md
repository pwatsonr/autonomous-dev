# SPEC-031-2-01: Vitest Audit + Historical-Context Classification

## Metadata
- **Parent Plan**: PLAN-031-2 (vitest → jest sweep)
- **Parent TDD**: TDD-031-spec-reconciliation-path-vitest-bats (§5.2)
- **Parent PRD**: PRD-016-test-suite-stabilization (G-08, FR-1651)
- **Tasks Covered**: PLAN-031-2 task 1 (audit), task 2 (historical-context flag)
- **SPECs amended by this spec**: 0 (audit + classification only; no edits)
- **Estimated effort**: 40 minutes (~10 min audit + ~30 min context walk)
- **Status**: Draft
- **Depends on**: SPEC-031-1-01 (matrix scaffold; pre-stubbed Vitest section)

## Summary
Freeze the scope of the Vitest → Jest sweep by enumerating every SPEC under
`plugins/autonomous-dev/docs/specs/` containing the `vitest` token
(case-insensitive), then walk each match and identify SPECs where the
mention is a deliberate "alternative considered" passage that must NOT be
mechanically substituted. Output is a frozen audit list and a hand-flagged
carve-out list, both pasted into the matrix preamble.

## Functional Requirements

- **FR-1**: An audit run MUST enumerate every SPEC matching `vitest`
  (case-insensitive). The frozen list MUST be sorted and recorded with
  count. Task: PLAN-031-2 task 1.
- **FR-2**: For each matched SPEC, surrounding context (`-B2 -A2`) MUST be
  inspected to identify SPECs where `Vitest`/`vitest` is a historical
  comparison/alternative-considered passage rather than current-state drift.
  Task: PLAN-031-2 task 2.
- **FR-3**: A carve-out list of historical-context SPECs MUST be recorded
  in the matrix preamble (under the Vitest section) with a one-line
  rationale per SPEC. These SPECs are EXCLUDED from the mechanical
  substitution in SPEC-031-2-02 and instead receive hand-amendment in
  SPEC-031-2-04.
- **FR-4**: The matrix preamble's "Audit counts" row for Vitest MUST be
  filled with the observed count (vs TDD §3.1's expected ~26). Drift > ±5
  triggers a divergence note.

## Non-Functional Requirements

| Requirement | Target | Measurement Method |
|-------------|--------|---------------------|
| Audit reproducibility | Two consecutive runs produce identical sorted file lists | Re-run grep, diff outputs |
| Carve-out completeness | Every "alternative considered" / "rejected" passage citing Vitest is flagged | Spot-check: re-grep for `considered\|rejected\|alternative` near `vitest` |
| No file edits | `git diff` is empty after this spec | `git diff --stat` produces no output |

## Patterns to Find/Replace

This spec performs **no substitutions**. Its grep is read-only:

```bash
# Audit (FR-1)
grep -rlni "vitest" plugins/autonomous-dev/docs/specs/ | sort

# Context inspection (FR-2)
for f in $(grep -rlni "vitest" plugins/autonomous-dev/docs/specs/); do
  echo "=== $f ==="
  grep -n -B2 -A2 -i "vitest" "$f"
done
```

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md` | Modify | Update preamble: fill Vitest "Audit counts" row + record carve-out list |

No SPEC files under `docs/specs/` are modified.

## Verification Commands

```bash
# 1. Audit run produces a non-empty sorted list
grep -rlni "vitest" plugins/autonomous-dev/docs/specs/ | sort | tee /tmp/vitest-audit.txt
wc -l /tmp/vitest-audit.txt   # typically ~26

# 2. Matrix preamble has the Vitest Audit counts row populated
grep -A 5 "Audit counts" plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md \
  | grep "Vitest" | grep -v "TBD"   # must produce a line

# 3. Carve-out subsection exists in the Vitest section preamble
grep -A 20 "## Vitest (PLAN-031-2)" plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md \
  | grep -i "carve-out\|historical-context\|whitelist"   # at least one match

# 4. No SPEC files modified
git diff --name-only plugins/autonomous-dev/docs/specs/ | wc -l   # must be 0
```

## Acceptance Criteria

```
Given the SPEC corpus at plugins/autonomous-dev/docs/specs/
When `grep -rlni "vitest"` runs
Then it returns a sorted list of files (typically ~26)
And the count is recorded in the matrix preamble's Audit counts row for Vitest
And if the count diverges from 26 by more than 5, a divergence note is added
```

```
Given a SPEC matched by the audit
When the surrounding context (`-B2 -A2`) is inspected
Then any mention forming a deliberate "alternative considered" or "rejected"
  passage about Vitest vs Jest is flagged for carve-out
And other mentions (current-state drift) are left for SPEC-031-2-02's mechanical sweep
```

```
Given the carve-out classification completes
When the matrix preamble is updated
Then the carve-out subsection lists every flagged SPEC by ID
And each entry includes a one-line rationale
And the carve-out list explicitly states "these SPECs are EXCLUDED from the SPEC-031-2-02 mechanical substitution"
```

```
Given this spec finishes execution
When `git diff --name-only plugins/autonomous-dev/docs/specs/` runs
Then the output is empty (no SPEC body changes in this spec)
And the only modified file is the matrix file
```

## Rollback Plan

```bash
# Revert matrix preamble changes only
git checkout -- plugins/autonomous-dev/docs/triage/PRD-016-spec-reconciliation.md
```

This spec touches no SPECs under `docs/specs/`, so revert leaves the SPEC
corpus unchanged.

## Implementation Notes

- The audit grep is case-insensitive (`-i`). Both `Vitest` and `vitest` are
  in scope.
- "Historical context" examples to flag:
  - "We considered Vitest but chose Jest because…"
  - "Vitest was rejected as the test runner due to…"
  - "Earlier prototype used Vitest; production uses Jest."
- These passages get hand-amendment in SPEC-031-2-04 (not this spec, not
  SPEC-031-2-02). Typical hand-amendment is wrapping in
  `**Historical note:** …` or appending a clarifying sentence; the bare
  token is preserved because the historical record is intentional.
- Empirically the carve-out list is expected to be 0–2 SPECs. If more than
  ~5 surface, pause and re-read TDD §5.2 — the bar for "historical context"
  is high (deliberate, sentence-scale comparison; not just a passing
  mention).

## Out of Scope

- The mechanical sed substitution (SPEC-031-2-02).
- The `\bvi\.` API review (SPEC-031-2-03).
- Matrix row population per amended SPEC (SPEC-031-2-04).
- Path-drift or bats reconciliation.
- Production code or `package.json` changes (NG-3106).
- Modifying any `.test.ts` / `.spec.ts` file.
