# SPEC-010-1-03: Config CLI Commands (init, show, validate)

## Metadata
- **Parent Plan**: PLAN-010-1
- **Tasks Covered**: Task 6, Task 7, Task 8
- **Estimated effort**: 8 hours

## Description

Implement the three `autonomous-dev config` CLI subcommands: `init` (generate a default config file), `show` (display effective merged config with source annotations and webhook redaction), and `validate` (on-demand validation).

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Create | `commands/config_init.sh` | Generate default config at global or project path |
| Create | `commands/config_show.sh` | Display effective config with source annotations |
| Create | `commands/config_validate.sh` | On-demand validation runner |

## Implementation Details

### commands/config_init.sh

**Usage**:
```
autonomous-dev config init --global [--force]
autonomous-dev config init --project [--force]
```

**Logic**:

```bash
config_init() {
  local scope=""
  local force=false
  
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --global)  scope="global" ;;
      --project) scope="project" ;;
      --force)   force=true ;;
      *) echo "Unknown option: $1" >&2; return 1 ;;
    esac
    shift
  done
  
  if [[ -z "$scope" ]]; then
    echo "Error: Must specify --global or --project" >&2
    return 1
  fi
  
  local target_path
  if [[ "$scope" == "global" ]]; then
    target_path="${HOME}/.claude/autonomous-dev.json"
  else
    local repo_root
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
      echo "Error: Not in a git repository" >&2
      return 1
    }
    target_path="${repo_root}/.claude/autonomous-dev.json"
  fi
  
  # Check for existing file
  if [[ -f "$target_path" ]] && [[ "$force" != "true" ]]; then
    echo "Error: Config file already exists: $target_path" >&2
    echo "Use --force to overwrite." >&2
    return 1
  fi
  
  # Create directory
  mkdir -p "$(dirname "$target_path")"
  
  # Write minimal starter config
  local starter_config
  if [[ "$scope" == "global" ]]; then
    starter_config='{
  "governance": {
    "daily_cost_cap_usd": 100.00,
    "monthly_cost_cap_usd": 2000.00,
    "per_request_cost_cap_usd": 50.00,
    "max_concurrent_requests": 3
  },
  "repositories": {
    "allowlist": []
  }
}'
  else
    starter_config='{}'
  fi
  
  echo "$starter_config" > "$target_path"
  
  # Write companion .commented file with documentation
  generate_commented_config > "${target_path}.commented"
  
  echo "Created config file: $target_path"
  echo "Companion documentation: ${target_path}.commented"
}
```

**Companion `.commented` file** -- The `generate_commented_config()` function produces a pseudo-JSON file with `//` comments documenting every field, its type, default, min/max, and description. This is for human reference only; it is not parsed by the system. The content mirrors the full schema from Section 4.1:

```
// autonomous-dev configuration reference
// This file is for documentation only. Edit autonomous-dev.json instead.
//
// Layer precedence: CLI flags > project > global > built-in defaults
{
  // --- Daemon ---
  // "daemon.poll_interval_seconds": 30,        // integer, 5-600. Seconds between iterations.
  // "daemon.heartbeat_interval_seconds": 30,    // integer, 5-120. Heartbeat write interval.
  // "daemon.circuit_breaker_threshold": 3,      // integer, 1-20. Failures before circuit trip.
  // ...
  // --- Governance ---
  // "governance.daily_cost_cap_usd": 100.00,    // number, 1-10000. Daily spend cap (UTC).
  // "governance.monthly_cost_cap_usd": 2000.00, // number, 10-100000. Monthly spend cap (UTC).
  // ...
}
```

### commands/config_show.sh

**Usage**:
```
autonomous-dev config show [--config.key=value ...]
```

**Logic**:

1. Call `load_config` to produce the effective merged config.
2. Build a parallel "source map" JSON object showing which layer each value came from.
3. Redact webhook URLs (show only the domain).
4. Output the config with inline source annotations.

**Source tracking**: During merge, track which layer provided each leaf value:

```bash
build_source_map() {
  local defaults="$1" global_config="$2" project_config="$3" cli_overrides="$4"
  
  # Start with all fields sourced as "default"
  local source_map
  source_map=$(echo "$defaults" | jq '[paths(scalars)] | map({(join(".")): "default"}) | add')
  
  # Override with "global" for fields present in global config
  if [[ "$global_config" != "{}" ]]; then
    local global_paths
    global_paths=$(echo "$global_config" | jq '[paths(scalars)] | map(join("."))[]' -r)
    while IFS= read -r path; do
      source_map=$(echo "$source_map" | jq --arg p "$path" '.[$p] = "global"')
    done <<< "$global_paths"
  fi
  
  # Override with "project" for fields present in project config
  # ... same pattern ...
  
  # Override with "cli" for fields present in CLI overrides
  # ... same pattern ...
  
  echo "$source_map"
}
```

**Webhook redaction**:

```bash
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
```

**Output format** -- The command prints a JSON object with two top-level keys: `config` (the effective values) and `sources` (the source map):

```json
{
  "config": {
    "governance": {
      "daily_cost_cap_usd": 200.00
    }
  },
  "sources": {
    "governance.daily_cost_cap_usd": "global",
    "governance.monthly_cost_cap_usd": "default"
  }
}
```

### commands/config_validate.sh

**Usage**:
```
autonomous-dev config validate [--config.key=value ...]
```

**Logic**:

```bash
config_validate() {
  # Load effective config (without validation -- we want to validate it ourselves)
  local config
  config=$(load_config_no_validate "$@") || {
    echo "FAIL: Could not load configuration." >&2
    return 1
  }
  
  # Run validation
  local errors warnings
  validate_config "$config"
  local exit_code=$?
  
  if [[ $exit_code -eq 0 ]]; then
    echo "PASS: Configuration is valid."
    if [[ $VALIDATION_WARNING_COUNT -gt 0 ]]; then
      echo "  Warnings: $VALIDATION_WARNING_COUNT"
    fi
    return 0
  else
    echo "FAIL: Configuration has $VALIDATION_ERROR_COUNT error(s) and $VALIDATION_WARNING_COUNT warning(s)."
    return 1
  fi
}
```

Output on failure is human-readable with color coding:

```
FAIL: Configuration has 2 error(s) and 1 warning(s).

  ERROR [V-003] governance.daily_cost_cap_usd
    Daily cost cap ($150) exceeds monthly cost cap ($100).
    Source: ~/.claude/autonomous-dev.json

  ERROR [V-019] governance.rate_limit_backoff_max_seconds
    Must be >= governance.rate_limit_backoff_base_seconds (30). Got: 10
    Source: .claude/autonomous-dev.json

  WARNING [V-004] governance.per_request_cost_cap_usd
    Should be <= governance.daily_cost_cap_usd ($150). Got: $200
    Source: ~/.claude/autonomous-dev.json
```

## Acceptance Criteria

1. `config init --global` writes to `~/.claude/autonomous-dev.json`.
2. `config init --project` writes to `{repo}/.claude/autonomous-dev.json` (detects repo root via `git rev-parse --show-toplevel`).
3. Existing file is NOT overwritten unless `--force` is passed.
4. `--force` overwrites an existing file without prompting.
5. Companion `.commented` file is generated alongside the config file and documents every field.
6. `config init --project` fails with a clear error if not in a git repository.
7. `config show` displays the complete effective configuration (all fields, including defaults).
8. Each field in `config show` output is annotated with its source: `default`, `global`, `project`, or `cli`.
9. Webhook URLs in `config show` output are redacted to `https://hooks.slack.com/***` style.
10. `config show` output is valid JSON.
11. `config validate` exits 0 if validation passes (no errors).
12. `config validate` exits 1 if any Error-severity rule fails.
13. `config validate` prints all errors and warnings to stdout in human-readable format.
14. `config validate` works without the daemon running (standalone operation).

## Test Cases

1. **Init global fresh**: No existing global config. `config init --global` creates `~/.claude/autonomous-dev.json`. File is valid JSON.
2. **Init global exists, no force**: Global config already exists. `config init --global` exits 1 with error.
3. **Init global exists, force**: Global config exists. `config init --global --force` overwrites. Exit 0.
4. **Init project fresh**: In a git repo. `config init --project` creates `.claude/autonomous-dev.json` at repo root.
5. **Init project not-in-repo**: Not in a git repo. `config init --project` exits 1 with "Not in a git repository".
6. **Init companion file**: After init, a `.commented` file exists alongside the config file.
7. **Show defaults only**: No global/project config. `config show` output contains all fields from `config_defaults.json`, all sourced as `"default"`.
8. **Show with override**: Global config sets `governance.daily_cost_cap_usd=200`. `config show` reports that field as sourced from `"global"`.
9. **Show webhook redaction**: Global config has `notifications.delivery.slack.webhook_url: "https://hooks.slack.com/services/T00/B00/xxxx"`. `config show` displays `"https://hooks.slack.com/***"`.
10. **Show null webhook**: Webhook URL is null. No redaction needed, no error.
11. **Validate passing config**: Defaults-only config. `config validate` exits 0, prints "PASS".
12. **Validate failing config**: Config with `daily_cost_cap_usd > monthly_cost_cap_usd`. `config validate` exits 1, prints the V-003 error.
13. **Validate with CLI override**: `config validate --config.governance.daily_cost_cap_usd=50` validates the override applied on top of file configs.
14. **Validate warnings only**: Config triggers only V-004 (warning). `config validate` exits 0 but reports the warning count.
