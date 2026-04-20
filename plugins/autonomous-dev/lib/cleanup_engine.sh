#!/usr/bin/env bash
# cleanup_engine.sh -- Retention age calculation, request archival, state directory cleanup,
#                      worktree cleanup, remote branch deletion, log rotation, observation
#                      lifecycle, tarball pruning, and cleanup orchestrator
# Part of SPEC-010-4-01: Retention Age Calculation & Request Archival
# Part of SPEC-010-4-02: Worktree Cleanup & Remote Branch Deletion
# Part of SPEC-010-4-03: Cost Ledger Rotation, Log Rotation, and Observation Lifecycle
# Part of SPEC-010-4-04: Cleanup Orchestrator, Automatic Trigger, and CLI Command
#
# Dependencies: jq (1.6+), tar, gzip, git, bash 4+
#
# Usage:
#   source cleanup_engine.sh
#   is_artifact_expired "request" "/path/to/REQ-dir" "$effective_config"
#   archive_request "/path/to/REQ-dir"
#   cleanup_request_dir "/path/to/REQ-dir"
#   find_worktree_for_request "/path/to/repo" "REQ-20260408-a3f1"
#   cleanup_worktree "/path/to/repo" "REQ-20260408-a3f1" "/path/to/REQ-dir" "$effective_config"
#   cleanup_remote_branch "/path/to/repo" "REQ-20260408-a3f1" "$effective_config"
#   rotate_daemon_logs "$effective_config"
#   rotate_config_validation_logs "$effective_config"
#   cleanup_observations "/path/to/repo" "$effective_config"
#   prune_archived_requests "$effective_config"
#   cleanup_run "$effective_config" [true|false]

set -euo pipefail

# Source guard
if [[ -n "${_CLEANUP_ENGINE_LOADED:-}" ]]; then return 0 2>/dev/null || true; fi
_CLEANUP_ENGINE_LOADED=1

# ---------------------------------------------------------------------------
# Resolve PLUGIN_ROOT for sourcing sibling libraries
# ---------------------------------------------------------------------------
if [[ -z "${PLUGIN_ROOT:-}" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# ---------------------------------------------------------------------------
# Logging helpers (write to stderr so stdout stays clean for data output)
# Only define if not already defined (e.g., when sourced by another script)
# ---------------------------------------------------------------------------
if ! declare -F log_error >/dev/null 2>&1; then
  log_error() {
    local tag="$1"; shift
    echo "[${tag}] ERROR: $*" >&2
  }
fi

if ! declare -F log_warning >/dev/null 2>&1; then
  log_warning() {
    local tag="$1"; shift
    echo "[${tag}] WARNING: $*" >&2
  }
fi

if ! declare -F log_info >/dev/null 2>&1; then
  log_info() {
    local tag="$1"; shift
    echo "[${tag}] INFO: $*" >&2
  }
fi

# =============================================================================
# Timestamp Utilities
# =============================================================================

# date_to_epoch -- Cross-platform ISO 8601 to epoch conversion
#
# Arguments:
#   $1 -- iso_date: ISO 8601 timestamp string (e.g., "2026-04-08T09:15:00Z")
#
# Stdout:
#   Epoch seconds as integer, or "0" on parse failure
date_to_epoch() {
  local iso_date="$1"
  if [[ "$(uname)" == "Darwin" ]]; then
    date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$iso_date" +%s 2>/dev/null || echo "0"
  else
    date -u -d "$iso_date" +%s 2>/dev/null || echo "0"
  fi
}

# =============================================================================
# Artifact Age Calculation
# =============================================================================

# get_artifact_age_days -- Compute artifact age using the correct timestamp source
#
# Arguments:
#   $1 -- artifact_type: One of request|event_log|daemon_log|observation|
#                        observation_archive|archive|config_validation_log
#   $2 -- artifact_path: Path to the artifact file or directory
#
# Stdout:
#   Age in whole days (integer)
#
# Timestamp source rules:
#   - request:     state.json updated_at (or created_at), fallback to file mtime
#   - observation:  JSON created_at, fallback to file mtime
#   - all others:  file modification time (mtime)
get_artifact_age_days() {
  local artifact_type="$1"
  local artifact_path="$2"

  local artifact_epoch=""

  case "$artifact_type" in
    request)
      # Use updated_at from state.json (not filesystem mtime)
      local state_file="${artifact_path}/state.json"
      if [[ -f "$state_file" ]]; then
        local updated_at
        updated_at=$(jq -r '.updated_at // .created_at // empty' "$state_file" 2>/dev/null)
        if [[ -n "$updated_at" ]]; then
          artifact_epoch=$(date_to_epoch "$updated_at")
        fi
      fi
      ;;
    observation)
      # Use created_at from the observation JSON
      if [[ -f "$artifact_path" ]]; then
        local created_at
        created_at=$(jq -r '.created_at // empty' "$artifact_path" 2>/dev/null)
        if [[ -n "$created_at" ]]; then
          artifact_epoch=$(date_to_epoch "$created_at")
        fi
      fi
      ;;
    *)
      # Use file modification time for logs and archives
      ;;
  esac

  # Fallback to filesystem mtime
  if [[ -z "$artifact_epoch" ]] || [[ "$artifact_epoch" == "0" ]]; then
    if [[ "$(uname)" == "Darwin" ]]; then
      artifact_epoch=$(stat -f "%m" "$artifact_path" 2>/dev/null)
    else
      artifact_epoch=$(stat -c "%Y" "$artifact_path" 2>/dev/null)
    fi
  fi

  if [[ -z "$artifact_epoch" ]]; then
    echo "0"
    return 0
  fi

  local now_epoch
  now_epoch=$(date -u +%s)
  local age_seconds=$((now_epoch - artifact_epoch))
  local age_days=$((age_seconds / 86400))

  echo "$age_days"
}

# is_artifact_expired -- Determine if an artifact has exceeded its retention period
#
# Arguments:
#   $1 -- artifact_type:    One of request|event_log|daemon_log|observation|
#                           observation_archive|archive|config_validation_log
#   $2 -- artifact_path:    Path to the artifact file or directory
#   $3 -- effective_config: Merged config JSON string
#
# Returns:
#   0 if expired (age > retention_days)
#   1 if not expired (age <= retention_days) or on error
#
# Retention config keys by artifact type:
#   request              -> retention.completed_request_days  (default 30)
#   event_log            -> retention.event_log_days          (default 90)
#   daemon_log           -> retention.daemon_log_days         (default 30)
#   observation          -> retention.observation_report_days (default 90)
#   observation_archive  -> retention.observation_archive_days(default 365)
#   archive              -> retention.archive_days            (default 365)
#   config_validation_log-> retention.config_validation_log_days (default 7)
is_artifact_expired() {
  local artifact_type="$1"    # request|event_log|daemon_log|observation|observation_archive|archive|config_validation_log
  local artifact_path="$2"    # path to the artifact file or directory
  local effective_config="$3" # merged config JSON

  local retention_days
  case "$artifact_type" in
    request)
      retention_days=$(echo "$effective_config" | jq -r '.retention.completed_request_days')
      ;;
    event_log)
      retention_days=$(echo "$effective_config" | jq -r '.retention.event_log_days')
      ;;
    daemon_log)
      retention_days=$(echo "$effective_config" | jq -r '.retention.daemon_log_days')
      ;;
    observation)
      retention_days=$(echo "$effective_config" | jq -r '.retention.observation_report_days')
      ;;
    observation_archive)
      retention_days=$(echo "$effective_config" | jq -r '.retention.observation_archive_days')
      ;;
    archive)
      retention_days=$(echo "$effective_config" | jq -r '.retention.archive_days')
      ;;
    config_validation_log)
      retention_days=$(echo "$effective_config" | jq -r '.retention.config_validation_log_days')
      ;;
    *)
      log_error "cleanup_engine" "Unknown artifact type: $artifact_type"
      return 1
      ;;
  esac

  local age_days
  age_days=$(get_artifact_age_days "$artifact_type" "$artifact_path")

  if (( age_days > retention_days )); then
    return 0  # Expired
  fi
  return 1  # Not expired
}

# =============================================================================
# Request Archival
# =============================================================================

# archive_request -- Create a gzipped tarball for a completed request
#
# Arguments:
#   $1 -- request_dir: Absolute path to request directory
#                      (e.g., /repo/.autonomous-dev/requests/REQ-20260408-a3f1/)
#
# Returns:
#   0 on success (archive created or already exists)
#   1 on failure (tar error, missing state.json, etc.)
#
# Archive format:
#   ~/.autonomous-dev/archive/REQ-{id}.tar.gz
#     -> REQ-{id}/state.json
#     -> REQ-{id}/events.jsonl   (if exists)
#
# Behavior:
#   - Idempotent: if archive already exists, skips silently (returns 0)
#   - Creates ~/.autonomous-dev/archive/ if it does not exist
#   - Only includes state.json and events.jsonl (no other artifacts)
#   - Uses atomic write (tmp file + mv) to prevent partial archives
#   - On tar failure, cleans up temp file and returns 1
archive_request() {
  local request_dir="$1"  # e.g., /repo/.autonomous-dev/requests/REQ-20260408-a3f1/
  local request_id
  request_id=$(basename "$request_dir")

  local archive_dir="${HOME}/.autonomous-dev/archive"
  mkdir -p "$archive_dir"

  local archive_path="${archive_dir}/${request_id}.tar.gz"

  # Skip if archive already exists (idempotent)
  if [[ -f "$archive_path" ]]; then
    log_info "cleanup_engine" "Archive already exists: $archive_path (skipping)"
    return 0
  fi

  # Verify state.json exists
  local state_file="${request_dir}/state.json"
  if [[ ! -f "$state_file" ]]; then
    log_error "cleanup_engine" "Cannot archive: state.json not found in $request_dir"
    return 1
  fi

  # Build the tarball
  # Include: state.json, events.jsonl (if exists)
  # Exclude: everything else (working artifacts, code snapshots, etc.)
  local files_to_archive=("${request_id}/state.json")
  if [[ -f "${request_dir}/events.jsonl" ]]; then
    files_to_archive+=("${request_id}/events.jsonl")
  fi

  # Create tarball from the request directory's parent
  local tmp_archive="${archive_path}.tmp.$$"
  if ! tar -czf "$tmp_archive" -C "$(dirname "$request_dir")" \
    "${files_to_archive[@]}" \
    2>/dev/null; then
    log_error "cleanup_engine" "tar failed for $request_id. Skipping archival."
    rm -f "$tmp_archive"
    return 1
  fi

  # Atomic move
  mv "$tmp_archive" "$archive_path" || {
    log_error "cleanup_engine" "Failed to move archive to final path: $archive_path"
    rm -f "$tmp_archive"
    return 1
  }

  log_info "cleanup_engine" "Archived $request_id to $archive_path"
  return 0
}

# =============================================================================
# Request State Directory Cleanup
# =============================================================================

# cleanup_request_dir -- Delete request state directory after verifying archive
#
# Arguments:
#   $1 -- request_dir: Absolute path to request directory
#
# Returns:
#   0 on success (directory deleted, or already absent)
#   1 on failure (archive missing/corrupt, or deletion failed)
#
# Safety invariant:
#   The state directory is NEVER deleted unless the archive file exists AND
#   is a valid gzip tarball. This is the fail-safe guarantee.
cleanup_request_dir() {
  local request_dir="$1"
  local request_id
  request_id=$(basename "$request_dir")

  local archive_path="${HOME}/.autonomous-dev/archive/${request_id}.tar.gz"

  # Handle already-deleted directories gracefully (idempotent)
  if [[ ! -d "$request_dir" ]]; then
    log_info "cleanup_engine" "State directory already absent: $request_dir (idempotent)"
    return 0
  fi

  # SAFETY: Do not delete unless archive exists
  if [[ ! -f "$archive_path" ]]; then
    log_error "cleanup_engine" "SAFETY: Archive not found for $request_id. Refusing to delete state directory."
    return 1
  fi

  # Verify archive is readable
  if ! tar -tzf "$archive_path" >/dev/null 2>&1; then
    log_error "cleanup_engine" "SAFETY: Archive is corrupt for $request_id. Refusing to delete state directory."
    return 1
  fi

  # Delete the state directory
  rm -rf "$request_dir"

  if [[ -d "$request_dir" ]]; then
    log_error "cleanup_engine" "Failed to delete state directory: $request_dir"
    return 1
  fi

  log_info "cleanup_engine" "Deleted state directory: $request_dir"
  return 0
}

# =============================================================================
# Worktree Cleanup (SPEC-010-4-02)
# =============================================================================

# find_worktree_for_request -- Locate the worktree path by request ID
#
# Arguments:
#   $1 -- repo_path:  Absolute path to the main git repository
#   $2 -- request_id: Request identifier (e.g., "REQ-20260408-a3f1")
#
# Stdout:
#   Absolute path to the worktree if found, empty string otherwise
#
# Returns:
#   0 if a matching worktree was found
#   1 if no matching worktree exists
#
# Convention: worktree branch is named autonomous/REQ-{id}
# Uses git worktree list --porcelain to find the path.
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

# cleanup_worktree -- Remove the git worktree associated with a completed request
#
# Arguments:
#   $1 -- repo_path:        Absolute path to the main git repository
#   $2 -- request_id:       Request identifier (e.g., "REQ-20260408-a3f1")
#   $3 -- request_dir:      Absolute path to the request state directory
#   $4 -- effective_config: Merged config JSON string
#
# Returns:
#   0 on success (worktree removed, or nothing to do)
#   1 on failure (force removal failed, flagged for manual intervention)
#
# Behavior:
#   - Only acts on terminal-status requests (completed|cancelled|failed)
#   - Respects parallel.worktree_cleanup_delay_seconds (default 300)
#   - Attempts normal removal first, then force removal
#   - On total failure, logs to ~/.autonomous-dev/manual-cleanup-needed.txt
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

# =============================================================================
# Remote Branch Deletion (SPEC-010-4-02)
# =============================================================================

# cleanup_remote_branch -- Delete the remote branch for an archived request
#
# Arguments:
#   $1 -- repo_path:        Absolute path to the main git repository
#   $2 -- request_id:       Request identifier (e.g., "REQ-20260408-a3f1")
#   $3 -- effective_config: Merged config JSON string
#
# Returns:
#   0 on success (branch deleted, already absent, or deletion disabled)
#   1 on failure (git push --delete failed)
#
# Behavior:
#   - Gated by cleanup.delete_remote_branches config flag (must be "true")
#   - Branch name follows convention: autonomous/REQ-{id}
#   - Checks remote branch existence before attempting deletion
#   - Failure is logged as warning; does not block other cleanup operations
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

# =============================================================================
# Daemon Log Rotation (SPEC-010-4-03)
# =============================================================================

# rotate_daemon_logs -- Delete daemon logs older than retention
#
# Arguments:
#   $1 -- effective_config: Merged config JSON string
#
# Returns:
#   0 always
rotate_daemon_logs() {
  local effective_config="$1"

  local log_dir="${HOME}/.autonomous-dev/logs"
  [[ -d "$log_dir" ]] || return 0

  local pruned=0
  for log_file in "$log_dir"/daemon*.log "$log_dir"/daemon*.log.[0-9]*; do
    [[ -f "$log_file" ]] || continue

    if is_artifact_expired "daemon_log" "$log_file" "$effective_config"; then
      rm -f "$log_file"
      log_info "cleanup_engine" "Deleted old daemon log: $log_file"
      ((pruned++))
    fi
  done

  log_info "cleanup_engine" "Rotated $pruned daemon log(s)"
  return 0
}

# =============================================================================
# Config Validation Log Rotation (SPEC-010-4-03)
# =============================================================================

# rotate_config_validation_logs -- Delete config validation logs older than retention
#
# Arguments:
#   $1 -- effective_config: Merged config JSON string
#
# Returns:
#   0 always
rotate_config_validation_logs() {
  local effective_config="$1"

  local log_file="${HOME}/.autonomous-dev/logs/config-validation.log"

  if [[ -f "$log_file" ]] && is_artifact_expired "config_validation_log" "$log_file" "$effective_config"; then
    rm -f "$log_file"
    log_info "cleanup_engine" "Deleted old config validation log: $log_file"
  fi

  return 0
}

# =============================================================================
# Observation Report Lifecycle (SPEC-010-4-03)
# =============================================================================

# cleanup_observations -- Manage the active -> archive -> delete lifecycle
#
# Arguments:
#   $1 -- repo_path:        Absolute path to the repository
#   $2 -- effective_config: Merged config JSON string
#
# Behavior:
#   Phase 1: Move active observations past retention to archive/
#   Phase 2: Delete archived observations past archive retention
#
# Returns:
#   0 always
cleanup_observations() {
  local repo_path="$1"
  local effective_config="$2"

  local obs_dir="${repo_path}/.autonomous-dev/observations"
  [[ -d "$obs_dir" ]] || return 0

  local archive_dir="${obs_dir}/archive"
  local moved=0
  local deleted=0

  # Phase 1: Move active observations past retention to archive
  for obs_file in "$obs_dir"/*.json; do
    [[ -f "$obs_file" ]] || continue
    [[ "$obs_file" == *"/archive/"* ]] && continue  # Skip already-archived

    if is_artifact_expired "observation" "$obs_file" "$effective_config"; then
      mkdir -p "$archive_dir"
      local obs_basename
      obs_basename=$(basename "$obs_file")

      if mv "$obs_file" "${archive_dir}/${obs_basename}" 2>/dev/null; then
        log_info "cleanup_engine" "Archived observation: $obs_basename"
        ((moved++))
      else
        log_warning "cleanup_engine" "Failed to archive observation: $obs_file"
      fi
    fi
  done

  # Phase 2: Delete archived observations past archive retention
  if [[ -d "$archive_dir" ]]; then
    for obs_file in "$archive_dir"/*.json; do
      [[ -f "$obs_file" ]] || continue

      if is_artifact_expired "observation_archive" "$obs_file" "$effective_config"; then
        rm -f "$obs_file"
        log_info "cleanup_engine" "Deleted archived observation: $(basename "$obs_file")"
        ((deleted++))
      fi
    done
  fi

  log_info "cleanup_engine" "Observations: $moved archived, $deleted deleted"
  return 0
}

# cleanup_observations_dry_run -- Dry-run mode: report what would be cleaned
#
# Arguments:
#   $1 -- repo_path:        Absolute path to the repository
#   $2 -- effective_config: Merged config JSON string
#
# Stdout:
#   DRY-RUN messages for each observation that would be affected
#
# Returns:
#   0 always
cleanup_observations_dry_run() {
  local repo_path="$1"
  local effective_config="$2"

  local obs_dir="${repo_path}/.autonomous-dev/observations"
  [[ -d "$obs_dir" ]] || return 0

  local archive_dir="${obs_dir}/archive"

  # Phase 1: Check active observations
  for obs_file in "$obs_dir"/*.json; do
    [[ -f "$obs_file" ]] || continue
    [[ "$obs_file" == *"/archive/"* ]] && continue

    if is_artifact_expired "observation" "$obs_file" "$effective_config"; then
      local age
      age=$(get_artifact_age_days "observation" "$obs_file")
      echo "DRY-RUN: Would archive observation $(basename "$obs_file") ($age days old)"
    fi
  done

  # Phase 2: Check archived observations
  if [[ -d "$archive_dir" ]]; then
    for obs_file in "$archive_dir"/*.json; do
      [[ -f "$obs_file" ]] || continue

      if is_artifact_expired "observation_archive" "$obs_file" "$effective_config"; then
        local age
        age=$(get_artifact_age_days "observation_archive" "$obs_file")
        echo "DRY-RUN: Would delete archived observation $(basename "$obs_file") ($age days old)"
      fi
    done
  fi

  return 0
}

# =============================================================================
# Archived Request Tarball Pruning (SPEC-010-4-03)
# =============================================================================

# prune_archived_requests -- Delete old tarballs from ~/.autonomous-dev/archive/
#
# Arguments:
#   $1 -- effective_config: Merged config JSON string
#
# Returns:
#   0 always
prune_archived_requests() {
  local effective_config="$1"

  local archive_dir="${HOME}/.autonomous-dev/archive"
  [[ -d "$archive_dir" ]] || return 0

  local pruned=0
  for tarball in "$archive_dir"/REQ-*.tar.gz; do
    [[ -f "$tarball" ]] || continue

    if is_artifact_expired "archive" "$tarball" "$effective_config"; then
      rm -f "$tarball"
      log_info "cleanup_engine" "Pruned archived request: $(basename "$tarball")"
      ((pruned++))
    fi
  done

  log_info "cleanup_engine" "Pruned $pruned archived request tarball(s)"
  return 0
}

# =============================================================================
# Dry-Run Counting Helpers (SPEC-010-4-04)
# =============================================================================

# count_expired_logs -- Dry-run counter for expired log files
#
# Arguments:
#   $1 -- artifact_type: "daemon_log" or "config_validation_log"
#   $2 -- effective_config: Merged config JSON string
count_expired_logs() {
  local artifact_type="$1"
  local effective_config="$2"

  local log_dir="${HOME}/.autonomous-dev/logs"
  [[ -d "$log_dir" ]] || return 0

  case "$artifact_type" in
    daemon_log)
      for log_file in "$log_dir"/daemon*.log "$log_dir"/daemon*.log.[0-9]*; do
        [[ -f "$log_file" ]] || continue
        if is_artifact_expired "daemon_log" "$log_file" "$effective_config"; then
          local age
          age=$(get_artifact_age_days "daemon_log" "$log_file")
          echo "DRY-RUN: Would delete daemon log $(basename "$log_file") ($age days old)"
        fi
      done
      ;;
    config_validation_log)
      local log_file="${log_dir}/config-validation.log"
      if [[ -f "$log_file" ]] && is_artifact_expired "config_validation_log" "$log_file" "$effective_config"; then
        local age
        age=$(get_artifact_age_days "config_validation_log" "$log_file")
        echo "DRY-RUN: Would delete config validation log ($age days old)"
      fi
      ;;
  esac

  return 0
}

# count_expired_ledger_archives -- Dry-run counter for expired cost ledger archives
#
# Arguments:
#   $1 -- effective_config: Merged config JSON string
count_expired_ledger_archives() {
  local effective_config="$1"

  local retention_months
  retention_months=$(echo "$effective_config" | jq -r '.retention.cost_ledger_months')

  local archive_dir="${HOME}/.autonomous-dev"

  local cutoff_month
  if [[ "$(uname)" == "Darwin" ]]; then
    cutoff_month=$(date -u -v "-${retention_months}m" +"%Y-%m")
  else
    cutoff_month=$(date -u -d "-${retention_months} months" +"%Y-%m")
  fi

  for archive_file in "$archive_dir"/cost-ledger-[0-9][0-9][0-9][0-9]-[0-9][0-9].jsonl; do
    [[ -f "$archive_file" ]] || continue

    local file_month
    file_month=$(basename "$archive_file" | sed 's/cost-ledger-\([0-9]\{4\}-[0-9]\{2\}\)\.jsonl/\1/')

    if [[ "$file_month" < "$cutoff_month" ]]; then
      echo "DRY-RUN: Would delete cost ledger archive $(basename "$archive_file")"
    fi
  done

  return 0
}

# count_expired_tarballs -- Dry-run counter for expired archived request tarballs
#
# Arguments:
#   $1 -- effective_config: Merged config JSON string
count_expired_tarballs() {
  local effective_config="$1"

  local archive_dir="${HOME}/.autonomous-dev/archive"
  [[ -d "$archive_dir" ]] || return 0

  for tarball in "$archive_dir"/REQ-*.tar.gz; do
    [[ -f "$tarball" ]] || continue

    if is_artifact_expired "archive" "$tarball" "$effective_config"; then
      local age
      age=$(get_artifact_age_days "archive" "$tarball")
      echo "DRY-RUN: Would prune archived request $(basename "$tarball") ($age days old)"
    fi
  done

  return 0
}

# =============================================================================
# Cleanup Orchestrator (SPEC-010-4-04)
# =============================================================================

# cleanup_run -- Top-level orchestrator that runs all cleanup sub-tasks
#
# Arguments:
#   $1 -- effective_config: Merged config JSON string
#   $2 -- dry_run:          "true" for dry-run mode, "false" for real cleanup
#
# Stdout:
#   JSON summary with counts for each artifact type and timing
#
# Returns:
#   0 on success (no errors)
#   1 if any cleanup item failed
#
# Execution order (per TDD-010 Section 3.7.3):
#   1. Requests: archive -> worktree remove -> branch delete -> state dir delete
#   2. Observations: active -> archive -> delete
#   3. Daemon logs: delete
#   4. Config validation logs: delete
#   5. Cost ledger: rotate -> prune archives
#   6. Archived request tarballs: prune
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

  # Source ledger_rotation if not already loaded
  if ! declare -F rotate_cost_ledger >/dev/null 2>&1; then
    source "${PLUGIN_ROOT}/lib/ledger_rotation.sh"
  fi

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

        if is_artifact_expired "request" "$req_dir" "$effective_config"; then
          local request_id
          request_id=$(basename "$req_dir")

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
              else
                log_error "cleanup_engine" "Worktree removal failed for $request_id. Flagged for manual intervention."
                ((errors++))
              fi

              # Remote branch cleanup
              if cleanup_remote_branch "$repo" "$request_id" "$effective_config"; then
                ((branches_deleted++))
              else
                log_warning "cleanup_engine" "Branch deletion failed for $request_id. Non-critical, continuing."
                ((errors++))
              fi

              # Delete state directory
              if cleanup_request_dir "$req_dir"; then
                ((requests_deleted++))
              else
                ((errors++))
              fi
            else
              log_error "cleanup_engine" "Archive failed for $request_id. Skipping. Will retry next cycle."
              ((errors++))
            fi
          fi
        fi
      done
    fi

    # 1b. Observation cleanup
    if [[ "$dry_run" == "true" ]]; then
      cleanup_observations_dry_run "$repo" "$effective_config"
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
