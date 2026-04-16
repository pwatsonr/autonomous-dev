#!/usr/bin/env bash
# config_show.sh -- Display effective merged config with source annotations
#                   and webhook URL redaction
#
# Usage:
#   autonomous-dev config show [--config.key=value ...]
#
# Outputs a JSON object with two top-level keys:
#   "config"  -- the effective merged configuration (webhooks redacted)
#   "sources" -- a map of dotted-path -> source layer for every scalar field

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve PLUGIN_ROOT
# ---------------------------------------------------------------------------
if [[ -z "${PLUGIN_ROOT:-}" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# Source the config loader
source "${PLUGIN_ROOT}/lib/config_loader.sh"

# ---------------------------------------------------------------------------
# build_source_map -- Track which layer provided each leaf value
#
# Walks each layer's scalar paths and records the highest-precedence source.
# ---------------------------------------------------------------------------
build_source_map() {
  local defaults="$1"
  local global_config="$2"
  local project_config="$3"
  local cli_overrides="$4"

  # Start with all fields sourced as "default"
  local source_map
  source_map=$(echo "$defaults" | jq '[paths(scalars)] | map({(map(tostring) | join(".")): "default"}) | add // {}')

  # Override with "global" for fields present in global config
  if [[ "$global_config" != "{}" ]]; then
    local global_paths
    global_paths=$(echo "$global_config" | jq -r '[paths(scalars)] | map(map(tostring) | join("."))[]')
    while IFS= read -r path; do
      [[ -z "$path" ]] && continue
      source_map=$(echo "$source_map" | jq --arg p "$path" '.[$p] = "global"')
    done <<< "$global_paths"
  fi

  # Override with "project" for fields present in project config
  if [[ "$project_config" != "{}" ]]; then
    local project_paths
    project_paths=$(echo "$project_config" | jq -r '[paths(scalars)] | map(map(tostring) | join("."))[]')
    while IFS= read -r path; do
      [[ -z "$path" ]] && continue
      source_map=$(echo "$source_map" | jq --arg p "$path" '.[$p] = "project"')
    done <<< "$project_paths"
  fi

  # Override with "cli" for fields present in CLI overrides
  if [[ "$cli_overrides" != "{}" ]]; then
    local cli_paths
    cli_paths=$(echo "$cli_overrides" | jq -r '[paths(scalars)] | map(map(tostring) | join("."))[]')
    while IFS= read -r path; do
      [[ -z "$path" ]] && continue
      source_map=$(echo "$source_map" | jq --arg p "$path" '.[$p] = "cli"')
    done <<< "$cli_paths"
  fi

  echo "$source_map"
}

# ---------------------------------------------------------------------------
# redact_webhooks -- Replace webhook URLs with domain-only + /***
# ---------------------------------------------------------------------------
redact_webhooks() {
  local config="$1"
  echo "$config" | jq '
    if .notifications.delivery.discord.webhook_url then
      .notifications.delivery.discord.webhook_url |= (
        if . != null and . != "" then
          (capture("^(?<scheme>https?://)(?<domain>[^/]+)") | .scheme + .domain + "/***")
          // "***"
        else . end
      )
    else . end |
    if .notifications.delivery.slack.webhook_url then
      .notifications.delivery.slack.webhook_url |= (
        if . != null and . != "" then
          (capture("^(?<scheme>https?://)(?<domain>[^/]+)") | .scheme + .domain + "/***")
          // "***"
        else . end
      )
    else . end
  '
}

# ---------------------------------------------------------------------------
# config_show -- Main entry point
# ---------------------------------------------------------------------------
config_show() {
  # 1. Verify jq is installed
  if ! command -v jq > /dev/null 2>&1; then
    echo "Error: jq is required but not installed." >&2
    return 1
  fi

  # 2. Read each layer individually (replicating load_config's layer reads)
  local defaults_path="${PLUGIN_ROOT}/config_defaults.json"
  local defaults
  if [[ ! -f "$defaults_path" ]]; then
    echo "Error: Built-in defaults not found: $defaults_path" >&2
    return 1
  fi
  if ! defaults=$(jq '.' "$defaults_path" 2>/dev/null); then
    echo "Error: Failed to parse built-in defaults: $defaults_path" >&2
    return 1
  fi

  local global_path="${HOME}/.claude/autonomous-dev.json"
  local global_config
  if ! global_config=$(read_config_file "$global_path"); then
    return 1
  fi

  local repo_root="${REPO_ROOT:-}"
  local project_config="{}"
  if [[ -n "$repo_root" ]]; then
    local project_path="${repo_root}/.claude/autonomous-dev.json"
    if ! project_config=$(read_config_file "$project_path"); then
      return 1
    fi
  fi

  local cli_overrides
  cli_overrides=$(parse_cli_overrides "$@")

  # 3. Four-layer merge
  local merged
  merged=$(merge_configs "$defaults" "$global_config")
  merged=$(merge_configs "$merged" "$project_config")
  merged=$(merge_configs "$merged" "$cli_overrides")

  # 4. Build source map
  local source_map
  source_map=$(build_source_map "$defaults" "$global_config" "$project_config" "$cli_overrides")

  # 5. Redact webhooks
  local redacted
  redacted=$(redact_webhooks "$merged")

  # 6. Output combined JSON
  jq -n --argjson config "$redacted" --argjson sources "$source_map" \
    '{ config: $config, sources: $sources }'
}

# ---------------------------------------------------------------------------
# Run if executed directly (not sourced)
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  config_show "$@"
fi
