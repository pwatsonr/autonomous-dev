# SPEC-039-2-03: `dispatch_phase_session()` + error handling

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-009, TASK-026
- **Dependencies**: SPEC-039-2-01, SPEC-039-2-02
- **Estimated effort**: 4.5 hours
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

Implement `dispatch_phase_session()` — the daemon's single entry point for invoking an agent for a phase. Per TDD §6.2 MAJOR-1, this MUST delegate to the existing `spawn_session_typed()` in `bin/spawn-session.sh` (no parallel `claude --print` invocations). Includes a 30-minute wall-clock timeout (OQ-039-3), pre-flight request_id validation, and robust error handling (TASK-026) so the daemon never crashes on a dispatch failure.

## Acceptance Criteria

1. (AC-038-11) `dispatch_phase_session()` calls `spawn_session_typed()`, never `claude` directly.
2. Reads `current_phase` from state.json (NOT the legacy `.status` field) for agent selection.
3. Wraps the `claude` invocation in `timeout 30m` (resolves OQ-039-3).
4. Pre-validates `request_id` against `^REQ-[0-9]{6}$`; rejects with hard error before any side effects.
5. Unknown phase → log WARN, return non-zero, skip the request (caller continues main loop).
6. `spawn_session_typed()` failure → mark state as `failed` and log; daemon survives.
7. Time-out path → mark phase result as `fail` with `error="WALL_CLOCK_TIMEOUT"`; advance_phase handles retry/exhaustion.

## Implementation

**Files modified**
- `plugins/autonomous-dev/bin/supervisor-loop.sh` — add `dispatch_phase_session()`.

**Function contract**
```bash
# dispatch_phase_session <request_id>
#   reads state.json, resolves agent, writes phase prompt context,
#   invokes spawn_session_typed under a 30m timeout, returns its exit code.
dispatch_phase_session() {
  local request_id="$1"
  validate_request_id "$request_id" || { log_error "..."; return 2; }

  local state_file="$(state_file_for "$request_id")"
  local phase
  phase=$(jq -r '.current_phase' "$state_file")
  local agent
  agent=$(resolve_agent "$phase") || { log_warn "unknown phase: $phase"; return 3; }

  write_phase_prompt_context "$state_file" "$phase"

  local prompt_path="${state_file%state.json}phase-prompt-${phase}.txt"
  local result_path="${state_file%state.json}phase-result-${phase}.json"

  timeout --kill-after=10s 30m \
    bash "${PLUGIN_DIR}/bin/spawn-session.sh" \
         spawn_session_typed "$agent" "$prompt_path" "$result_path"
  local rc=$?
  if (( rc == 124 )); then
    write_synthesized_phase_result "$result_path" fail "WALL_CLOCK_TIMEOUT"
    return 124
  fi
  return $rc
}
```

**Helper `write_phase_prompt_context`** — composes the phase prompt and either writes it as a side file (Scenario B from SPEC-039-2-01) or embeds it in `state.json.current_phase_metadata.phase_prompt` (Scenario A). Decision driven by SPEC-039-2-01 research outcome.

**Error handling matrix (TASK-026)**
- Invalid request_id (regex fail) → return 2, log ERROR, do not touch state.
- Unknown phase → return 3, log WARN, do not touch state.
- spawn_session_typed exit nonzero (not 124) → propagate code; advance_phase will see phase-result.json status=fail (synthesized if needed by SPEC-039-2-07).
- timeout (exit 124) → synthesize fail result, return 124.
- Any other shell-level error → trap caught, ERROR log, return 1.

## Tests

**Files created**
- `plugins/autonomous-dev/tests/bats/dispatch_phase.bats`

**Test cases**
1. (AC-038-11) `dispatch_uses_spawn_session_typed` — bind-mount mock `claude`, observe `spawn_session_typed` called.
2. `reads_current_phase_not_status` — set state.json with `status=running, current_phase=prd`; assert agent resolved is `prd-author`.
3. `unknown_phase_returns_3_no_state_change` — set `current_phase=garbage`; state.json unchanged after dispatch.
4. `invalid_request_id_returns_2` — `dispatch_phase_session "bogus"` returns 2; logs ERROR.
5. `timeout_synthesizes_fail` — replace claude with a `sleep 9999` script; assert exit 124 + phase-result.json written with `status=fail`, `error=WALL_CLOCK_TIMEOUT`.
6. `spawn_failure_returns_propagated_code` — mock spawn_session_typed exit 42; assert dispatch returns 42.

## Verification

- `bash -n bin/supervisor-loop.sh`
- `shellcheck bin/supervisor-loop.sh`
- `bats tests/bats/dispatch_phase.bats`
- Manual: submit a request, run daemon `--once`, observe `spawn_session_typed` invocation in logs.

## Amendment (PRD-020)

The real `claude` CLI contract is `claude --print --output-format json --agent <name> --add-dir <req_dir> --add-dir <project> --permission-mode bypassPermissions --max-budget-usd <amt> "<prompt>"` (no `--state`/`--bug-context-path`/`--expedited`/`--max-turns`/`--prompt`/`--project-directory`) — see `docs/research/RESEARCH-039-claude-state-semantics.md`. (`bypassPermissions` per B-12.)
