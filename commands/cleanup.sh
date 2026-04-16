#!/usr/bin/env bash
# cleanup.sh -- CLI command for manual cleanup with --dry-run support
# Part of SPEC-010-4-04: Cleanup Orchestrator, Automatic Trigger, and CLI Command
#
# Usage:
#   autonomous-dev cleanup [--dry-run] [--config.key=value ...]
#
# Options:
#   --dry-run           List eligible artifacts without modifying anything
#   --config.key=value  Override config values (same as other CLI commands)
#
# Exit codes:
#   0 -- All cleanup items succeeded
#   1 -- One or more cleanup items failed, or invalid arguments

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve PLUGIN_ROOT
# ---------------------------------------------------------------------------
if [[ -z "${PLUGIN_ROOT:-}" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# =============================================================================
# CLI Entry Point
# =============================================================================

cleanup_command() {
  local dry_run=false
  local config_args=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) dry_run=true ;;
      --config.*) config_args+=("$1") ;;
      -h|--help)
        echo "Usage: autonomous-dev cleanup [--dry-run] [--config.key=value ...]"
        echo ""
        echo "Options:"
        echo "  --dry-run           List eligible artifacts without modifying anything"
        echo "  --config.key=value  Override config values"
        echo ""
        echo "Examples:"
        echo "  autonomous-dev cleanup --dry-run"
        echo "  autonomous-dev cleanup"
        echo "  autonomous-dev cleanup --config.retention.completed_request_days=7"
        return 0
        ;;
      *)
        echo "Unknown option: $1" >&2
        echo "Usage: autonomous-dev cleanup [--dry-run] [--config.key=value ...]" >&2
        return 1
        ;;
    esac
    shift
  done

  source "$PLUGIN_ROOT/lib/config_loader.sh"
  source "$PLUGIN_ROOT/lib/cleanup_engine.sh"
  source "$PLUGIN_ROOT/lib/ledger_rotation.sh"

  local config
  config=$(load_config "${config_args[@]+"${config_args[@]}"}")

  if [[ "$dry_run" == "true" ]]; then
    echo "=== Cleanup Dry Run ==="
    echo "The following artifacts would be cleaned up:"
    echo ""
  else
    echo "=== Running Cleanup ==="
    echo ""
  fi

  local result
  local exit_code=0
  result=$(cleanup_run "$config" "$dry_run") || exit_code=$?

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

# Run if executed directly (not sourced)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  cleanup_command "$@"
fi
