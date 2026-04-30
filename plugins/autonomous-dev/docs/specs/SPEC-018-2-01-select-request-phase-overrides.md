# SPEC-018-2-01: select_request() Reads phase_overrides + Enhanced-Phase Recognition

## Metadata
- **Parent Plan**: PLAN-018-2
- **Tasks Covered**: Task 1 (`select_request()` reads `phase_overrides[]`), Task 2 (enhanced-phase recognition with strict-mode wiring)
- **Estimated effort**: 5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-018-2-01-select-request-phase-overrides.md`

## Description
Replace the hardcoded 14-phase progression in the daemon's `select_request()` with a v1.1-aware lookup that reads the `phase_overrides[]` array from `state.json` and advances to the next non-skipped phase. Add a defensive fallback path for v1.0 (or partially-migrated) state files that preserves the legacy sequence and emits a single warning per request so operators notice unmigrated files. Add a `is_enhanced_phase()` helper that consults `type_config.enhancedPhases` and wire its result into the score evaluator's existing strict-mode flag, so review gates for `infra` and `hotfix` types apply tighter thresholds without changing the evaluator itself.

This spec is purely about phase-progression read paths and the strict-mode flag plumbing. Timeout and retry overrides are SPEC-018-2-02; gate enforcement and session spawning are SPEC-018-2-03; tests live in SPEC-018-2-04.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/bin/supervisor-loop.sh` | Modify | Replace hardcoded phase array in `select_request()`; add `is_enhanced_phase()` helper |
| `plugins/autonomous-dev/bin/score-evaluator.sh` | Modify | Accept `--strict-mode` from caller; no rubric change in this spec, only flag plumbing |
| `plugins/autonomous-dev/bin/lib/phase-legacy.sh` | Create | Single source of truth for the legacy 14-phase sequence used by the fallback |

## Implementation Details

### `select_request()` Phase-Lookup Contract

The function receives a request id (state directory path) and returns the next phase to advance to (or empty string if the current phase is terminal). New control flow:

1. `current_phase=$(jq -r '.current_phase' "$state_file")`
2. `phase_overrides=$(jq -c '.phase_overrides // empty' "$state_file")`
3. If `phase_overrides` is non-empty, find the index of `current_phase` in the array via `jq -r --arg p "$current_phase" '.phase_overrides | index($p)'`. Return the element at `index + 1`, or empty string if `index + 1 >= length`.
4. If `phase_overrides` is empty/absent, source `lib/phase-legacy.sh` to obtain `LEGACY_PHASES`, emit the warning (see deduplication below), and apply the same index-and-next logic against `LEGACY_PHASES`.

The function MUST NOT mutate state. Phase transitions are written by the existing lifecycle engine after this function returns. If `current_phase` is not found in either array, the function emits `ERROR select_request: phase '$current_phase' not in sequence for $state_file` to stderr and returns non-zero — this surfaces a corrupted state file rather than silently masking it.

### Warning Deduplication

Repeated warning lines for the same unmigrated state would flood operator logs. The supervisor process maintains a single bash associative array, declared once at script load:

```bash
declare -gA _phase_legacy_warned=()

warn_legacy_fallback_once() {
  local state_file="$1"
  if [[ -z "${_phase_legacy_warned[$state_file]:-}" ]]; then
    printf 'WARN select_request: state %s lacks phase_overrides, using legacy sequence\n' \
      "$state_file" >&2
    _phase_legacy_warned[$state_file]=1
  fi
}
```

The array's lifetime equals the supervisor process lifetime (daily restart per TDD-001). After restart, the warning re-fires once per still-unmigrated request — this is intentional surfacing of the migration debt.

### `lib/phase-legacy.sh`

```bash
#!/usr/bin/env bash
# Source of truth for the v1.0 legacy phase sequence.
# DO NOT extend this list — new pipeline variants live in phase_overrides[].
LEGACY_PHASES=(
  intake
  prd prd_review
  tdd tdd_review
  plan plan_review
  spec spec_review
  code code_review
  test test_review
  validate
)
export LEGACY_PHASES
```

### `is_enhanced_phase()` Helper

```bash
# Returns 0 (true) if the given phase is in type_config.enhancedPhases for this state.
is_enhanced_phase() {
  local state_file="$1" phase="$2"
  local enhanced
  enhanced=$(jq -r --arg p "$phase" \
    '(.type_config.enhancedPhases // []) | index($p) // empty' \
    "$state_file")
  [[ -n "$enhanced" ]]
}
```

### Strict-Mode Wiring in `score-evaluator.sh`

The supervisor invokes the score evaluator at every `*_review` phase. Update the invocation site (in `supervisor-loop.sh`) so it appends `--strict-mode` when `is_enhanced_phase` returns 0:

```bash
score_args=()
if is_enhanced_phase "$state_file" "$current_phase"; then
  score_args+=(--strict-mode)
fi
"$PLUGIN_DIR/bin/score-evaluator.sh" "${score_args[@]}" "$state_file"
```

`score-evaluator.sh` must accept and tolerate the flag (parse via `getopts` or simple positional check); its threshold logic remains unchanged in this spec — wiring only.

## Acceptance Criteria

- [ ] `select_request()` returns `tdd` when called with a state whose `phase_overrides` is `["intake","tdd","tdd_review","plan","plan_review","code","code_review","test","test_review","validate"]` and `current_phase` is `intake` (i.e., PRD is skipped).
- [ ] `select_request()` returns `prd` when called with a state where `phase_overrides` is absent and `current_phase` is `intake` (legacy fallback).
- [ ] When the legacy fallback fires, exactly one log line matching `WARN select_request: state .* lacks phase_overrides` is emitted per request id within a single supervisor process lifetime.
- [ ] `select_request()` returns empty string when `current_phase` equals the last element of `phase_overrides[]`.
- [ ] `is_enhanced_phase` returns 0 when `type_config.enhancedPhases` includes the given phase, returns 1 otherwise (including when the array is absent).
- [ ] When `is_enhanced_phase` returns 0 for the current phase, the score-evaluator command line in supervisor logs contains `--strict-mode`; when it returns 1, the flag is absent.
- [ ] `score-evaluator.sh` exits 0 when invoked with `--strict-mode` and a valid state file (flag is accepted even though scoring rubric is unchanged in this spec).
- [ ] `lib/phase-legacy.sh` defines `LEGACY_PHASES` as a 14-element bash array in the order shown above and does nothing else (no side effects on source).
- [ ] `shellcheck` passes on `supervisor-loop.sh`, `score-evaluator.sh`, and `lib/phase-legacy.sh` with the project's existing rule set.
- [ ] `select_request()` is pure: invoking it twice on the same state file produces identical output and does not modify the file (verified via `stat` mtime check).

## Dependencies

- **Blocked by PLAN-018-1**: requires v1.1 state files containing `phase_overrides[]` and `type_config.enhancedPhases`. Without that schema, only the legacy fallback exercises.
- TDD-001 / PLAN-001-2 supplies the existing `select_request()` implementation and supervisor loop engine that will be modified.
- TDD-002 / PLAN-002-3 supplies the lifecycle engine that consumes the return value of `select_request()`; that engine is untouched here.
- No new external library or runtime introduced.

## Notes

- The `_phase_legacy_warned` associative array is process-local; the supervisor restarts daily (per TDD-001), so warnings will reappear once per restart per unmigrated request — acceptable signal.
- `is_enhanced_phase` is declared in `supervisor-loop.sh` rather than `lib/phase-legacy.sh` because it depends on per-state `type_config`, not the legacy sequence.
- Strict-mode rubric changes (lower acceptance threshold, additional checks) are deferred to PRD-004 reviewer-config; this spec only ensures the flag arrives at the evaluator.
- The fallback path is defensive — the migration script in PLAN-018-1 is responsible for ensuring all production state files have `phase_overrides`. Operators should monitor for the warning log line and run the migration if it appears.
- Do not extend `LEGACY_PHASES`. New pipeline variants use `phase_overrides[]` exclusively; the legacy array exists only to keep v1.0 states limping along during upgrade windows.
