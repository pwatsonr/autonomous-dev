# SPEC-039-2-07: phase-result.json synthesis fallback

## Metadata
- **Parent Plan**: PLAN-039
- **Parent TDD**: TDD-038
- **Parent PRD**: PRD-019
- **Tasks Covered**: PLAN-039 TASK-014
- **Dependencies**: SPEC-039-2-03
- **Estimated effort**: 1.5 hours
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-11

## Objective

When `spawn_session_typed()` returns and the invoked agent did NOT write `phase-result-<phase>.json` (defensive: even though agent specs require it, agents sometimes regress), the wrapper synthesises one from exit code: `0 → status=pass`, nonzero → `status=fail`. Architecture-review caveat: exit code 0 does NOT mean semantic success — so the synthesized result must carry a `synthesized: true` flag and the daemon logs a clear "trusting exit code, not agent output" warning per TDD §6.2 MAJOR-2 mitigation.

## Acceptance Criteria

1. If `phase-result-<phase>.json` exists after spawn: no synthesis (trust agent's output).
2. If missing: wrapper writes a synthesized doc with `status="pass"|"fail"`, `synthesized: true`, `exit_code: <int>`, `synthesized_at: <iso>`.
3. Daemon logs WARN when consuming a synthesized result, including request_id, phase, and exit code.
4. Tests verify both branches (file present, file absent) and the WARN log path.

## Implementation

**Files modified**
- `plugins/autonomous-dev/bin/spawn-session.sh` — extend `spawn_session_typed()` post-invocation block.
- `plugins/autonomous-dev/bin/supervisor-loop.sh` — `advance_phase()` reads `.synthesized` and logs WARN if true (consumer side).

**Wrapper post-invocation logic**
```bash
spawn_session_typed() {
  local agent="$1" prompt_path="$2" result_path="$3"
  # ... invoke claude ...
  local rc=$?
  if [[ ! -f "$result_path" ]]; then
    write_synthesized_phase_result "$result_path" \
      "$( (( rc == 0 )) && echo pass || echo fail )" "" "$rc"
  fi
  return $rc
}

write_synthesized_phase_result() {
  local path="$1" status="$2" error_msg="$3" exit_code="${4:-0}"
  local tmp="${path}.tmp.$$"
  jq -n --arg s "$status" --arg e "$error_msg" --argjson rc "$exit_code" \
    --arg ts "$(date -Iseconds)" \
    '{status:$s, error:$e, exit_code:$rc, synthesized:true, synthesized_at:$ts, artifacts:[]}' \
    > "$tmp"
  mv "$tmp" "$path"
}
```

**Consumer-side warning (advance_phase)**
```bash
local synthesized
synthesized=$(jq -r '.synthesized // false' "$result_file")
if [[ "$synthesized" == "true" ]]; then
  log_warn "synthesized phase result for $request_id $cur_phase (exit code only; trust=low)"
fi
```

## Tests

**Files created**
- `plugins/autonomous-dev/tests/bats/phase_result_synthesis.bats`

**Test cases**
1. `agent_wrote_file_no_synthesis` — phase-result.json present after invocation: file unchanged, no `.synthesized` field added.
2. `agent_missing_file_exit_0_synthesizes_pass` — invocation exit 0, no file: synthesized doc has `status=pass, synthesized=true, exit_code=0`.
3. `agent_missing_file_exit_nonzero_synthesizes_fail` — exit 42, no file: `status=fail, exit_code=42`.
4. `consumer_logs_warn_when_synthesized` — advance_phase processes synthesized doc; log buffer contains WARN with request_id + phase.
5. `synthesized_result_can_be_consumed_by_advance` — full end-to-end: synthesized pass advances phase normally.

## Verification

- `bash -n bin/spawn-session.sh bin/supervisor-loop.sh`
- `bats tests/bats/phase_result_synthesis.bats`
