#!/usr/bin/env bash
# config_validate.sh -- On-demand validation runner for autonomous-dev config
#
# Usage:
#   autonomous-dev config validate [--config.key=value ...]
#
# Loads the effective config (four-layer merge) and runs the full validation
# pipeline. Exits 0 if valid (errors=0), exits 1 if any Error-severity rule
# fails. Warnings alone do not cause a non-zero exit.
#
# Output is human-readable with color coding when stdout is a terminal.

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve PLUGIN_ROOT
# ---------------------------------------------------------------------------
if [[ -z "${PLUGIN_ROOT:-}" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# Source the config loader and validator
source "${PLUGIN_ROOT}/lib/config_loader.sh"
source "${PLUGIN_ROOT}/lib/config_validator.sh"

# ---------------------------------------------------------------------------
# Color helpers (only when stdout is a terminal)
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  GREEN='\033[0;32m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  RED=''
  YELLOW=''
  GREEN=''
  BOLD=''
  RESET=''
fi

# ---------------------------------------------------------------------------
# config_validate -- Main entry point
# ---------------------------------------------------------------------------
config_validate() {
  # 1. Verify jq is installed
  if ! command -v jq > /dev/null 2>&1; then
    echo "Error: jq is required but not installed." >&2
    return 1
  fi

  # 2. Load effective config (without built-in validation -- we validate ourselves)
  #    We replicate load_config logic directly to avoid any embedded validation.
  local defaults_path="${PLUGIN_ROOT}/config_defaults.json"
  local defaults
  if [[ ! -f "$defaults_path" ]]; then
    echo "FAIL: Built-in defaults not found: $defaults_path" >&2
    return 1
  fi
  if ! defaults=$(jq '.' "$defaults_path" 2>/dev/null); then
    echo "FAIL: Failed to parse built-in defaults: $defaults_path" >&2
    return 1
  fi

  local global_path="${HOME}/.claude/autonomous-dev.json"
  local global_config
  if ! global_config=$(read_config_file "$global_path"); then
    echo "FAIL: Could not load configuration." >&2
    return 1
  fi

  local repo_root="${REPO_ROOT:-}"
  local project_config="{}"
  if [[ -n "$repo_root" ]]; then
    local project_path="${repo_root}/.claude/autonomous-dev.json"
    if ! project_config=$(read_config_file "$project_path"); then
      echo "FAIL: Could not load configuration." >&2
      return 1
    fi
  fi

  local cli_overrides
  cli_overrides=$(parse_cli_overrides "$@")

  local config
  config=$(merge_configs "$defaults" "$global_config")
  config=$(merge_configs "$config" "$project_config")
  config=$(merge_configs "$config" "$cli_overrides")

  # 3. Capture validation output (errors/warnings go to stderr from validate_config)
  local validation_output
  validation_output=$(validate_config "$config" 2>&1) || true
  local has_errors=$VALIDATION_HAS_ERRORS

  # 4. Parse and count errors and warnings from validation output
  local error_count=0
  local warning_count=0
  local error_lines=()
  local warning_lines=()

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    # Check if line is JSON from emit_validation_error/emit_validation_warning
    local level
    level=$(echo "$line" | jq -r '.level // empty' 2>/dev/null) || continue
    if [[ "$level" == "error" ]]; then
      ((error_count++)) || true
      error_lines+=("$line")
    elif [[ "$level" == "warning" ]]; then
      ((warning_count++)) || true
      warning_lines+=("$line")
    fi
  done <<< "$validation_output"

  # 5. Display results
  if (( error_count == 0 )); then
    echo -e "${GREEN}${BOLD}PASS${RESET}${GREEN}: Configuration is valid.${RESET}"
    if (( warning_count > 0 )); then
      echo "  Warnings: $warning_count"
      echo ""
      for wline in "${warning_lines[@]}"; do
        local w_rule w_field w_value w_constraint w_source
        w_rule=$(echo "$wline" | jq -r '.rule')
        w_field=$(echo "$wline" | jq -r '.field')
        w_value=$(echo "$wline" | jq -r '.value')
        w_constraint=$(echo "$wline" | jq -r '.constraint')
        w_source=$(echo "$wline" | jq -r '.source')
        echo -e "  ${YELLOW}${BOLD}WARNING${RESET}${YELLOW} [${w_rule}] ${w_field}${RESET}"
        echo "    ${w_constraint} (got: ${w_value})"
        echo "    Source: ${w_source}"
        echo ""
      done
    fi
    return 0
  else
    echo -e "${RED}${BOLD}FAIL${RESET}${RED}: Configuration has ${error_count} error(s) and ${warning_count} warning(s).${RESET}"
    echo ""

    # Display errors
    for eline in "${error_lines[@]}"; do
      local e_rule e_field e_value e_constraint e_source
      e_rule=$(echo "$eline" | jq -r '.rule')
      e_field=$(echo "$eline" | jq -r '.field')
      e_value=$(echo "$eline" | jq -r '.value')
      e_constraint=$(echo "$eline" | jq -r '.constraint')
      e_source=$(echo "$eline" | jq -r '.source')
      echo -e "  ${RED}${BOLD}ERROR${RESET}${RED} [${e_rule}] ${e_field}${RESET}"
      echo "    ${e_constraint} (got: ${e_value})"
      echo "    Source: ${e_source}"
      echo ""
    done

    # Display warnings
    for wline in "${warning_lines[@]}"; do
      local w_rule w_field w_value w_constraint w_source
      w_rule=$(echo "$wline" | jq -r '.rule')
      w_field=$(echo "$wline" | jq -r '.field')
      w_value=$(echo "$wline" | jq -r '.value')
      w_constraint=$(echo "$wline" | jq -r '.constraint')
      w_source=$(echo "$wline" | jq -r '.source')
      echo -e "  ${YELLOW}${BOLD}WARNING${RESET}${YELLOW} [${w_rule}] ${w_field}${RESET}"
      echo "    ${w_constraint} (got: ${w_value})"
      echo "    Source: ${w_source}"
      echo ""
    done

    return 1
  fi
}

# ---------------------------------------------------------------------------
# Run if executed directly (not sourced)
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  config_validate "$@"
fi
