# SPEC-010-3-02: Rate-Limit Detection & Exponential Backoff State Machine

## Metadata
- **Parent Plan**: PLAN-010-3
- **Tasks Covered**: Task 4, Task 5, Task 6
- **Estimated effort**: 9 hours

## Description

Implement rate-limit detection from Claude Code error output, the exponential backoff state machine with persistent state file, pre-iteration backoff checking, and state clearing after successful sessions.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Create | `lib/rate_limit_handler.sh` | Detection, backoff state machine, state management |

## Implementation Details

### Rate-Limit Detection

**`detect_rate_limit()`** -- Takes session output, returns 0 if rate limit detected, 1 if not:

```bash
detect_rate_limit() {
  local session_output="$1"
  
  # Pattern 1: HTTP 429 status code
  if echo "$session_output" | grep -qiE '(HTTP[/ ]429|status[: ]+429)'; then
    return 0
  fi
  
  # Pattern 2: Rate limit text variants
  if echo "$session_output" | grep -qiE '(rate[_ -]?limit|rate[_ -]?limited|too many requests)'; then
    # Avoid false positives: reject if "rate" appears only in non-limit context
    # (e.g., "approval rate" or "error rate")
    if echo "$session_output" | grep -qiE '(rate[_ -]?limit (exceeded|reached|hit|error)|you are being rate[_ -]?limited|too many requests)'; then
      return 0
    fi
  fi
  
  # Pattern 3: Anthropic API specific errors
  if echo "$session_output" | grep -qiE 'anthropic.*rate.*limit|overloaded_error'; then
    return 0
  fi
  
  return 1
}
```

**Patterns matched**:
- `HTTP 429`, `HTTP/1.1 429`, `status: 429`, `status code 429`
- `rate limit exceeded`, `rate limit reached`, `rate limit hit`, `rate limit error`
- `rate_limit_exceeded` (underscore variant)
- `you are being rate limited`, `too many requests`
- `anthropic.*rate.*limit`, `overloaded_error`

**False positive avoidance**: The phrase "rate" alone does not trigger (e.g., "approval rate threshold exceeded" is not a rate limit).

### Exponential Backoff State Machine

**State file**: `~/.autonomous-dev/rate-limit-state.json`

```json
{
  "active": true,
  "triggered_at": "2026-04-08T14:00:00Z",
  "current_backoff_seconds": 120,
  "retry_at": "2026-04-08T14:02:00Z",
  "consecutive_rate_limits": 3
}
```

**Default (no rate limit) state**:

```json
{
  "active": false,
  "triggered_at": null,
  "current_backoff_seconds": 0,
  "retry_at": null,
  "consecutive_rate_limits": 0
}
```

**`handle_rate_limit()`** -- Called when a rate limit is detected. Advances the backoff state:

```bash
handle_rate_limit() {
  local effective_config="$1"
  local state_file="${HOME}/.autonomous-dev/rate-limit-state.json"
  
  local base_seconds max_seconds
  base_seconds=$(echo "$effective_config" | jq -r '.governance.rate_limit_backoff_base_seconds')
  max_seconds=$(echo "$effective_config" | jq -r '.governance.rate_limit_backoff_max_seconds')
  
  local consecutive=0
  if [[ -f "$state_file" ]]; then
    consecutive=$(jq -r '.consecutive_rate_limits // 0' "$state_file" 2>/dev/null) || consecutive=0
  fi
  consecutive=$((consecutive + 1))
  
  # Compute backoff: base * 2^(consecutive-1)
  local backoff=$((base_seconds * (1 << (consecutive - 1))))
  
  # Backoff sequence with defaults (base=30): 30, 60, 120, 240, 480, then pause
  if (( backoff > max_seconds )); then
    log_error "rate_limit_handler" "Rate limit persists after $consecutive consecutive retries. Activating kill switch."
    
    # Emit escalation
    local payload
    payload=$(jq -nc \
      --argjson consecutive "$consecutive" \
      --argjson max "$max_seconds" \
      '{
        escalation_type: "infrastructure",
        urgency: "immediate",
        message: ("API rate limit persists after " + ($consecutive|tostring) + " consecutive retries. System pausing all work."),
        consecutive_rate_limits: $consecutive,
        max_backoff_seconds: $max,
        recommendation: "Check Anthropic API status. Verify API key quota. Wait for rate limits to clear, then manually restart."
      }')
    emit_escalation "$payload"
    
    # Write kill switch state
    write_rate_limit_state "$state_file" true "$consecutive" "$max_seconds" true
    return 1
  fi
  
  # Compute retry_at timestamp
  local retry_at
  if [[ "$(uname)" == "Darwin" ]]; then
    retry_at=$(date -u -v "+${backoff}S" +"%Y-%m-%dT%H:%M:%SZ")
  else
    retry_at=$(date -u -d "+${backoff} seconds" +"%Y-%m-%dT%H:%M:%SZ")
  fi
  
  log_warning "rate_limit_handler" "Rate limit detected (consecutive: $consecutive). Backing off for ${backoff}s until $retry_at"
  
  write_rate_limit_state "$state_file" true "$consecutive" "$backoff" false "$retry_at"
  return 0
}
```

**`write_rate_limit_state()`** -- Atomic state file write:

```bash
write_rate_limit_state() {
  local state_file="$1"
  local active="$2"
  local consecutive="$3"
  local backoff="$4"
  local kill_switch="${5:-false}"
  local retry_at="${6:-null}"
  
  local triggered_at
  triggered_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  
  local state_dir
  state_dir=$(dirname "$state_file")
  mkdir -p "$state_dir"
  
  local tmp_file="${state_file}.tmp.$$"
  jq -nc \
    --argjson active "$active" \
    --arg triggered_at "$triggered_at" \
    --argjson backoff "$backoff" \
    --arg retry_at "$retry_at" \
    --argjson consecutive "$consecutive" \
    --argjson kill_switch "$kill_switch" \
    '{
      active: $active,
      triggered_at: $triggered_at,
      current_backoff_seconds: $backoff,
      retry_at: (if $retry_at == "null" then null else $retry_at end),
      consecutive_rate_limits: $consecutive,
      kill_switch: $kill_switch
    }' > "$tmp_file" && mv "$tmp_file" "$state_file"
}
```

**Backoff sequence** (with default base=30s, max=900s):

| Consecutive | Backoff (seconds) | Action |
|---|---|---|
| 1 | 30 | Wait 30s |
| 2 | 60 | Wait 60s |
| 3 | 120 | Wait 120s |
| 4 | 240 | Wait 240s |
| 5 | 480 | Wait 480s |
| 6 | 960 > 900 | Exceeds max: kill switch + escalation |

### Pre-Iteration Rate-Limit Check

**`check_rate_limit_state()`** -- Called at the start of each iteration:

```bash
check_rate_limit_state() {
  local state_file="${HOME}/.autonomous-dev/rate-limit-state.json"
  
  # Missing file: no active rate limit
  if [[ ! -f "$state_file" ]]; then
    return 0
  fi
  
  # Parse state file
  local state
  if ! state=$(jq '.' "$state_file" 2>/dev/null); then
    log_warning "rate_limit_handler" "Corrupted rate-limit state file. Deleting and recreating."
    rm -f "$state_file"
    return 0
  fi
  
  local active kill_switch retry_at
  active=$(echo "$state" | jq -r '.active')
  kill_switch=$(echo "$state" | jq -r '.kill_switch // false')
  retry_at=$(echo "$state" | jq -r '.retry_at // "null"')
  
  # Kill switch: do not proceed
  if [[ "$kill_switch" == "true" ]]; then
    log_error "rate_limit_handler" "Kill switch active. Manual restart required."
    return 1
  fi
  
  # Not active: proceed
  if [[ "$active" != "true" ]]; then
    return 0
  fi
  
  # Check if retry_at has passed
  if [[ "$retry_at" != "null" ]] && [[ -n "$retry_at" ]]; then
    local now_epoch retry_epoch
    now_epoch=$(date -u +%s)
    if [[ "$(uname)" == "Darwin" ]]; then
      retry_epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$retry_at" +%s 2>/dev/null) || retry_epoch=0
    else
      retry_epoch=$(date -u -d "$retry_at" +%s 2>/dev/null) || retry_epoch=0
    fi
    
    if (( now_epoch < retry_epoch )); then
      local remaining=$((retry_epoch - now_epoch))
      log_info "rate_limit_handler" "Rate limit backoff active. ${remaining}s remaining until $retry_at"
      return 1  # Still in backoff period
    fi
  fi
  
  # Backoff expired: allow work to proceed (but state remains active until a successful session clears it)
  return 0
}
```

### State Clearing After Successful Session

**`clear_rate_limit_state()`** -- Called after a successful session that did not hit a rate limit:

```bash
clear_rate_limit_state() {
  local state_file="${HOME}/.autonomous-dev/rate-limit-state.json"
  
  if [[ ! -f "$state_file" ]]; then
    return 0
  fi
  
  local active
  active=$(jq -r '.active // false' "$state_file" 2>/dev/null) || active="false"
  
  if [[ "$active" == "true" ]]; then
    log_info "rate_limit_handler" "Clearing rate limit state after successful session."
    write_rate_limit_state "$state_file" false 0 0 false
  fi
}
```

## Acceptance Criteria

1. `detect_rate_limit` correctly identifies HTTP 429 responses in session output.
2. `detect_rate_limit` correctly identifies "rate limit exceeded" and common text variants.
3. `detect_rate_limit` does NOT false-positive on normal output mentioning "rate" in other contexts (e.g., "approval rate").
4. Backoff sequence matches TDD spec: base, base*2, base*4, base*8, base*16, then kill switch.
5. State file is written atomically (`tmp` + `mv`).
6. State file matches Section 4.3 schema (active, triggered_at, current_backoff_seconds, retry_at, consecutive_rate_limits).
7. When backoff exceeds `rate_limit_backoff_max_seconds`, the kill switch activates and an escalation is emitted.
8. `retry_at` timestamp is computed correctly on both macOS and Linux.
9. Pre-iteration check respects the `retry_at` timestamp: returns 1 if current time is before `retry_at`.
10. Expired backoffs allow work to proceed (returns 0).
11. Successful session clears state to `active: false, consecutive_rate_limits: 0`.
12. Missing state file is treated as "no active rate limit".
13. Corrupted state file is deleted and recreated (per Section 5.3).
14. Global scope: the state affects ALL requests (not per-request).

## Test Cases

1. **Detect HTTP 429**: Output contains `HTTP/1.1 429 Too Many Requests`. Returns 0 (detected).
2. **Detect rate limit text**: Output contains `Rate limit exceeded`. Returns 0.
3. **Detect underscore variant**: Output contains `rate_limit_exceeded`. Returns 0.
4. **Detect too many requests**: Output contains `Too many requests`. Returns 0.
5. **Detect Anthropic-specific**: Output contains `anthropic api rate limit`. Returns 0.
6. **No false positive on "approval rate"**: Output mentions "approval rate threshold". Returns 1 (not detected).
7. **No false positive on normal output**: Output has no rate limit indicators. Returns 1.
8. **Backoff step 1**: First rate limit. `consecutive=1`, `backoff=30` (base=30).
9. **Backoff step 2**: Second rate limit. `consecutive=2`, `backoff=60`.
10. **Backoff step 3**: Third. `consecutive=3`, `backoff=120`.
11. **Backoff step 4**: Fourth. `consecutive=4`, `backoff=240`.
12. **Backoff step 5**: Fifth. `consecutive=5`, `backoff=480`.
13. **Backoff step 6 (kill switch)**: Sixth. `backoff=960 > 900`. Kill switch activated. Escalation emitted.
14. **State file after step 3**: File contains `active:true, consecutive:3, backoff:120`, valid `retry_at`.
15. **Pre-check during active backoff**: `retry_at` is 60s in the future. Returns 1 (blocked).
16. **Pre-check after backoff expired**: `retry_at` is 60s in the past. Returns 0 (allowed).
17. **Pre-check kill switch**: Kill switch is true. Returns 1 regardless of retry_at.
18. **Clear after success**: State is active with consecutive=3. After clear, `active=false, consecutive=0`.
19. **Clear when not active**: State is already inactive. No-op, no error.
20. **Missing state file**: `check_rate_limit_state` returns 0.
21. **Corrupted state file**: File contains `{invalid`. File is deleted, returns 0.
22. **State file atomic write**: Concurrent-safe: `tmp` file is created before `mv`.
