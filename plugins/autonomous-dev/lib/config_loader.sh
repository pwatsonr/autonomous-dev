#!/usr/bin/env bash
# config_loader.sh -- Four-layer config loader with jq-based deep merge
#
# Source this file, then call:
#   load_config [--config.key.subkey=value ...]
# Returns: merged JSON on stdout
# Exit code: 0 on success, 1 on validation error
#
# Layer precedence (lowest to highest):
#   1. Built-in defaults  (PLUGIN_ROOT/config_defaults.json)
#   2. Global config      (~/.claude/autonomous-dev.json)
#   3. Project config     (REPO_ROOT/.claude/autonomous-dev.json)
#   4. CLI overrides      (--config.key.subkey=value arguments)
#
# Note on null values: jq's * operator treats explicit null in an overlay
# as a deletion -- the key will be removed from the merged result. This is
# by design: setting a key to null in a higher-precedence layer effectively
# unsets it.

set -euo pipefail

# Source guard
if [[ -n "${_CONFIG_LOADER_LOADED:-}" ]]; then return 0 2>/dev/null || true; fi
_CONFIG_LOADER_LOADED=1

# ---------------------------------------------------------------------------
# Resolve PLUGIN_ROOT: directory containing this script's parent
# ---------------------------------------------------------------------------
if [[ -z "${PLUGIN_ROOT:-}" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# ---------------------------------------------------------------------------
# Logging helpers (write to stderr so stdout stays clean for JSON output)
# ---------------------------------------------------------------------------
log_warning() {
  echo "[config_loader] WARNING: $*" >&2
}

log_error() {
  echo "[config_loader] ERROR: $*" >&2
}

log_info() {
  echo "[config_loader] INFO: $*" >&2
}

# ---------------------------------------------------------------------------
# merge_configs -- Two-argument recursive deep merge using jq
#
# jq's * operator merges objects recursively. For arrays the overlay array
# fully replaces the base array (no concatenation).
# ---------------------------------------------------------------------------
merge_configs() {
  local base="$1"
  local overlay="$2"
  jq -n --argjson base "$base" --argjson overlay "$overlay" '$base * $overlay'
}

# ---------------------------------------------------------------------------
# read_config_file -- Safely read a JSON config file
#
# Returns the file contents as validated JSON on stdout.
# If the file does not exist, emits a warning and returns "{}".
# If the file exists but is invalid JSON, emits an error and returns 1.
# ---------------------------------------------------------------------------
read_config_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    log_warning "Config file not found: $path"
    echo "{}"
    return 0
  fi
  local content
  if ! content=$(jq '.' "$path" 2>/dev/null); then
    log_error "Failed to parse JSON: $path"
    return 1
  fi
  echo "$content"
}

# ---------------------------------------------------------------------------
# parse_single_override -- Converts a dot-path + value into nested JSON
#
# Uses jq to build a nested object from the dot-separated key path.
# Type detection rules:
#   1. If the value parses as a number via tonumber, it becomes a JSON number.
#   2. If the value is exactly "true" or "false", it becomes a JSON boolean.
#   3. Otherwise, it remains a JSON string.
# ---------------------------------------------------------------------------
parse_single_override() {
  local key_path="$1"
  local value="$2"
  echo "$value" | jq -R --arg path "$key_path" '
    ($path | split(".")) as $keys |
    reduce range($keys | length - 1; -1; -1) as $i (
      (. | try tonumber // try (if . == "true" then true elif . == "false" then false else . end));
      {($keys[$i]): .}
    )
  '
}

# ---------------------------------------------------------------------------
# parse_cli_overrides -- Convert --config.key.subkey=value args to JSON
#
# Accepts arguments of the form --config.key.subkey=value and builds a
# nested JSON object via parse_single_override(), then deep-merges them.
# ---------------------------------------------------------------------------
parse_cli_overrides() {
  local merged="{}"
  for arg in "$@"; do
    if [[ "$arg" =~ ^--config\.(.+)=(.*)$ ]]; then
      local key_path="${BASH_REMATCH[1]}"
      local value="${BASH_REMATCH[2]}"
      local override_json
      override_json=$(parse_single_override "$key_path" "$value")
      merged=$(merge_configs "$merged" "$override_json")
    fi
  done
  echo "$merged"
}

# ---------------------------------------------------------------------------
# load_config -- Entry point. Orchestrates the full four-layer load.
#
# Usage: load_config [--config.key.subkey=value ...]
# Outputs merged JSON on stdout. Exit 1 on error.
# ---------------------------------------------------------------------------
load_config() {
  # 1. Verify jq is installed
  if ! command -v jq > /dev/null 2>&1; then
    log_error "jq is required but not installed. Please install jq first."
    return 1
  fi

  # 2. Read built-in defaults
  local defaults_path="${PLUGIN_ROOT}/config_defaults.json"
  local defaults
  if [[ ! -f "$defaults_path" ]]; then
    log_error "Built-in defaults not found: $defaults_path"
    return 1
  fi
  if ! defaults=$(jq '.' "$defaults_path" 2>/dev/null); then
    log_error "Failed to parse built-in defaults: $defaults_path"
    return 1
  fi

  # 3. Read global config
  local global_path="${HOME}/.claude/autonomous-dev.json"
  local global_config
  if ! global_config=$(read_config_file "$global_path"); then
    return 1
  fi

  # 4. Read project config
  local repo_root="${REPO_ROOT:-}"
  local project_config="{}"
  if [[ -n "$repo_root" ]]; then
    local project_path="${repo_root}/.claude/autonomous-dev.json"
    if ! project_config=$(read_config_file "$project_path"); then
      return 1
    fi
  else
    log_warning "REPO_ROOT is not set; skipping project config layer."
  fi

  # 5. Parse CLI overrides
  local cli_overrides
  cli_overrides=$(parse_cli_overrides "$@")

  # 6. Four-layer merge: defaults < global < project < cli_overrides
  local merged
  merged=$(merge_configs "$defaults" "$global_config")
  merged=$(merge_configs "$merged" "$project_config")
  merged=$(merge_configs "$merged" "$cli_overrides")

  # 7. Output merged config
  echo "$merged"
}

# ---------------------------------------------------------------------------
# load_config_no_cli -- Load the three base layers WITHOUT CLI overrides
#
# Returns: defaults * global * project (no CLI layer)
# This is used by load_config_for_request() to insert repo overrides at the
# correct precedence level.
# ---------------------------------------------------------------------------
load_config_no_cli() {
  # 1. Verify jq is installed
  if ! command -v jq > /dev/null 2>&1; then
    log_error "jq is required but not installed. Please install jq first."
    return 1
  fi

  # 2. Read built-in defaults
  local defaults_path="${PLUGIN_ROOT}/config_defaults.json"
  local defaults
  if [[ ! -f "$defaults_path" ]]; then
    log_error "Built-in defaults not found: $defaults_path"
    return 1
  fi
  if ! defaults=$(jq '.' "$defaults_path" 2>/dev/null); then
    log_error "Failed to parse built-in defaults: $defaults_path"
    return 1
  fi

  # 3. Read global config
  local global_path="${HOME}/.claude/autonomous-dev.json"
  local global_config
  if ! global_config=$(read_config_file "$global_path"); then
    return 1
  fi

  # 4. Read project config
  local repo_root="${REPO_ROOT:-}"
  local project_config="{}"
  if [[ -n "$repo_root" ]]; then
    local project_path="${repo_root}/.claude/autonomous-dev.json"
    if ! project_config=$(read_config_file "$project_path"); then
      return 1
    fi
  else
    log_warning "REPO_ROOT is not set; skipping project config layer."
  fi

  # 5. Three-layer merge: defaults < global < project (no CLI)
  local merged
  merged=$(merge_configs "$defaults" "$global_config")
  merged=$(merge_configs "$merged" "$project_config")

  echo "$merged"
}

# ---------------------------------------------------------------------------
# load_config_for_request -- Five-layer config loader with repo overrides
#
# Inserts per-repository overrides between the project layer and CLI layer:
#   CLI > repo_override > project > global > defaults
#
# Usage: load_config_for_request "/path/to/repo" [--config.key.subkey=value ...]
# Outputs merged JSON on stdout. Exit 1 on error.
#
# Requires: get_repo_override() from repo_allowlist.sh
# ---------------------------------------------------------------------------
load_config_for_request() {
  local repo_path="$1"
  shift

  # Standard 4-layer merge
  local base_config
  base_config=$(load_config "$@")

  # Get repo override
  local repo_override
  repo_override=$(get_repo_override "$repo_path" "$base_config")

  if [[ "$repo_override" != "{}" ]] && [[ "$repo_override" != "null" ]]; then
    # Re-merge: insert repo_override between project and CLI
    # Since CLI is already highest, we need to:
    # 1. Merge repo_override into the base (which is defaults*global*project)
    # 2. Then re-apply CLI overrides on top
    local cli_overrides
    cli_overrides=$(parse_cli_overrides "$@")

    # base_without_cli = defaults * global * project
    local base_without_cli
    base_without_cli=$(load_config_no_cli)

    # Final: base_without_cli * repo_override * cli_overrides
    local merged
    merged=$(merge_configs "$base_without_cli" "$repo_override")
    merged=$(merge_configs "$merged" "$cli_overrides")
    echo "$merged"
  else
    echo "$base_config"
  fi
}
