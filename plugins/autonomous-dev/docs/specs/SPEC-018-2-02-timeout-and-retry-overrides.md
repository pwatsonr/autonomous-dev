# SPEC-018-2-02: Per-Type Phase Timeouts and maxRetries Enforcement

## Metadata
- **Parent Plan**: PLAN-018-2
- **Tasks Covered**: Task 3 (timeout overrides from `type_config.phaseTimeouts`), Task 6 (`maxRetries` enforcement from `type_config.maxRetries`)
- **Estimated effort**: 4 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-018-2-02-timeout-and-retry-overrides.md`

## Description
Replace the supervisor's two global limits — phase-timeout duration and per-phase retry budget — with per-request lookups that consult `type_config.phaseTimeouts` and `type_config.maxRetries` from `state.json` before falling back to global defaults read from `~/.claude/autonomous-dev.json`. Both lookups must produce escalation messages that name the request type and the configured limit so operators can immediately see whether a stuck request is using the right per-type config (e.g., a `hotfix` with a 30-minute `code` timeout vs. the global 4-hour default). Escalation routing itself is untouched (TDD-009); this spec just enriches the messages and changes the limits being enforced.

The change is contained to `bin/supervisor-loop.sh`. No state schema changes (the v1.1 schema from PLAN-018-1 already carries `type_config`). No new external dependencies.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/bin/supervisor-loop.sh` | Modify | Replace `get_phase_timeout()` and `should_retry()` (or equivalents) with type-aware variants; enrich escalation messages |
| `plugins/autonomous-dev/bin/lib/typed-limits.sh` | Create | Helper functions `resolve_phase_timeout` and `resolve_max_retries` so the supervisor stays focused on loop control |

## Implementation Details

### `lib/typed-limits.sh`

```bash
#!/usr/bin/env bash
# Type-aware limit resolution. Sourced by supervisor-loop.sh.

# Returns the timeout in seconds for the given phase on the given state.
# Lookup order: type_config.phaseTimeouts[phase] -> global default.
resolve_phase_timeout() {
  local state_file="$1" phase="$2"
  local override
  override=$(jq -r --arg p "$phase" \
    '.type_config.phaseTimeouts[$p] // empty' \
    "$state_file")
  if [[ -n "$override" && "$override" != "null" ]]; then
    printf '%s\n' "$override"
    return 0
  fi
  jq -r '.phase_timeout_seconds // 14400' "$AUTONOMOUS_DEV_CONFIG"
}

# Returns the maxRetries budget for this state.
# Lookup order: type_config.maxRetries -> global default (3).
resolve_max_retries() {
  local state_file="$1"
  local override
  override=$(jq -r '.type_config.maxRetries // empty' "$state_file")
  if [[ -n "$override" && "$override" != "null" ]]; then
    printf '%s\n' "$override"
    return 0
  fi
  jq -r '.max_retries // 3' "$AUTONOMOUS_DEV_CONFIG"
}
```

`AUTONOMOUS_DEV_CONFIG` is already exported by `supervisor-loop.sh` and points at `~/.claude/autonomous-dev.json`.

### Timeout Enforcement

The existing phase-deadline check inside the supervisor's main loop is replaced with:

```bash
local timeout
timeout=$(resolve_phase_timeout "$state_file" "$current_phase")
local elapsed=$(( $(date +%s) - $(jq -r '.phase_started_at' "$state_file") ))
if (( elapsed > timeout )); then
  local req_type
  req_type=$(jq -r '.type // "feature"' "$state_file")
  raise_escalation "$state_file" \
    "Phase '$current_phase' exceeded timeout ($timeout seconds, type=$req_type)"
  continue
fi
```

`raise_escalation` is the existing TDD-009 helper; only the message text changes here.

### maxRetries Enforcement

The existing retry counter (`retry_count` field already in state) is checked against the resolved budget:

```bash
local budget
budget=$(resolve_max_retries "$state_file")
local attempts
attempts=$(jq -r '.retry_count // 0' "$state_file")
if (( attempts >= budget )); then
  local req_type
  req_type=$(jq -r '.type // "feature"' "$state_file")
  raise_escalation "$state_file" \
    "Phase '$current_phase' exhausted retries (limit=$budget, type=$req_type)"
  continue
fi
```

### Escalation Message Format

Both messages MUST be single-line strings that satisfy the regex `Phase '[a-z_]+' (exceeded timeout|exhausted retries) \(.*type=(feature|bug|infra|refactor|hotfix)\)`. This is the contract assertions in SPEC-018-2-04 will rely on.

## Acceptance Criteria

- [ ] `resolve_phase_timeout` returns `1800` (30 minutes in seconds) when called with a state where `type_config.phaseTimeouts.code = 1800` and `phase = code`.
- [ ] `resolve_phase_timeout` returns the global default (`14400` from a fixture config) when `type_config.phaseTimeouts.code` is unset.
- [ ] `resolve_phase_timeout` falls back to a hard-coded `14400` when neither the per-type override nor the global config define a value.
- [ ] `resolve_max_retries` returns `5` when called with a state where `type_config.maxRetries = 5`.
- [ ] `resolve_max_retries` returns `2` when called with a state where `type_config.maxRetries = 2` (matrix value for `infra`).
- [ ] `resolve_max_retries` returns `3` (global default) when `type_config.maxRetries` is unset.
- [ ] When the supervisor detects an exceeded timeout, the resulting escalation message contains both the literal `type=` token and the literal `seconds)` token, and includes the value returned by `resolve_phase_timeout`.
- [ ] When the supervisor detects retry exhaustion, the escalation message contains both `limit=` and the matching budget value, plus the request type.
- [ ] The escalation messages match the regex documented in the Implementation Details section (verified by a bats assertion).
- [ ] When `type_config` is entirely absent on a state file (legacy v1.0 state), both helpers return their global defaults without raising an error and without printing `null`.
- [ ] `shellcheck` passes on `supervisor-loop.sh` and `lib/typed-limits.sh`.
- [ ] No regressions: feature-typed requests still see a 4-hour default timeout and 3-attempt retry budget when the global config holds those defaults.

## Dependencies

- **Blocked by PLAN-018-1**: needs `type_config.phaseTimeouts` and `type_config.maxRetries` keys in v1.1 state files.
- **Blocked by SPEC-018-2-01**: shares the modified `supervisor-loop.sh`; merge order matters even though the touched functions are different.
- TDD-009 supplies `raise_escalation`; not modified here.
- TDD-001 supplies the existing supervisor loop and the `phase_started_at`/`retry_count` fields in state.
- No new external library or runtime introduced.

## Notes

- Phase-timeout values are stored as **seconds** in `type_config.phaseTimeouts`. The matrix in TDD-018 expresses them as minutes for readability; PLAN-018-1's matrix-loader is responsible for the conversion. This spec does the lookup verbatim — if a value is stored as `30` rather than `1800`, the supervisor will treat the phase as already-timed-out within 30 seconds, which is correct surfacing of an upstream bug.
- The `// empty` fallback inside `jq` matters: `// 14400` would coerce a stored `0` to `14400`, which is the wrong behavior if an operator deliberately wants a zero-length timeout. (The matrix never sets zero, so this is paranoia, but cheap.)
- The `continue` in the supervisor loop after raising an escalation is intentional: an escalated request is paused and not eligible for advancement until an operator resolves it. The pause flag itself lives in TDD-009's escalation handler — out of scope here.
- `lib/typed-limits.sh` is a sibling of `lib/phase-legacy.sh` from SPEC-018-2-01. The two helpers are split intentionally so future plans (e.g., PLAN-019-* hooks) can override the limit functions without touching the legacy phase array.
- Snapshot testing of escalation messages is in SPEC-018-2-04. This spec only requires that the messages match the documented regex.
