# SPEC-010-4-01: Retention Age Calculation & Request Archival

## Metadata
- **Parent Plan**: PLAN-010-4
- **Tasks Covered**: Task 1, Task 2, Task 3
- **Estimated effort**: 8 hours

## Description

Implement per-artifact-type retention age calculation for all 10 artifact types, request archival as gzipped tarballs containing `state.json` and `events.jsonl`, and safe request state directory cleanup with archive verification.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Create | `lib/cleanup_engine.sh` | Retention calculation, archival, state directory cleanup |

## Implementation Details

### Retention Age Calculation

**`is_artifact_expired()`** -- Core function that determines if an artifact has exceeded its retention period.

```bash
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
```

**`get_artifact_age_days()`** -- Computes artifact age using the correct timestamp source:

```bash
get_artifact_age_days() {
  local artifact_type="$1"
  local artifact_path="$2"
  
  local artifact_epoch
  
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
```

**`date_to_epoch()`** -- Cross-platform ISO 8601 to epoch conversion:

```bash
date_to_epoch() {
  local iso_date="$1"
  if [[ "$(uname)" == "Darwin" ]]; then
    date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$iso_date" +%s 2>/dev/null || echo "0"
  else
    date -u -d "$iso_date" +%s 2>/dev/null || echo "0"
  fi
}
```

**Retention periods by artifact type** (mapped from config):

| Artifact Type | Config Key | Default | Time Source |
|---|---|---|---|
| Request state dirs | `retention.completed_request_days` | 30 | `state.json` `updated_at` |
| Event logs | `retention.event_log_days` | 90 | file mtime |
| Cost ledger (monthly) | `retention.cost_ledger_months` | 12 | filename `YYYY-MM` |
| Daemon logs | `retention.daemon_log_days` | 30 | file mtime |
| Observation reports | `retention.observation_report_days` | 90 | JSON `created_at` |
| Observation archives | `retention.observation_archive_days` | 365 | file mtime |
| Git worktrees | `parallel.worktree_cleanup_delay_seconds` | 300 | completion time |
| Remote branches | N/A (cleanup on archival) | N/A | archival event |
| Archived requests | `retention.archive_days` | 365 | file mtime |
| Config validation logs | `retention.config_validation_log_days` | 7 | file mtime |

### Request Archival

**`archive_request()`** -- Creates a gzipped tarball for a completed request:

```bash
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
  local files_to_archive=("state.json")
  if [[ -f "${request_dir}/events.jsonl" ]]; then
    files_to_archive+=("events.jsonl")
  fi
  
  # Create tarball from the request directory
  local tmp_archive="${archive_path}.tmp.$$"
  if ! tar -czf "$tmp_archive" -C "$(dirname "$request_dir")" \
    "${request_id}/state.json" \
    $(test -f "${request_dir}/events.jsonl" && echo "${request_id}/events.jsonl") \
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
```

**Archive format**:
```
~/.autonomous-dev/archive/REQ-20260408-a3f1.tar.gz
  -> REQ-20260408-a3f1/state.json
  -> REQ-20260408-a3f1/events.jsonl   (if exists)
```

Verification command: `tar -tzf REQ-20260408-a3f1.tar.gz` lists exactly those two files (or one if events.jsonl is missing).

### Request State Directory Cleanup

**`cleanup_request_dir()`** -- Deletes the request state directory after verifying the archive:

```bash
cleanup_request_dir() {
  local request_dir="$1"
  local request_id
  request_id=$(basename "$request_dir")
  
  local archive_path="${HOME}/.autonomous-dev/archive/${request_id}.tar.gz"
  
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
```

**Safety invariant**: The state directory is NEVER deleted unless the archive file exists AND is a valid gzip tarball. This is the fail-safe guarantee.

## Acceptance Criteria

1. Age calculation correctly computes days since `updated_at` for requests (using JSON field, not filesystem mtime).
2. Age calculation uses file mtime for log files and archives.
3. Age calculation uses `created_at` JSON field for observation reports.
4. All 10 artifact types are mapped to their correct retention config keys.
5. Cross-platform support: macOS `stat -f "%m"` and Linux `stat -c "%Y"`.
6. Timezone handling: all calculations use UTC.
7. Archive contains exactly `state.json` and `events.jsonl` (and nothing else).
8. Archive is a valid `.tar.gz` file (verified with `tar -tzf`).
9. Archive naming matches `REQ-{id}.tar.gz`.
10. If archive already exists, skip (idempotent, no error).
11. Archive directory `~/.autonomous-dev/archive/` is created if it does not exist.
12. Missing `events.jsonl` is handled gracefully (archive contains only `state.json`).
13. State directory is removed only after archive is confirmed to exist and is valid.
14. If archival failed, state directory is NOT deleted (fail-safe).
15. `tar` failure is logged and the cleanup item is skipped (retry next cycle).
16. Already-deleted directories are handled gracefully (idempotent).

## Test Cases

1. **Request age from updated_at**: `updated_at` is 31 days ago. Retention is 30 days. Returns expired.
2. **Request age within retention**: `updated_at` is 29 days ago. Retention is 30 days. Returns not expired.
3. **Request age exactly at boundary**: `updated_at` is 30 days ago. Returns not expired (must exceed, not equal).
4. **Log age from mtime**: File mtime is 31 days ago. Retention is 30 days. Returns expired.
5. **Observation age from created_at**: JSON `created_at` is 91 days ago. Retention is 90. Expired.
6. **Missing timestamp fallback**: `state.json` has no `updated_at`. Falls back to file mtime.
7. **Archive creation**: Request dir has `state.json` and `events.jsonl`. Archive created. `tar -tzf` lists both files.
8. **Archive without events.jsonl**: Request dir has only `state.json`. Archive contains only `state.json`.
9. **Archive idempotent**: Call `archive_request` twice. Second call skips, no error.
10. **Archive directory created**: `~/.autonomous-dev/archive/` does not exist. Created automatically.
11. **tar failure**: Simulate `tar` failure (e.g., permissions). Returns 1, logs error.
12. **Cleanup after archival**: Archive exists and is valid. State directory is deleted.
13. **Cleanup without archive**: Archive does not exist. State directory is NOT deleted. Returns 1.
14. **Cleanup with corrupt archive**: Archive exists but is not a valid tar.gz. State directory is NOT deleted.
15. **Cleanup idempotent**: State directory already deleted. Returns 0 (or is harmless).
16. **Cost ledger retention by months**: Archive file `cost-ledger-2025-03.jsonl` is 13 months old. Retention is 12 months. Expired.
