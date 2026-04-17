#!/usr/bin/env bash
# ledger_rotation.sh -- Monthly cost ledger rotation and archive pruning
# Part of SPEC-010-4-03: Cost Ledger Rotation, Log Rotation, and Observation Lifecycle
#
# Dependencies: jq (1.6+), bash 4+
#
# Usage:
#   source ledger_rotation.sh
#   rotate_cost_ledger
#   prune_cost_ledger_archives "$effective_config"

set -euo pipefail

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
# Cost Ledger Monthly Rotation
# =============================================================================

# rotate_cost_ledger -- At month boundaries, split the active ledger into monthly archives
#
# The active ledger (cost-ledger.jsonl) is split so that entries from previous
# months are written to cost-ledger-YYYY-MM.jsonl archive files, and only
# current-month entries remain in the active ledger.
#
# Idempotency: If cost-ledger-YYYY-MM.jsonl already exists, that month is
# skipped. Running rotation twice in the same month does not duplicate entries.
#
# Returns:
#   0 on success or nothing to do
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
    | grep -v "^${current_month}$") || true

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

# =============================================================================
# Archived Cost Ledger Pruning
# =============================================================================

# prune_cost_ledger_archives -- Delete monthly archives older than retention
#
# Arguments:
#   $1 -- effective_config: Merged config JSON string
#
# Archives older than retention.cost_ledger_months are deleted.
# Archive age is computed from the YYYY-MM in the filename.
#
# Returns:
#   0 always (missing archive directory is handled gracefully)
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
