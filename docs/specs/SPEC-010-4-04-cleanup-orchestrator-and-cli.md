# SPEC-010-4-04: Cleanup Orchestrator, Automatic Trigger, and CLI Command

## Metadata
- **Parent Plan**: PLAN-010-4
- **Tasks Covered**: Task 11, Task 12, Task 13, Task 14
- **Estimated effort**: 10 hours

## Description

Implement the top-level `cleanup_run()` orchestrator that iterates all allowlisted repos and runs cleanup sub-tasks in the specified order, the automatic cleanup trigger integrated into the supervisor loop's iteration counter, the `autonomous-dev cleanup` CLI command with `--dry-run`, and comprehensive error handling for all cleanup failure scenarios.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Modify | `lib/cleanup_engine.sh` | Add `cleanup_run()` orchestrator and error handling |
| Create | `lib/cleanup_trigger.sh` | Supervisor loop iteration counter and trigger |
| Create | `commands/cleanup.sh` | CLI command with --dry-run support |

## Implementation Details

### Cleanup Orchestrator (lib/cleanup_engine.sh)

**`cleanup_run()`** -- Top-level function that runs all cleanup sub-tasks in the order specified by TDD-010 Section 3.7.3:

```bash
cleanup_run() {
  local effective_config="$1"
  local dry_run="${2:-false}"
  
  local start_time
  start_time=$(date -u +%s)
  
  # Statistics
  local requests_archived=0 requests_deleted=0
  local worktrees_removed=0 branches_deleted=0
  local observations_archived=0 observations_deleted=0
  local logs_deleted=0 ledger_archives_pruned=0
  local tarballs_pruned=0 errors=0
  
  # Export dry_run for sub-functions
  export CLEANUP_DRY_RUN="$dry_run"
  
  # --- Phase 1: Per-repo cleanup ---
  while IFS= read -r repo; do
    [[ -z "$repo" ]] && continue
    [[ -d "$repo" ]] || {
      log_warning "cleanup_engine" "Allowlisted repo not found: $repo (skipping)"
      continue
    }
    
    log_info "cleanup_engine" "Cleaning up: $repo"
    
    # 1a. Request cleanup (archive + delete state dirs + worktrees + branches)
    local requests_dir="${repo}/.autonomous-dev/requests"
    if [[ -d "$requests_dir" ]]; then
      for req_dir in "$requests_dir"/*/; do
        [[ -d "$req_dir" ]] || continue
        local state_file="${req_dir}state.json"
        [[ -f "$state_file" ]] || continue
        
        local status
        status=$(jq -r '.status' "$state_file" 2>/dev/null) || continue
        
        case "$status" in
          completed|cancelled|failed) ;;
          *) continue ;;
        esac
        
        local request_id
        request_id=$(basename "$req_dir")
        
        if is_artifact_expired "request" "$req_dir" "$effective_config"; then
          if [[ "$dry_run" == "true" ]]; then
            echo "DRY-RUN: Would archive and delete $request_id ($(get_artifact_age_days request "$req_dir") days old)"
            ((requests_archived++))
          else
            # Archive
            if archive_request "$req_dir"; then
              ((requests_archived++))
              
              # Worktree cleanup
              if cleanup_worktree "$repo" "$request_id" "$req_dir" "$effective_config"; then
                ((worktrees_removed++))
              fi
              
              # Remote branch cleanup
              if cleanup_remote_branch "$repo" "$request_id" "$effective_config"; then
                ((branches_deleted++))
              else
                ((errors++))
              fi
              
              # Delete state directory
              if cleanup_request_dir "$req_dir"; then
                ((requests_deleted++))
              else
                ((errors++))
              fi
            else
              ((errors++))
            fi
          fi
        fi
      done
    fi
    
    # 1b. Observation cleanup
    local obs_result
    if [[ "$dry_run" == "true" ]]; then
      obs_result=$(cleanup_observations_dry_run "$repo" "$effective_config")
    else
      cleanup_observations "$repo" "$effective_config"
    fi
    
  done < <(echo "$effective_config" | jq -r '.repositories.allowlist[]?')
  
  # --- Phase 2: Global cleanup ---
  
  # 2a. Daemon log rotation
  if [[ "$dry_run" == "true" ]]; then
    count_expired_logs "daemon_log" "$effective_config"
  else
    rotate_daemon_logs "$effective_config"
  fi
  
  # 2b. Config validation log rotation
  if [[ "$dry_run" == "true" ]]; then
    count_expired_logs "config_validation_log" "$effective_config"
  else
    rotate_config_validation_logs "$effective_config"
  fi
  
  # 2c. Cost ledger rotation
  if [[ "$dry_run" != "true" ]]; then
    rotate_cost_ledger
  fi
  
  # 2d. Cost ledger archive pruning
  if [[ "$dry_run" == "true" ]]; then
    count_expired_ledger_archives "$effective_config"
  else
    prune_cost_ledger_archives "$effective_config"
  fi
  
  # 2e. Archived request tarball pruning
  if [[ "$dry_run" == "true" ]]; then
    count_expired_tarballs "$effective_config"
  else
    prune_archived_requests "$effective_config"
  fi
  
  # --- Summary ---
  local elapsed=$(($(date -u +%s) - start_time))
  
  local summary
  summary=$(jq -nc \
    --argjson archived "$requests_archived" \
    --argjson deleted "$requests_deleted" \
    --argjson worktrees "$worktrees_removed" \
    --argjson branches "$branches_deleted" \
    --argjson obs_archived "$observations_archived" \
    --argjson obs_deleted "$observations_deleted" \
    --argjson logs "$logs_deleted" \
    --argjson ledgers "$ledger_archives_pruned" \
    --argjson tarballs "$tarballs_pruned" \
    --argjson errors "$errors" \
    --argjson elapsed "$elapsed" \
    --argjson dry_run "$dry_run" \
    '{
      requests_archived: $archived,
      state_dirs_deleted: $deleted,
      worktrees_removed: $worktrees,
      branches_deleted: $branches,
      observations_archived: $obs_archived,
      observations_deleted: $obs_deleted,
      logs_deleted: $logs,
      ledger_archives_pruned: $ledgers,
      tarballs_pruned: $tarballs,
      errors: $errors,
      elapsed_seconds: $elapsed,
      dry_run: $dry_run
    }')
  
  echo "$summary"
  
  if (( errors > 0 )); then
    return 1
  fi
  return 0
}
```

**Execution order** (per TDD-010 Section 3.7.3):
1. Requests: archive -> worktree remove -> branch delete -> state dir delete
2. Observations: active -> archive -> delete
3. Daemon logs: delete
4. Config validation logs: delete
5. Cost ledger: rotate -> prune archives
6. Archived request tarballs: prune

### Automatic Cleanup Trigger (lib/cleanup_trigger.sh)

**`cleanup_run_if_due()`** -- Called at the END of each supervisor loop iteration:

```bash
# Persists across iterations but NOT across daemon restarts
CLEANUP_ITERATION_COUNTER=0

cleanup_run_if_due() {
  local effective_config="$1"
  
  local interval
  interval=$(echo "$effective_config" | jq -r '.cleanup.auto_cleanup_interval_iterations')
  
  ((CLEANUP_ITERATION_COUNTER++))
  
  if (( CLEANUP_ITERATION_COUNTER >= interval )); then
    log_info "cleanup_trigger" "Auto-cleanup triggered at iteration $CLEANUP_ITERATION_COUNTER (interval: $interval)"
    CLEANUP_ITERATION_COUNTER=0
    
    # Run cleanup in a subshell so it doesn't block the next iteration
    # if it takes longer than the poll interval
    (cleanup_run "$effective_config" false) &
    local cleanup_pid=$!
    
    # Don't wait -- let it run in background
    log_info "cleanup_trigger" "Cleanup running in background (PID: $cleanup_pid)"
  fi
}
```

**Key behaviors**:
- Counter increments every iteration.
- Cleanup runs every `cleanup.auto_cleanup_interval_iterations` (default: 100).
- Counter resets to 0 after triggering cleanup.
- Counter resets to 0 on daemon restart (no persistence file).
- Cleanup runs at the END of the iteration, after all work is done.
- Cleanup runs in a subshell so it does not block the next iteration.

### CLI Command (commands/cleanup.sh)

**Usage**:
```
autonomous-dev cleanup [--dry-run] [--config.key=value ...]
```

**Implementation**:

```bash
cleanup_command() {
  local dry_run=false
  local config_args=()
  
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) dry_run=true ;;
      --config.*) config_args+=("$1") ;;
      *) echo "Unknown option: $1" >&2; return 1 ;;
    esac
    shift
  done
  
  source "$PLUGIN_ROOT/lib/config_loader.sh"
  source "$PLUGIN_ROOT/lib/cleanup_engine.sh"
  source "$PLUGIN_ROOT/lib/ledger_rotation.sh"
  
  local config
  config=$(load_config "${config_args[@]}")
  
  if [[ "$dry_run" == "true" ]]; then
    echo "=== Cleanup Dry Run ==="
    echo "The following artifacts would be cleaned up:"
    echo ""
  else
    echo "=== Running Cleanup ==="
    echo ""
  fi
  
  local result
  result=$(cleanup_run "$config" "$dry_run")
  local exit_code=$?
  
  # Format output
  echo ""
  echo "=== Cleanup Summary ==="
  echo "$result" | jq -r '
    "Requests archived:        \(.requests_archived)",
    "State dirs deleted:        \(.state_dirs_deleted)",
    "Worktrees removed:         \(.worktrees_removed)",
    "Remote branches deleted:   \(.branches_deleted)",
    "Observations archived:     \(.observations_archived)",
    "Observations deleted:      \(.observations_deleted)",
    "Logs deleted:              \(.logs_deleted)",
    "Ledger archives pruned:    \(.ledger_archives_pruned)",
    "Request tarballs pruned:   \(.tarballs_pruned)",
    "Errors:                    \(.errors)",
    "Elapsed:                   \(.elapsed_seconds)s"
  '
  
  if [[ "$dry_run" == "true" ]]; then
    echo ""
    echo "(Dry run: no changes were made)"
  fi
  
  return $exit_code
}
```

**Dry-run output** format:

```
=== Cleanup Dry Run ===
The following artifacts would be cleaned up:

DRY-RUN: Would archive and delete REQ-20260301-a1b2 (38 days old)
DRY-RUN: Would archive and delete REQ-20260305-c3d4 (34 days old)
DRY-RUN: Would archive observation obs-20260101-report.json (97 days old)
DRY-RUN: Would delete daemon log daemon.log.2026-03-01 (38 days old)
DRY-RUN: Would delete cost ledger archive cost-ledger-2025-03.jsonl (13 months old)

=== Cleanup Summary ===
Requests archived:        2
State dirs deleted:        0
Worktrees removed:         0
Remote branches deleted:   0
Observations archived:     1
Observations deleted:      0
Logs deleted:              1
Ledger archives pruned:    1
Request tarballs pruned:   0
Errors:                    0
Elapsed:                   0s

(Dry run: no changes were made)
```

### Error Handling

All errors per TDD-010 Section 5.4:

```bash
# In cleanup_run(), each sub-task is wrapped with error handling:

# Archive creation failure
if ! archive_request "$req_dir"; then
  log_error "cleanup_engine" "Archive failed for $request_id. Skipping. Will retry next cycle."
  ((errors++))
  continue  # Skip to next request; do NOT delete state dir
fi

# Remote branch deletion failure
if ! cleanup_remote_branch "$repo" "$request_id" "$effective_config"; then
  log_warning "cleanup_engine" "Branch deletion failed for $request_id. Non-critical, continuing."
  ((errors++))
  # Continue with local cleanup -- branch deletion is non-critical
fi

# Worktree removal failure (handled inside cleanup_worktree with force retry)
if ! cleanup_worktree "$repo" "$request_id" "$req_dir" "$effective_config"; then
  log_error "cleanup_engine" "Worktree removal failed for $request_id. Flagged for manual intervention."
  ((errors++))
  # Continue with other cleanup
fi
```

**Error tracking**:
- Each error increments the `errors` counter.
- No error causes the entire cleanup run to abort.
- The summary reports the total error count.
- Persistent errors (worktree cannot be removed) are logged to `~/.autonomous-dev/manual-cleanup-needed.txt`.
- CLI exits 0 on success, 1 if any cleanup item failed.

## Acceptance Criteria

1. `cleanup_run()` iterates all repos in the allowlist.
2. All cleanup sub-tasks run for each repo in the documented order.
3. Results are collected and reported (items cleaned, errors encountered).
4. Individual item failure does NOT stop the entire cleanup run (continues to next item).
5. Summary statistics include counts for each artifact type.
6. Automatic cleanup runs every N iterations (default N=100).
7. Iteration counter persists across iterations but not across daemon restarts.
8. Cleanup runs at the END of the iteration, after all work is done.
9. Cleanup runs in background (does not block the next iteration).
10. `autonomous-dev cleanup --dry-run` lists all eligible artifacts with type, path, age, and action.
11. `autonomous-dev cleanup` (without `--dry-run`) executes cleanup and prints a summary.
12. Dry-run produces NO side effects (no files deleted, moved, or created).
13. CLI exit code is 0 on success, 1 if any cleanup item failed.
14. Each error type from Section 5.4 is handled as specified.
15. Error count is tracked and reported in the summary.
16. Persistent errors are flagged in `~/.autonomous-dev/manual-cleanup-needed.txt`.

## Test Cases

1. **Orchestrator basic**: 2 repos, each with 1 expired request. Both archived and cleaned.
2. **Orchestrator no expired**: All requests are recent. Nothing cleaned. Summary shows zeros.
3. **Orchestrator partial failure**: 1 request archives successfully, another fails `tar`. First is cleaned, second is skipped. Error count = 1.
4. **Orchestrator continues on error**: Branch deletion fails for request A. Cleanup continues to request B, observations, logs. Not aborted.
5. **Auto trigger at interval**: Counter starts at 0. After 100 iterations, cleanup runs. Counter resets.
6. **Auto trigger counter reset on restart**: Counter is not persisted to disk. New process starts at 0.
7. **Auto trigger not yet due**: After 50 iterations, cleanup does NOT run.
8. **Auto trigger background**: Cleanup runs in a subshell. Next iteration starts without waiting.
9. **CLI dry-run**: Eligible artifacts exist. Dry-run lists them. No files modified.
10. **CLI dry-run then real**: Run dry-run, verify output. Run real, verify files actually cleaned.
11. **CLI with no eligible artifacts**: Output shows "0" for all categories.
12. **CLI exit code success**: All items cleaned successfully. Exit 0.
13. **CLI exit code failure**: One item fails. Exit 1.
14. **Error: tar failure**: `tar` fails for one request. That request is skipped. Others continue.
15. **Error: branch delete failure**: `git push --delete` fails. Warning logged. Local cleanup continues.
16. **Error: worktree removal needs manual intervention**: After force-remove fails, entry appears in `manual-cleanup-needed.txt`.
