#!/usr/bin/env bash
# repo_allowlist.sh -- Repository allowlist validation and per-repo override resolution
# Part of SPEC-010-3-03: Repository Allowlist, Per-Repo Overrides, and Composite Resource Check
#
# Dependencies: jq (1.6+), bash 4+, realpath
#
# Usage:
#   source repo_allowlist.sh
#   validate_repository "/path/to/repo" "$effective_config"
#   override=$(get_repo_override "/path/to/repo" "$effective_config")

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve PLUGIN_ROOT for sourcing sibling libraries
# ---------------------------------------------------------------------------
if [[ -z "${PLUGIN_ROOT:-}" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# ---------------------------------------------------------------------------
# Logging helpers (write to stderr so stdout stays clean for data output)
# Only define if not already defined (e.g., when sourced alongside other libs)
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

# ---------------------------------------------------------------------------
# validate_repository -- Validates a repository path against the allowlist
#
# Validation rules (from TDD-010 Section 3.5.2):
#   1. Path must be an exact match after realpath resolution (no glob, no prefix).
#   2. Symlinks are resolved on both sides (input path and each allowlist entry).
#   3. The resolved path must exist on disk (realpath fails for non-existent paths).
#   4. The resolved path must contain a .git/ directory.
#   5. Empty allowlist rejects everything.
#
# Arguments:
#   $1 - Repository path to validate
#   $2 - Effective config JSON containing repositories.allowlist
# Stdout: Error messages on stderr only
# Exit code: 0 if valid, 1 if rejected
# ---------------------------------------------------------------------------
validate_repository() {
  local repo_path="$1"
  local effective_config="$2"

  # Step 1: Resolve symlinks
  local resolved
  resolved=$(realpath "$repo_path" 2>/dev/null) || {
    echo "ERROR: Path does not exist: $repo_path" >&2
    return 1
  }

  # Step 2: Check .git directory exists
  if [[ ! -d "$resolved/.git" ]]; then
    echo "ERROR: Not a git repository (no .git directory): $resolved" >&2
    return 1
  fi

  # Step 3: Compare against allowlist (after resolving both sides)
  local allowed=false
  while IFS= read -r allowed_path; do
    [[ -z "$allowed_path" ]] && continue
    local resolved_allowed
    resolved_allowed=$(realpath "$allowed_path" 2>/dev/null) || {
      log_warning "repo_allowlist" "Allowlist path could not be resolved: $allowed_path"
      continue
    }
    if [[ "$resolved" == "$resolved_allowed" ]]; then
      allowed=true
      break
    fi
  done < <(echo "$effective_config" | jq -r '.repositories.allowlist[]?')

  if [[ "$allowed" != "true" ]]; then
    echo "ERROR: Repository not on allowlist: $resolved" >&2
    return 1
  fi

  return 0
}

# ---------------------------------------------------------------------------
# get_repo_override -- Retrieve the override config for a specific repository
#
# Looks up the repository path (resolved via realpath, then falls back to
# the original unresolved path) in the repositories.overrides map.
#
# Arguments:
#   $1 - Repository path
#   $2 - Effective config JSON containing repositories.overrides
# Stdout: JSON object with override values, or "{}" if none found
# Exit code: always 0
# ---------------------------------------------------------------------------
get_repo_override() {
  local repo_path="$1"
  local effective_config="$2"

  local resolved
  resolved=$(realpath "$repo_path" 2>/dev/null) || {
    echo "{}"
    return 0
  }

  # Check if overrides exist for the resolved path
  local override
  override=$(echo "$effective_config" | jq --arg repo "$resolved" '.repositories.overrides[$repo] // {}')

  # Also check with the original (unresolved) path
  if [[ "$override" == "{}" ]] || [[ "$override" == "null" ]]; then
    override=$(echo "$effective_config" | jq --arg repo "$repo_path" '.repositories.overrides[$repo] // {}')
  fi

  echo "${override:-{}}"
}
