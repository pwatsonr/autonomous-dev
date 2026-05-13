# SPEC-039-2-02: `resolve_agent()` phase-to-agent map

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-008, TASK-016
- **Dependencies**: none
- **Estimated effort**: 3 hours
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

Introduce `resolve_agent()` in `supervisor-loop.sh` — a pure shell function mapping a phase name to its owning agent's name, per TDD §6.2's hardcoded 12-entry table. Unknown phases return empty + daemon skips the request, logs WARN. Bats coverage for every mapping.

## Acceptance Criteria

1. (AC-038-10) All 12 phase-to-agent mappings exact per TDD §6.2.
2. Unknown phase returns empty string AND function exit code is non-zero (caller can branch on `[[ -z "$agent" ]]`).
3. Function is pure (no global mutations).
4. Bats: every mapping verified; unknown-phase fallback verified.

## Implementation

**Files modified**
- `plugins/autonomous-dev/bin/supervisor-loop.sh` — add `resolve_agent()` function.

**Mapping (per TDD §6.2)**
| Phase | Agent |
|-------|-------|
| `intake` | (no agent — bookkeeping only, see SPEC-039-2-06) |
| `prd` | `prd-author` |
| `prd_review` | `prd-reviewer` |
| `tdd` | `tdd-author` |
| `tdd_review` | `tdd-reviewer` |
| `plan` | `plan-author` |
| `plan_review` | `quality-reviewer` |
| `spec` | `spec-author` |
| `spec_review` | `quality-reviewer` |
| `code` | `code-executor` |
| `code_review` | `quality-reviewer` |
| `security_review` | `security-reviewer` |
| `deploy` | `deploy-executor` |

(Phase names are the canonical set used in state.json `current_phase`.)

**Function contract**
```bash
# resolve_agent <phase> -> echo agent_name (or empty); exit 0 if found, 1 if not
resolve_agent() {
  case "$1" in
    prd) echo "prd-author";;
    prd_review) echo "prd-reviewer";;
    tdd) echo "tdd-author";;
    # ... full table
    intake) echo ""; return 1 ;;
    *) echo ""; return 1 ;;
  esac
}
```

## Tests

**Files created**
- `plugins/autonomous-dev/tests/bats/resolve_agent.bats`

**Test cases**
1. `prd_maps_to_prd_author` — and 11 more, one per mapping (AC-038-10).
2. `unknown_phase_returns_empty` — `resolve_agent "nonsense"` exits non-zero, stdout empty.
3. `empty_input_handled` — `resolve_agent ""` exits non-zero.
4. `intake_phase_returns_empty` — explicit assertion that intake has no agent.

## Verification

- `bash -n bin/supervisor-loop.sh`
- `bats tests/bats/resolve_agent.bats`

## Amendment (PRD-020)

The shipped `resolve_agent` covers the canonical 14 phases: `intake`→none; `prd`→`prd-author`; `*_review` doc phases→`doc-reviewer`; `code`→`code-executor`; `code_review`→`quality-reviewer`; `integration`→`test-executor`; `deploy`→`deploy-executor`; `monitor`→`performance-analyst`. This is reconciled with `ALL_PIPELINE_PHASES` (`intake/types/phase-override.ts`) and `LEGACY_PHASES`. There is no `security_review` *phase* (it's a gate, not a phase).
