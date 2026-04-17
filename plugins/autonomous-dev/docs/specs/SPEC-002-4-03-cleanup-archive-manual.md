# SPEC-002-4-03: Automated Cleanup, Archive Procedure, and Manual Cleanup Command

## Metadata
- **Parent Plan**: PLAN-002-4
- **Tasks Covered**: Task 8 (Automated cleanup), Task 9 (Archive procedure), Task 10 (Manual cleanup command interface)
- **Estimated effort**: 8 hours

## Description
Implement the cleanup and archival subsystem: (1) automated cleanup that periodically scans for archivable requests past retention, (2) the archive procedure that safely copies state/events, compresses to tarball, removes worktrees, and deletes request directories, and (3) the manual cleanup command interface supporting `--dry-run`, `--force`, and `--request {id}` flags. This subsystem manages the full lifecycle endpoint -- getting completed and cancelled requests out of the active directory to reclaim disk space and reduce discovery scan time.

## Files to Create/Modify
- **Path**: `lib/state/cleanup.sh`
- **Action**: Create
- **Description**: Cleanup and archival library. Contains `automated_cleanup()`, `archive_request()`, `manual_cleanup()`, and disk space accounting helpers.

## Implementation Details

### File Header

```bash
#!/usr/bin/env bash
# cleanup.sh -- Cleanup, archival, and disk space management
# Part of TDD-002: State Machine & Request Lifecycle
set -euo pipefail

_CL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${_CL_DIR}/state_file_manager.sh"
source "${_CL_DIR}/event_logger.sh"
source "${_CL_DIR}/request_tracker.sh"

# Archive directory
readonly ARCHIVE_DIR="${HOME}/.autonomous-dev/archive"
readonly ARCHIVE_LOG="${ARCHIVE_DIR}/archive.log"

# Default retention (days)
readonly DEFAULT_MONITOR_RETENTION_DAYS=30
readonly DEFAULT_CANCELLED_RETENTION_DAYS=7

# Terminal states eligible for archival
readonly -a TERMINAL_STATES=(monitor cancelled failed)
```

### `automated_cleanup(repos, config_json)`

```bash
# automated_cleanup -- Periodic cleanup scan for archivable requests
#
# Arguments:
#   $1 -- config_json: Cleanup configuration JSON
#          {
#            "cleanup_retention_days": 30,   // monitor state retention
#            "cancelled_retention_days": 7,  // cancelled state retention
#            "delete_remote_branches": false  // whether to delete remote branches
#          }
#   Remaining args: repo paths
#
# Returns:
#   0 on success
#   1 on partial failure (some archives failed)
#
# Behavior per TDD Section 8.1:
#   1. Scan all repos for requests in terminal states
#   2. For each "monitor" request: archive if retention period exceeded
#   3. For each "cancelled" request: archive if 7+ days old
#   4. For each "failed" request: do NOT auto-archive (requires manual action)
#   5. Report disk space recovered
automated_cleanup() {
  local config_json="$1"
  shift
  local -a repos=("$@")

  local monitor_retention
  monitor_retention="$(echo "$config_json" | jq '.cleanup_retention_days // 30')"
  local cancelled_retention
  cancelled_retention="$(echo "$config_json" | jq '.cancelled_retention_days // 7')"
  local delete_branches
  delete_branches="$(echo "$config_json" | jq -r '.delete_remote_branches // "false"')"

  local archived_count=0
  local failed_count=0
  local space_recovered=0
  local timestamp
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  for repo in "${repos[@]}"; do
    local req_base="${repo}/.autonomous-dev/requests"
    [[ -d "$req_base" ]] || continue

    for req_dir in "${req_base}"/REQ-*/; do
      [[ -d "$req_dir" ]] || continue
      req_dir="${req_dir%/}"

      local state_json
      state_json="$(state_read "$req_dir" 2>/dev/null)" || continue

      local status
      status="$(echo "$state_json" | jq -r '.status')"

      local eligible=false

      case "$status" in
        monitor)
          # Check monitor retention
          local monitor_entered
          monitor_entered="$(_get_phase_entered_at "$state_json" "monitor")"
          if _is_past_retention "$monitor_entered" "$monitor_retention" "$timestamp"; then
            eligible=true
          fi
          ;;
        cancelled)
          # Check cancelled retention
          local cancelled_at
          cancelled_at="$(echo "$state_json" | jq -r '.updated_at')"
          if _is_past_retention "$cancelled_at" "$cancelled_retention" "$timestamp"; then
            eligible=true
          fi
          ;;
        # failed: never auto-archived
      esac

      if [[ "$eligible" == "true" ]]; then
        local request_id
        request_id="$(echo "$state_json" | jq -r '.id')"

        local dir_size
        dir_size="$(_dir_size_bytes "$req_dir")"

        if archive_request "$req_dir" "$state_json" "$delete_branches"; then
          (( archived_count++ ))
          (( space_recovered += dir_size ))
        else
          (( failed_count++ ))
        fi
      fi
    done
  done

  # Report
  _report_cleanup "$archived_count" "$failed_count" "$space_recovered"

  [[ $failed_count -eq 0 ]] && return 0 || return 1
}
```

### `archive_request(request_dir, state_json, delete_remote_branch)`

```bash
# archive_request -- Archive a single request per TDD Section 8.2
#
# Arguments:
#   $1 -- request_dir:          Absolute path to request directory
#   $2 -- state_json:           Current state JSON
#   $3 -- delete_remote_branch: "true" or "false"
#
# Returns:
#   0 on success
#   1 on failure (partial archive left intact, request dir NOT deleted)
#
# Procedure (TDD Section 8.2):
#   1. Create archive dir: ~/.autonomous-dev/archive/{request_id}/
#   2. Copy state.json and events.jsonl to archive dir
#   3. Compress to tarball
#   4. Remove uncompressed archive dir
#   5. Delete git worktree (if exists)
#   6. Optionally delete remote branch
#   7. Remove request directory
#   8. Log to archive.log
#
# Safety: If any step fails, stop immediately. Do NOT delete the request
# directory on partial failure. The request remains in place for retry.
archive_request() {
  local request_dir="$1"
  local state_json="$2"
  local delete_remote_branch="${3:-false}"

  local request_id
  request_id="$(echo "$state_json" | jq -r '.id')"
  local repository
  repository="$(echo "$state_json" | jq -r '.repository')"
  local worktree_path
  worktree_path="$(echo "$state_json" | jq -r '.worktree_path // empty')"
  local branch
  branch="$(echo "$state_json" | jq -r '.branch')"

  local timestamp
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Emit cleanup_started event
  _emit_cleanup_event "$request_dir" "$request_id" "cleanup_started" "$timestamp"

  # Step 1: Create archive directory
  local archive_req_dir="${ARCHIVE_DIR}/${request_id}"
  if ! mkdir -p "$archive_req_dir"; then
    echo "archive_request: failed to create archive dir: ${archive_req_dir}" >&2
    return 1
  fi
  chmod 0700 "$archive_req_dir"

  # Step 2: Copy state and events
  if ! cp -p "${request_dir}/state.json" "${archive_req_dir}/state.json" 2>/dev/null; then
    echo "archive_request: failed to copy state.json" >&2
    rm -rf "$archive_req_dir"
    return 1
  fi
  if [[ -f "${request_dir}/events.jsonl" ]]; then
    cp -p "${request_dir}/events.jsonl" "${archive_req_dir}/events.jsonl" 2>/dev/null || true
  fi

  # Step 3: Compress to tarball
  local tarball="${ARCHIVE_DIR}/${request_id}.tar.gz"
  if ! tar -czf "$tarball" -C "$ARCHIVE_DIR" "${request_id}/" 2>/dev/null; then
    echo "archive_request: failed to create tarball: ${tarball}" >&2
    rm -rf "$archive_req_dir"
    return 1
  fi
  chmod 0600 "$tarball"

  # Step 4: Remove uncompressed archive dir
  rm -rf "$archive_req_dir"

  # Step 5: Delete git worktree (if exists)
  if [[ -n "$worktree_path" && -d "$worktree_path" ]]; then
    if ! git -C "$repository" worktree remove "$worktree_path" --force 2>/dev/null; then
      echo "WARNING: Failed to remove worktree: ${worktree_path}" >&2
      # Continue -- worktree removal failure is non-fatal
    fi
  fi

  # Step 6: Optionally delete remote branch
  if [[ "$delete_remote_branch" == "true" && -n "$branch" ]]; then
    git -C "$repository" push origin --delete "$branch" 2>/dev/null || \
      echo "WARNING: Failed to delete remote branch: ${branch}" >&2
  fi

  # Step 7: Remove request directory
  rm -rf "$request_dir"

  # Step 8: Log to archive.log
  mkdir -p "$(dirname "$ARCHIVE_LOG")"
  printf '%s\t%s\t%s\t%s\n' "$timestamp" "$request_id" "$repository" "$tarball" >> "$ARCHIVE_LOG"

  # Emit cleanup_completed event (to the archive log since events.jsonl is gone)
  echo "INFO: Archived request ${request_id} to ${tarball}" >&2

  return 0
}
```

### `manual_cleanup(flags, repos)`

```bash
# manual_cleanup -- Manual cleanup command interface
#
# Arguments:
#   $1 -- flags_json: Command flags
#          {
#            "dry_run": bool,
#            "force": bool,
#            "request_id": string|null,
#            "delete_remote_branches": bool
#          }
#   Remaining args: repo paths
#
# Returns:
#   0 on success
#   1 on failure
manual_cleanup() {
  local flags_json="$1"
  shift
  local -a repos=("$@")

  local dry_run
  dry_run="$(echo "$flags_json" | jq -r '.dry_run // "false"')"
  local force
  force="$(echo "$flags_json" | jq -r '.force // "false"')"
  local target_request_id
  target_request_id="$(echo "$flags_json" | jq -r '.request_id // empty')"
  local delete_branches
  delete_branches="$(echo "$flags_json" | jq -r '.delete_remote_branches // "false"')"

  local -a candidates=()

  # Collect candidates
  for repo in "${repos[@]}"; do
    local req_base="${repo}/.autonomous-dev/requests"
    [[ -d "$req_base" ]] || continue

    for req_dir in "${req_base}"/REQ-*/; do
      [[ -d "$req_dir" ]] || continue
      req_dir="${req_dir%/}"

      local state_json
      state_json="$(state_read "$req_dir" 2>/dev/null)" || continue

      local request_id
      request_id="$(echo "$state_json" | jq -r '.id')"
      local status
      status="$(echo "$state_json" | jq -r '.status')"

      # If targeting specific request
      if [[ -n "$target_request_id" && "$request_id" != "$target_request_id" ]]; then
        continue
      fi

      # Check if terminal state
      local is_terminal=false
      for ts in "${TERMINAL_STATES[@]}"; do
        [[ "$status" == "$ts" ]] && is_terminal=true
      done

      if [[ "$is_terminal" == "false" ]]; then
        if [[ -n "$target_request_id" ]]; then
          echo "ERROR: Request ${request_id} is in active state '${status}', cannot archive" >&2
          return 1
        fi
        continue
      fi

      # If not force, check retention
      if [[ "$force" == "false" ]]; then
        # Apply normal retention rules
        local eligible=false
        case "$status" in
          monitor)
            local entered
            entered="$(_get_phase_entered_at "$state_json" "monitor")"
            _is_past_retention "$entered" "$DEFAULT_MONITOR_RETENTION_DAYS" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" && eligible=true
            ;;
          cancelled)
            local updated
            updated="$(echo "$state_json" | jq -r '.updated_at')"
            _is_past_retention "$updated" "$DEFAULT_CANCELLED_RETENTION_DAYS" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" && eligible=true
            ;;
          failed)
            eligible=true  # Failed requests are eligible for manual cleanup
            ;;
        esac
        [[ "$eligible" == "false" ]] && continue
      fi

      candidates+=("${req_dir}|${request_id}|${status}|$(echo "$state_json")")
    done
  done

  if [[ ${#candidates[@]} -eq 0 ]]; then
    echo "No requests eligible for cleanup."
    return 0
  fi

  # Dry run: list candidates
  if [[ "$dry_run" == "true" ]]; then
    echo "Dry run -- would archive ${#candidates[@]} request(s):"
    for c in "${candidates[@]}"; do
      IFS='|' read -r dir id status _ <<< "$c"
      local size
      size="$(_dir_size_human "$dir")"
      echo "  ${id}  status=${status}  size=${size}"
    done
    return 0
  fi

  # Archive candidates
  local archived=0 failed_count=0 space=0
  for c in "${candidates[@]}"; do
    IFS='|' read -r dir id status state_json <<< "$c"
    local dir_size
    dir_size="$(_dir_size_bytes "$dir")"

    if archive_request "$dir" "$state_json" "$delete_branches"; then
      (( archived++ ))
      (( space += dir_size ))
    else
      (( failed_count++ ))
    fi
  done

  _report_cleanup "$archived" "$failed_count" "$space"

  [[ $failed_count -eq 0 ]] && return 0 || return 1
}
```

### Helper Functions

```bash
# _get_phase_entered_at -- Get entered_at for a specific phase from history
_get_phase_entered_at() {
  local state_json="$1"
  local phase="$2"
  echo "$state_json" | jq -r \
    --arg phase "$phase" \
    '[.phase_history[] | select(.state == $phase)] | last | .entered_at // empty'
}

# _is_past_retention -- Check if a timestamp is older than retention days
_is_past_retention() {
  local timestamp="$1"
  local retention_days="$2"
  local current_timestamp="$3"

  [[ -z "$timestamp" ]] && return 1

  local ts_epoch current_epoch
  ts_epoch="$(_timestamp_to_epoch "$timestamp" 2>/dev/null || echo 0)"
  current_epoch="$(_timestamp_to_epoch "$current_timestamp" 2>/dev/null || echo "$(date -u +%s)")"

  local age_days=$(( (current_epoch - ts_epoch) / 86400 ))
  (( age_days >= retention_days ))
}

# _dir_size_bytes -- Get directory size in bytes
_dir_size_bytes() {
  local dir="$1"
  du -sk "$dir" 2>/dev/null | awk '{print $1 * 1024}'
}

# _dir_size_human -- Get directory size in human-readable format
_dir_size_human() {
  local dir="$1"
  du -sh "$dir" 2>/dev/null | awk '{print $1}'
}

# _report_cleanup -- Print disk space accounting report (TDD Section 8.4)
_report_cleanup() {
  local archived="$1"
  local failed="$2"
  local space_bytes="$3"

  local space_human
  if (( space_bytes > 1073741824 )); then
    space_human="$(echo "scale=1; $space_bytes / 1073741824" | bc) GB"
  elif (( space_bytes > 1048576 )); then
    space_human="$(echo "scale=1; $space_bytes / 1048576" | bc) MB"
  elif (( space_bytes > 1024 )); then
    space_human="$(echo "scale=1; $space_bytes / 1024" | bc) KB"
  else
    space_human="${space_bytes} bytes"
  fi

  echo ""
  echo "Cleanup complete:"
  echo "  Archived: ${archived} request(s)"
  echo "  Failed: ${failed}"
  echo "  Space recovered: ${space_human}"
}

# _emit_cleanup_event -- Append cleanup event to request's event log
_emit_cleanup_event() {
  local request_dir="$1"
  local request_id="$2"
  local event_type="$3"
  local timestamp="$4"

  local event
  event="$(jq -n \
    --arg ts "$timestamp" \
    --arg et "$event_type" \
    --arg rid "$request_id" \
    '{timestamp: $ts, event_type: $et, request_id: $rid, from_state: null, to_state: null, session_id: null, metadata: {}}')"
  event_append "${request_dir}/events.jsonl" "$event" 2>/dev/null || true
}
```

## Acceptance Criteria
1. [ ] `automated_cleanup()` archives `monitor` requests past retention period
2. [ ] `automated_cleanup()` archives `cancelled` requests past 7 days
3. [ ] `automated_cleanup()` never archives active requests
4. [ ] `automated_cleanup()` never auto-archives `failed` requests
5. [ ] `automated_cleanup()` is idempotent (running twice produces same result)
6. [ ] `archive_request()` creates tarball at `~/.autonomous-dev/archive/{request_id}.tar.gz`
7. [ ] Tarball contains `state.json` and `events.jsonl`
8. [ ] Git worktree is removed if it exists (warning on failure, not fatal)
9. [ ] Remote branch deletion is configurable (off by default)
10. [ ] Request directory is removed after successful archival
11. [ ] Entry is appended to `archive.log` with timestamp, request_id, repo, tarball path
12. [ ] If any step fails, request directory is NOT deleted (safe partial failure)
13. [ ] `manual_cleanup --dry-run` lists candidates without acting, shows sizes
14. [ ] `manual_cleanup --force` archives all terminal requests regardless of age
15. [ ] `manual_cleanup --request {id}` archives specific request only if terminal
16. [ ] Attempting to archive active request via `--request` returns error
17. [ ] Disk space accounting report follows TDD Section 8.4 format

## Test Cases
1. **Auto-cleanup archives old monitor** -- Request in `monitor` for 31 days. Assertion: archived.
2. **Auto-cleanup skips recent monitor** -- Request in `monitor` for 5 days. Assertion: not archived.
3. **Auto-cleanup archives old cancelled** -- Cancelled 8 days ago. Assertion: archived.
4. **Auto-cleanup skips active** -- Request in `code`. Assertion: not archived.
5. **Auto-cleanup skips failed** -- Request in `failed`. Assertion: not archived.
6. **Archive creates tarball** -- Call `archive_request`. Assertion: `.tar.gz` exists in archive dir.
7. **Archive tarball contents** -- Extract tarball. Assertion: contains `state.json` and `events.jsonl`.
8. **Archive removes request dir** -- After archive. Assertion: original dir gone.
9. **Archive logs to archive.log** -- After archive. Assertion: `archive.log` has entry.
10. **Archive partial failure** -- Make tarball creation fail (e.g., read-only archive dir). Assertion: request dir NOT deleted.
11. **Archive worktree removal** -- Request with worktree_path set. Assertion: worktree removal attempted.
12. **Dry run lists candidates** -- `--dry-run` with eligible requests. Assertion: output lists requests with sizes, no files modified.
13. **Force archives all terminal** -- `--force` with recent terminal requests. Assertion: all archived regardless of age.
14. **Request-specific archive** -- `--request REQ-xxx` with terminal request. Assertion: only that request archived.
15. **Request-specific active rejected** -- `--request REQ-xxx` with active request. Assertion: returns 1, error message.
16. **Idempotency** -- Run `automated_cleanup` twice. Assertion: second run finds nothing to archive.
17. **Disk space report** -- After archiving 3 requests. Assertion: report shows count and space recovered.
