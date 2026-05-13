# SPEC-039-3-02: `waitedMin` computation

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-019
- **Dependencies**: SPEC-039-3-01
- **Estimated effort**: 1 hour
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

Compute the `waitedMin` field (minutes a request has been at a gate awaiting operator action) at portal-write time from `state.json.current_phase_metadata.gate_entered_at`. Computing at write time (not in-memory) ensures correctness across daemon restarts because `gate_entered_at` is persisted.

## Acceptance Criteria

1. `waitedMin` populated correctly for `status='gate'` rows, computed as `(now - gate_entered_at) / 60` rounded down to integer minutes.
2. For non-gate rows, `waitedMin = 0`.
3. After daemon restart, `waitedMin` recomputes correctly (no in-memory dependency).
4. `gate_entered_at` is set by `advance_phase()` whenever a transition results in `status='gate'`.

## Implementation

**Files modified**
- `plugins/autonomous-dev/bin/supervisor-loop.sh` — extend `advance_phase()` and `write_portal_request_action()`.

**`advance_phase` extension** — on transition to status `gate`, also set `current_phase_metadata.gate_entered_at` to current ISO timestamp via the atomic state update.

**`write_portal_request_action` extension** — compute `waitedMin` inline before the rename:
```bash
local gate_entered
gate_entered=$(jq -r '.current_phase_metadata.gate_entered_at // ""' "$state_file")
local waited_min=0
if [[ -n "$gate_entered" ]]; then
  local now_epoch entered_epoch
  now_epoch=$(date +%s)
  entered_epoch=$(date -d "$gate_entered" +%s 2>/dev/null || gdate -d "$gate_entered" +%s)
  waited_min=$(( (now_epoch - entered_epoch) / 60 ))
fi
# include $waited_min in the jq projection above (SPEC-039-3-01)
```

**Portability note** — macOS `date -d` is incompatible; the function uses `gdate` fallback when available. Spec the daemon's runtime requirement: GNU date OR coreutils on macOS.

## Tests

**Files created**
- `plugins/autonomous-dev/tests/bats/portal_waited_min.bats`

**Test cases**
1. `gate_status_computes_minutes` — seed state with `gate_entered_at` 5 minutes ago; assert portal file shows `waitedMin: 5`.
2. `non_gate_zero` — `status=running` row → `waitedMin: 0`.
3. `survives_daemon_restart` — set gate_entered_at, restart daemon (re-run --once), re-compute is still correct.
4. `missing_gate_entered_at` — no metadata field → `waitedMin: 0` (no NaN, no error).
5. `advance_to_gate_sets_gate_entered_at` — drive transition into a `gate` status; assert metadata field is populated with ISO timestamp.

## Verification

- `bash -n bin/supervisor-loop.sh`
- `bats tests/bats/portal_waited_min.bats`
- Manual: hold a request at gate, observe portal showing increasing `waitedMin` across daemon restarts.

## Open Questions resolved

- OQ-019-06 (from TDD review) — resolved: computation at write-time using persisted `gate_entered_at`.
