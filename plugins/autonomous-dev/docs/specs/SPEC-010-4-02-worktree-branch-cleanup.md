# SPEC-010-4-02: Worktree Cleanup & Remote Branch Deletion

## Metadata
- **Parent Plan**: PLAN-010-4
- **Tasks Covered**: Task 4, Task 5
- **Estimated effort**: 5 hours

## Description

Implement worktree removal for completed/cancelled/failed requests with configurable cleanup delay, and remote branch deletion for archived requests gated by the `cleanup.delete_remote_branches` config flag.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Modify | `lib/cleanup_engine.sh` | Add worktree cleanup and branch deletion functions |

## Implementation Details

### Worktree Cleanup

**`cleanup_worktree()`** -- Removes the git worktree associated with a completed request:

```bash
cleanup_worktree() {
  local repo_path="$1"
  local request_id="$2"
  local request_dir="$3"
  local effective_config="$4"
  
  local cleanup_delay
  cleanup_delay=$(echo "$effective_config" | jq -r '.parallel.worktree_cleanup_delay_seconds')
  
  # Determine completion time from state.json
  local state_file="${request_dir}/state.json"
  if [[ ! -f "$state_file" ]]; then
    return 0  # No state file, nothing to do
  fi
  
  local status updated_at
  status=$(jq -r '.status' "$state_file" 2>/dev/null)
  updated_at=$(jq -r '.updated_at // empty' "$state_file" 2>/dev/null)
  
  # Only clean up terminal-status requests
  case "$status" in
    completed|cancelled|failed) ;;
    *) return 0 ;;
  esac
  
  # Check cleanup delay
  if [[ -n "$updated_at" ]] && (( cleanup_delay > 0 )); then
    local completion_epoch now_epoch elapsed
    completion_epoch=$(date_to_epoch "$updated_at")
    now_epoch=$(date -u +%s)
    elapsed=$((now_epoch - completion_epoch))
    
    if (( elapsed < cleanup_delay )); then
      local remaining=$((cleanup_delay - elapsed))
      log_info "cleanup_engine" "Worktree cleanup for $request_id deferred: ${remaining}s remaining in cleanup delay"
      return 0
    fi
  fi
  
  # Find the worktree path for this request
  local worktree_path
  worktree_path=$(find_worktree_for_request "$repo_path" "$request_id")
  
  if [[ -z "$worktree_path" ]]; then
    # No worktree found -- this is normal for requests that never created one
    return 0
  fi
  
  # Attempt normal removal
  if (cd "$repo_path" && git worktree remove "$worktree_path" 2>/dev/null); then
    log_info "cleanup_engine" "Removed worktree: $worktree_path"
    return 0
  fi
  
  # Normal removal failed; attempt force removal
  log_warning "cleanup_engine" "Normal worktree removal failed for $worktree_path; attempting force removal"
  if (cd "$repo_path" && git worktree remove --force "$worktree_path" 2>/dev/null); then
    log_info "cleanup_engine" "Force-removed worktree: $worktree_path"
    return 0
  fi
  
  # Force removal also failed; flag for manual intervention
  log_error "cleanup_engine" "MANUAL INTERVENTION REQUIRED: Cannot remove worktree: $worktree_path"
  local flag_file="${HOME}/.autonomous-dev/manual-cleanup-needed.txt"
  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") worktree $worktree_path ($request_id)" >> "$flag_file"
  return 1
}
```

**`find_worktree_for_request()`** -- Locate the worktree by request ID:

```bash
find_worktree_for_request() {
  local repo_path="$1"
  local request_id="$2"
  
  # Convention: worktree branch is named autonomous/REQ-{id}
  # Use git worktree list --porcelain to find the path
  local worktree_info
  worktree_info=$(cd "$repo_path" 2>/dev/null && git worktree list --porcelain 2>/dev/null)
  
  local current_path=""
  while IFS= read -r line; do
    if [[ "$line" =~ ^worktree\ (.+)$ ]]; then
      current_path="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ ^branch\ refs/heads/autonomous/${request_id}$ ]]; then
      echo "$current_path"
      return 0
    fi
  done <<< "$worktree_info"
  
  echo ""
  return 1
}
```

**Cleanup delay logic**:
- `parallel.worktree_cleanup_delay_seconds` (default: 300 = 5 minutes) is the grace period between request completion and worktree removal.
- This allows the operator to inspect the worktree after completion.
- If `worktree_cleanup_delay_seconds` is 0, immediate cleanup is performed.

### Remote Branch Deletion

**`cleanup_remote_branch()`** -- Deletes the remote branch for an archived request:

```bash
cleanup_remote_branch() {
  local repo_path="$1"
  local request_id="$2"
  local effective_config="$3"
  
  # Check if remote branch deletion is enabled
  local delete_enabled
  delete_enabled=$(echo "$effective_config" | jq -r '.cleanup.delete_remote_branches')
  
  if [[ "$delete_enabled" != "true" ]]; then
    log_info "cleanup_engine" "Remote branch deletion disabled. Skipping $request_id."
    return 0
  fi
  
  local branch_name="autonomous/${request_id}"
  
  # Check if the remote branch exists
  if ! (cd "$repo_path" && git ls-remote --heads origin "$branch_name" 2>/dev/null | grep -q "$branch_name"); then
    # Branch does not exist on remote (already deleted or never pushed)
    log_info "cleanup_engine" "Remote branch not found: $branch_name (already deleted)"
    return 0
  fi
  
  # Delete the remote branch
  if (cd "$repo_path" && git push --delete origin "$branch_name" 2>/dev/null); then
    log_info "cleanup_engine" "Deleted remote branch: $branch_name"
    return 0
  fi
  
  # Deletion failed (remote unreachable, permissions, etc.)
  log_warning "cleanup_engine" "Failed to delete remote branch: $branch_name. Will retry next cycle."
  return 1
}
```

**Shell commands used**:

| Operation | Command |
|-----------|---------|
| List worktrees | `git worktree list --porcelain` |
| Remove worktree | `git worktree remove <path>` |
| Force remove worktree | `git worktree remove --force <path>` |
| Check remote branch | `git ls-remote --heads origin autonomous/REQ-{id}` |
| Delete remote branch | `git push --delete origin autonomous/REQ-{id}` |

## Acceptance Criteria

1. Worktrees are identified by matching the `autonomous/REQ-{id}` branch in `git worktree list --porcelain` output.
2. Worktree cleanup respects `worktree_cleanup_delay_seconds`: no removal until the delay has elapsed since the request's `updated_at`.
3. Normal `git worktree remove` is attempted first.
4. On normal failure, `git worktree remove --force` is attempted.
5. On force failure, the worktree path is logged to `~/.autonomous-dev/manual-cleanup-needed.txt` for operator review.
6. Requests that never created a worktree are handled silently (no error).
7. Remote branch deletion only runs when `cleanup.delete_remote_branches` is `true` in config.
8. Branch name follows convention: `autonomous/REQ-{id}`.
9. Already-deleted remote branches are handled gracefully (no error).
10. `git push --delete` failure is logged as a warning and does not block other cleanup operations.
11. Remote branch existence is checked before attempting deletion (avoids unnecessary errors).

## Test Cases

1. **Worktree removal success**: Completed request with a worktree. Delay elapsed. Worktree removed.
2. **Worktree removal within delay**: Completed request, delay is 300s, completion was 100s ago. NOT removed.
3. **Worktree removal zero delay**: `worktree_cleanup_delay_seconds=0`. Removed immediately.
4. **Worktree normal remove fails, force succeeds**: `git worktree remove` returns 1 (dirty). Force succeeds.
5. **Worktree force remove fails**: Both attempts fail. Error logged. Flag file created.
6. **No worktree for request**: Request never created a worktree. Silent return 0.
7. **Active request skipped**: Request status is `in_progress`. Worktree not touched.
8. **Remote branch deletion enabled**: Config `delete_remote_branches=true`. Branch exists. Deleted.
9. **Remote branch deletion disabled**: Config `delete_remote_branches=false`. Branch not deleted.
10. **Remote branch already deleted**: Branch does not exist on remote. Silent return 0.
11. **Remote branch deletion failure**: `git push --delete` fails (e.g., network error). Warning logged, continues.
12. **Manual cleanup flag**: After force-remove failure, `manual-cleanup-needed.txt` contains the worktree path and request ID.
