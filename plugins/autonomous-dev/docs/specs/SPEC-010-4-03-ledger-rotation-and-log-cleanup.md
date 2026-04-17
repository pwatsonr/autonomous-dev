# SPEC-010-4-03: Cost Ledger Rotation, Log Rotation, and Observation Lifecycle

## Metadata
- **Parent Plan**: PLAN-010-4
- **Tasks Covered**: Task 6, Task 7, Task 8, Task 9, Task 10
- **Estimated effort**: 10 hours

## Description

Implement cost ledger monthly rotation (splitting entries by month), archived cost ledger pruning, daemon and config-validation log rotation, observation report active-to-archive-to-delete lifecycle, and archived request tarball pruning.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Create | `lib/ledger_rotation.sh` | Monthly cost ledger rotation and archive pruning |
| Modify | `lib/cleanup_engine.sh` | Log rotation, observation lifecycle, tarball pruning |

## Implementation Details

### Cost Ledger Monthly Rotation (lib/ledger_rotation.sh)

**`rotate_cost_ledger()`** -- At month boundaries, split the active ledger into a monthly archive:

```bash
rotate_cost_ledger() {
  local ledger_path="${HOME}/.autonomous-dev/cost-ledger.jsonl"
  
  if [[ ! -f "$ledger_path" ]] || [[ ! -s "$ledger_path" ]]; then
    return 0  # Nothing to rotate
  fi
  
  local current_month
  current_month=$(date -u +"%Y-%m")
  
  # Check if rotation is needed: does the ledger contain entries from previous months?
  local has_old_entries
  has_old_entries=$(jq -r "select(.timestamp[:7] != \"$current_month\")" "$ledger_path" 2>/dev/null | head -1)
  
  if [[ -z "$has_old_entries" ]]; then
    return 0  # All entries are from current month
  fi
  
  # Identify which months have entries (excluding current month)
  local old_months
  old_months=$(jq -r '.timestamp[:7]' "$ledger_path" 2>/dev/null \
    | sort -u \
    | grep -v "^${current_month}$")
  
  while IFS= read -r month; do
    [[ -z "$month" ]] && continue
    
    local archive_path="${HOME}/.autonomous-dev/cost-ledger-${month}.jsonl"
    
    # Skip if archive already exists (idempotent)
    if [[ -f "$archive_path" ]]; then
      log_info "ledger_rotation" "Monthly archive already exists: $archive_path (skipping)"
      continue
    fi
    
    # Extract entries for this month
    jq -c "select(.timestamp[:7] == \"$month\")" "$ledger_path" > "${archive_path}.tmp" 2>/dev/null
    
    if [[ -s "${archive_path}.tmp" ]]; then
      mv "${archive_path}.tmp" "$archive_path"
      log_info "ledger_rotation" "Created monthly archive: $archive_path"
    else
      rm -f "${archive_path}.tmp"
    fi
  done <<< "$old_months"
  
  # Rewrite active ledger with only current-month entries
  local tmp_ledger="${ledger_path}.rotated.$$"
  jq -c "select(.timestamp[:7] == \"$current_month\")" "$ledger_path" > "$tmp_ledger" 2>/dev/null
  
  # Verify the new ledger is valid (has entries or is empty for a new month)
  if [[ -f "$tmp_ledger" ]]; then
    mv "$tmp_ledger" "$ledger_path"
    log_info "ledger_rotation" "Active ledger rotated. Retained only $current_month entries."
  else
    rm -f "$tmp_ledger"
    log_warning "ledger_rotation" "Rotation produced empty file. Keeping original ledger."
  fi
  
  return 0
}
```

**Idempotency guarantee**: If `cost-ledger-YYYY-MM.jsonl` already exists, that month is skipped. Running rotation twice in the same month does not duplicate entries.

**Post-rotation ledger integrity**: The active ledger's last line still has correct `daily_total_usd` and `monthly_total_usd` because those are denormalized per-entry -- they were correct when written and remain correct after filtering.

### Archived Cost Ledger Pruning

**`prune_cost_ledger_archives()`** -- Delete monthly archives older than `retention.cost_ledger_months`:

```bash
prune_cost_ledger_archives() {
  local effective_config="$1"
  
  local retention_months
  retention_months=$(echo "$effective_config" | jq -r '.retention.cost_ledger_months')
  
  local archive_dir="${HOME}/.autonomous-dev"
  
  # Calculate the cutoff month
  local cutoff_month
  if [[ "$(uname)" == "Darwin" ]]; then
    cutoff_month=$(date -u -v "-${retention_months}m" +"%Y-%m")
  else
    cutoff_month=$(date -u -d "-${retention_months} months" +"%Y-%m")
  fi
  
  local pruned=0
  for archive_file in "$archive_dir"/cost-ledger-[0-9][0-9][0-9][0-9]-[0-9][0-9].jsonl; do
    [[ -f "$archive_file" ]] || continue
    
    # Extract YYYY-MM from filename
    local file_month
    file_month=$(basename "$archive_file" | sed 's/cost-ledger-\([0-9]\{4\}-[0-9]\{2\}\)\.jsonl/\1/')
    
    # Compare: if file_month < cutoff_month, delete
    if [[ "$file_month" < "$cutoff_month" ]]; then
      rm -f "$archive_file"
      log_info "ledger_rotation" "Pruned old cost ledger archive: $archive_file"
      ((pruned++))
    fi
  done
  
  log_info "ledger_rotation" "Pruned $pruned archived cost ledger(s)"
  return 0
}
```

### Daemon Log Rotation

**`rotate_daemon_logs()`** -- Delete daemon logs older than retention:

```bash
rotate_daemon_logs() {
  local effective_config="$1"
  
  local retention_days
  retention_days=$(echo "$effective_config" | jq -r '.retention.daemon_log_days')
  
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
```

### Config Validation Log Rotation

**`rotate_config_validation_logs()`** -- Delete config validation logs older than retention:

```bash
rotate_config_validation_logs() {
  local effective_config="$1"
  
  local retention_days
  retention_days=$(echo "$effective_config" | jq -r '.retention.config_validation_log_days')
  
  local log_file="${HOME}/.autonomous-dev/logs/config-validation.log"
  
  if [[ -f "$log_file" ]] && is_artifact_expired "config_validation_log" "$log_file" "$effective_config"; then
    rm -f "$log_file"
    log_info "cleanup_engine" "Deleted old config validation log: $log_file"
  fi
  
  return 0
}
```

### Observation Report Lifecycle

**`cleanup_observations()`** -- Manages the active -> archive -> delete lifecycle:

```bash
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
      local basename
      basename=$(basename "$obs_file")
      
      if mv "$obs_file" "${archive_dir}/${basename}" 2>/dev/null; then
        log_info "cleanup_engine" "Archived observation: $basename"
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
```

### Archived Request Tarball Pruning

**`prune_archived_requests()`** -- Delete old tarballs from `~/.autonomous-dev/archive/`:

```bash
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
```

## Acceptance Criteria

1. Ledger rotation copies previous month's entries to `cost-ledger-YYYY-MM.jsonl`.
2. Active ledger retains only current-month entries after rotation.
3. Monthly archive file naming matches `cost-ledger-YYYY-MM.jsonl` (e.g., `cost-ledger-2026-03.jsonl`).
4. Rotation is idempotent: running twice does not duplicate entries.
5. Active ledger's last line still has correct denormalized totals after rotation.
6. Archived cost ledgers older than `retention.cost_ledger_months` are deleted.
7. Archive age is computed from the `YYYY-MM` in the filename.
8. Missing archive directory is handled gracefully.
9. Daemon logs older than `retention.daemon_log_days` are deleted.
10. Current/recent daemon logs are not touched.
11. Config validation logs older than `retention.config_validation_log_days` are deleted.
12. Active observations past `retention.observation_report_days` are moved (not copied) to `archive/`.
13. Archived observations past `retention.observation_archive_days` are deleted.
14. Archive subdirectory is created if it does not exist.
15. Archived request tarballs older than `retention.archive_days` are deleted.
16. File mtime is used for age calculation on logs and tarballs.

## Test Cases

1. **Ledger rotation basic**: Ledger has March and April entries. After rotation, March entries in `cost-ledger-2026-03.jsonl`, active ledger has only April.
2. **Ledger rotation idempotent**: Rotate twice. Second run is a no-op. No duplicate files.
3. **Ledger rotation empty**: Empty ledger. No-op, no error.
4. **Ledger rotation all current month**: All entries from current month. No rotation needed.
5. **Ledger rotation multi-month**: Ledger has Jan, Feb, Mar, Apr entries. Three archive files created.
6. **Cost archive pruning**: `cost-ledger-2025-01.jsonl` exists. Retention 12 months. Current month 2026-04. File deleted.
7. **Cost archive within retention**: `cost-ledger-2025-05.jsonl`. 11 months old. Retention 12. Preserved.
8. **Daemon log rotation**: Log file with mtime 31 days ago. Retention 30 days. Deleted.
9. **Daemon log current**: Log file from today. Not deleted.
10. **Config validation log rotation**: File is 8 days old. Retention 7 days. Deleted.
11. **Observation move to archive**: Observation file 91 days old. Retention 90. Moved to `archive/`.
12. **Observation archive delete**: Archived observation 366 days old. Archive retention 365. Deleted.
13. **Observation within retention**: 60 days old. Retention 90. Not moved.
14. **Tarball pruning**: `REQ-20250101-x.tar.gz` is 366 days old. Retention 365. Deleted.
15. **Tarball within retention**: 300 days old. Retention 365. Preserved.
16. **Missing archive dir**: No `archive/` directory. Pruning functions return 0, no error.
