# SPEC-010-3-01: Disk Usage, Worktree Count, and Active Session Monitoring

## Metadata
- **Parent Plan**: PLAN-010-3
- **Tasks Covered**: Task 1, Task 2, Task 3
- **Estimated effort**: 10 hours

## Description

Implement disk usage monitoring with cross-platform support (macOS/Linux), worktree count tracking across all allowlisted repositories, and active session counting with PID liveness verification.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Create | `lib/resource_monitor.sh` | Disk, worktree, and session monitoring functions |

## Implementation Details

### Disk Usage Monitoring

**`check_disk_usage()`** -- Measures disk usage and compares against three thresholds.

```bash
check_disk_usage() {
  local effective_config="$1"
  
  local system_limit_gb worktree_warn_gb worktree_hard_gb
  system_limit_gb=$(echo "$effective_config" | jq -r '.governance.disk_usage_limit_gb')
  worktree_warn_gb=$(echo "$effective_config" | jq -r '.parallel.disk_warning_threshold_gb')
  worktree_hard_gb=$(echo "$effective_config" | jq -r '.parallel.disk_hard_limit_gb')
  
  local result='{"status":"pass","checks":[]}'
  
  # --- System-wide check: ~/.autonomous-dev/ ---
  local sys_dir="${HOME}/.autonomous-dev"
  local sys_usage_gb
  sys_usage_gb=$(measure_disk_gb "$sys_dir") || {
    log_warning "resource_monitor" "du failed on $sys_dir; skipping disk check"
    # Per Section 5.3: do NOT block work when measurement fails
    echo "$result"
    return 0
  }
  
  local system_limit_bytes
  if (( $(echo "$sys_usage_gb >= $system_limit_gb" | bc -l) )); then
    result=$(echo "$result" | jq \
      --argjson usage "$sys_usage_gb" \
      --argjson limit "$system_limit_gb" \
      '.status = "fail" | .checks += [{"type":"system_disk","status":"exceeded","usage_gb":$usage,"limit_gb":$limit}]')
  else
    result=$(echo "$result" | jq \
      --argjson usage "$sys_usage_gb" \
      --argjson limit "$system_limit_gb" \
      '.checks += [{"type":"system_disk","status":"ok","usage_gb":$usage,"limit_gb":$limit}]')
  fi
  
  # --- Worktree aggregate check ---
  local worktree_usage_gb
  worktree_usage_gb=$(measure_worktree_disk_total "$effective_config") || {
    log_warning "resource_monitor" "Worktree disk measurement failed; skipping"
    echo "$result"
    return 0
  }
  
  if (( $(echo "$worktree_usage_gb >= $worktree_hard_gb" | bc -l) )); then
    result=$(echo "$result" | jq \
      --argjson usage "$worktree_usage_gb" \
      --argjson limit "$worktree_hard_gb" \
      '.status = "fail" | .checks += [{"type":"worktree_disk","status":"exceeded","usage_gb":$usage,"limit_gb":$limit}]')
  elif (( $(echo "$worktree_usage_gb >= $worktree_warn_gb" | bc -l) )); then
    result=$(echo "$result" | jq \
      --argjson usage "$worktree_usage_gb" \
      --argjson limit "$worktree_warn_gb" \
      '.checks += [{"type":"worktree_disk","status":"warning","usage_gb":$usage,"threshold_gb":$limit}]')
    log_warning "resource_monitor" "Worktree disk usage ${worktree_usage_gb}GB exceeds warning threshold ${worktree_warn_gb}GB"
  else
    result=$(echo "$result" | jq \
      --argjson usage "$worktree_usage_gb" \
      '.checks += [{"type":"worktree_disk","status":"ok","usage_gb":$usage}]')
  fi
  
  echo "$result"
  if echo "$result" | jq -e '.status == "fail"' >/dev/null 2>&1; then
    return 1
  fi
  return 0
}
```

**`measure_disk_gb()`** -- Cross-platform disk measurement:

```bash
measure_disk_gb() {
  local path="$1"
  
  if [[ ! -d "$path" ]]; then
    echo "0"
    return 0
  fi
  
  local usage_bytes
  if [[ "$(uname)" == "Darwin" ]]; then
    # macOS: du -sk returns kilobytes
    local usage_kb
    usage_kb=$(du -sk "$path" 2>/dev/null | awk '{print $1}') || return 1
    usage_bytes=$((usage_kb * 1024))
  else
    # Linux: du -sb returns bytes
    usage_bytes=$(du -sb "$path" 2>/dev/null | awk '{print $1}') || return 1
  fi
  
  # Convert bytes to GB with 2 decimal places
  echo "scale=2; $usage_bytes / 1073741824" | bc -l
}
```

**`measure_worktree_disk_total()`** -- Aggregate worktree disk usage across all repos:

```bash
measure_worktree_disk_total() {
  local effective_config="$1"
  local total_gb="0"
  
  while IFS= read -r repo; do
    [[ -z "$repo" ]] && continue
    # Get worktree paths from git worktree list
    local worktree_paths
    worktree_paths=$(cd "$repo" 2>/dev/null && git worktree list --porcelain 2>/dev/null | grep "^worktree " | sed 's/^worktree //')
    while IFS= read -r wt_path; do
      [[ -z "$wt_path" ]] && continue
      # Skip the main working tree (it's the repo itself, not a worktree)
      [[ "$wt_path" == "$repo" ]] && continue
      local wt_gb
      wt_gb=$(measure_disk_gb "$wt_path" 2>/dev/null) || continue
      total_gb=$(echo "$total_gb + $wt_gb" | bc -l)
    done <<< "$worktree_paths"
  done < <(echo "$effective_config" | jq -r '.repositories.allowlist[]?')
  
  printf "%.2f" "$total_gb"
}
```

### Worktree Count Monitoring

**`check_worktree_count()`** -- Count worktrees across all allowlisted repos:

```bash
check_worktree_count() {
  local effective_config="$1"
  
  local max_worktrees
  max_worktrees=$(echo "$effective_config" | jq -r '.parallel.max_worktrees')
  
  local total_count=0
  
  while IFS= read -r repo; do
    [[ -z "$repo" ]] && continue
    local repo_count
    if ! repo_count=$(cd "$repo" 2>/dev/null && git worktree list --porcelain 2>/dev/null | grep -c "^worktree "); then
      log_warning "resource_monitor" "git worktree list failed for $repo; assuming at max"
      # Per Section 5.3: assume max on failure (conservative)
      total_count=$max_worktrees
      break
    fi
    # Subtract 1 for the main working tree (which is not a created worktree)
    repo_count=$((repo_count > 0 ? repo_count - 1 : 0))
    total_count=$((total_count + repo_count))
  done < <(echo "$effective_config" | jq -r '.repositories.allowlist[]?')
  
  local status="pass"
  if (( total_count >= max_worktrees )); then
    status="fail"
  fi
  
  jq -nc \
    --arg status "$status" \
    --argjson count "$total_count" \
    --argjson max "$max_worktrees" \
    '{"type":"worktree_count","status":$status,"count":$count,"max":$max}'
  
  if [[ "$status" == "fail" ]]; then
    return 1
  fi
  return 0
}
```

### Active Session Counting

**`check_active_sessions()`** -- Count active Claude Code sessions by scanning state files:

```bash
check_active_sessions() {
  local effective_config="$1"
  
  local max_concurrent
  max_concurrent=$(echo "$effective_config" | jq -r '.governance.max_concurrent_requests')
  
  local active_count=0
  local terminal_states="completed cancelled failed"
  
  while IFS= read -r repo; do
    [[ -z "$repo" ]] && continue
    local requests_dir="${repo}/.autonomous-dev/requests"
    [[ -d "$requests_dir" ]] || continue
    
    for req_dir in "$requests_dir"/*/; do
      [[ -d "$req_dir" ]] || continue
      local state_file="${req_dir}state.json"
      [[ -f "$state_file" ]] || continue
      
      local status pid
      status=$(jq -r '.status // "unknown"' "$state_file" 2>/dev/null) || continue
      
      # Skip terminal states
      case " $terminal_states " in
        *" $status "*) continue ;;
      esac
      
      # Check PID liveness
      pid=$(jq -r '.current_session_pid // "null"' "$state_file" 2>/dev/null)
      if [[ "$pid" != "null" ]] && [[ -n "$pid" ]]; then
        if kill -0 "$pid" 2>/dev/null; then
          ((active_count++))
        else
          log_warning "resource_monitor" "Stale PID $pid for request $(basename "$req_dir")"
          # Dead PID: not counted (stale state)
        fi
      else
        # No PID but non-terminal: count it as active (queued/paused)
        ((active_count++))
      fi
    done
  done < <(echo "$effective_config" | jq -r '.repositories.allowlist[]?')
  
  local status="pass"
  if (( active_count >= max_concurrent )); then
    status="fail"
  fi
  
  jq -nc \
    --arg status "$status" \
    --argjson count "$active_count" \
    --argjson max "$max_concurrent" \
    '{"type":"active_sessions","status":$status,"count":$count,"max":$max}'
  
  if [[ "$status" == "fail" ]]; then
    return 1
  fi
  return 0
}
```

## Acceptance Criteria

1. Disk usage is measured in GB with 2 decimal places.
2. macOS uses `du -sk` with KB-to-bytes conversion; Linux uses `du -sb`.
3. System-wide check compares `~/.autonomous-dev/` against `governance.disk_usage_limit_gb`.
4. Worktree check compares aggregate worktree size against `parallel.disk_warning_threshold_gb` and `parallel.disk_hard_limit_gb`.
5. Warning threshold logs a warning but does not block. Hard limit blocks.
6. `du` failure is handled gracefully: log warning, skip check, do NOT block work (per Section 5.3).
7. Worktree count is summed across all allowlisted repositories.
8. Main working tree is not counted as a worktree (subtract 1).
9. `git worktree list` failure is handled conservatively: assume at max.
10. Active session count uses PID liveness check (`kill -0`).
11. Dead PIDs are not counted (stale state detection).
12. Terminal states (`completed`, `cancelled`, `failed`) are excluded from the count.
13. Missing or malformed state files are skipped gracefully.
14. Each check returns a structured JSON object with `type`, `status`, `count`/`usage`, and `max`/`limit`.

## Test Cases

1. **Disk under limit**: `~/.autonomous-dev/` is 5GB, limit is 10GB. Status `ok`.
2. **Disk at warning**: Worktree total is 2.1GB, warning at 2.0GB. Status `warning`, logged.
3. **Disk at hard limit**: Worktree total is 5.5GB, hard limit 5.0GB. Status `exceeded`, returns 1.
4. **System disk exceeded**: `~/.autonomous-dev/` is 11GB, limit 10GB. Status `fail`.
5. **du failure**: Simulate `du` failure (e.g., permission denied). Check skipped, returns 0.
6. **macOS du**: On macOS, `du -sk` output is correctly converted to GB.
7. **Worktree count under max**: 3 worktrees, max 5. Status `pass`.
8. **Worktree count at max**: 5 worktrees, max 5. Status `fail`.
9. **Worktree count git failure**: `git worktree list` fails. Assume at max (conservative).
10. **No worktrees**: Repo has only the main working tree. Count is 0.
11. **Active sessions under max**: 2 active (live PIDs), max 3. Status `pass`.
12. **Active sessions at max**: 3 active, max 3. Status `fail`.
13. **Dead PID not counted**: State file has PID that is no longer alive. Not counted. Warning logged.
14. **Terminal states excluded**: Request with status `completed` is not counted regardless of PID.
15. **Missing state file**: Request directory exists but no `state.json`. Skipped.
16. **Malformed state file**: `state.json` contains invalid JSON. Skipped with no crash.
17. **Worktree count across multiple repos**: 2 repos with 2 and 1 worktrees respectively. Total = 3.
