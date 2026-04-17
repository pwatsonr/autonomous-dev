# SPEC-010-1-02: CLI Override Parsing & Validation Pipeline

## Metadata
- **Parent Plan**: PLAN-010-1
- **Tasks Covered**: Task 3, Task 4, Task 5
- **Estimated effort**: 13 hours

## Description

Implement CLI override parsing via dot-notation (`--config.key.subkey=value`) with automatic type detection, and the full five-step validation pipeline covering all 20 rules (V-001 through V-020) with structured error output to stderr and a log file.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Modify | `lib/config_loader.sh` | Add `parse_cli_overrides()` function |
| Create | `lib/config_validator.sh` | Full validation pipeline and all 20 rules |

## Implementation Details

### CLI Override Parsing (in config_loader.sh)

**`parse_cli_overrides()`** -- Takes an array of `--config.X.Y=Z` arguments, returns a merged JSON object:

```bash
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
```

**`parse_single_override()`** -- Converts a dot-path + value into nested JSON:

```bash
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
```

**Type detection rules** (applied in the `jq` expression):
1. If the value parses as a number via `tonumber`, it becomes a JSON number: `"50"` -> `50`, `"2.5"` -> `2.5`.
2. If the value is exactly `"true"` or `"false"`, it becomes a JSON boolean.
3. Otherwise, it remains a JSON string.

### Validation Pipeline (lib/config_validator.sh)

**`validate_config()`** -- Entry point. Takes merged JSON on stdin or as argument. Returns exit code 0 (pass) or 1 (any Error-severity failure). Writes all errors/warnings to stderr and appends to `~/.autonomous-dev/logs/config-validation.log`.

The pipeline runs five steps in sequence. All errors are collected (not short-circuited after the first).

#### Step 1: JSON Parse Check

Already handled by `config_loader.sh` -- if a file cannot be parsed, loading fails before validation. This step validates the merged result is a valid JSON object:

```bash
echo "$config" | jq 'type' | grep -q '"object"'
```

#### Step 2: Schema Type/Range Validation (V-001, V-002, V-008, V-011, V-012, V-014, V-018)

For each numeric field, check it is a number (V-001), check it is in its documented min/max range. For time-unit fields (`*_seconds`, `*_minutes`), check > 0 (V-002).

The schema metadata is encoded as a validation map inside the script:

```bash
# Format: "json_path|type|min|max|rule_id"
NUMERIC_RULES=(
  "daemon.poll_interval_seconds|integer|5|600|V-001,V-002"
  "daemon.heartbeat_interval_seconds|integer|5|120|V-001,V-002"
  "daemon.circuit_breaker_threshold|integer|1|20|V-008"
  "daemon.log_retention_days|integer|1|365|V-001"
  "daemon.idle_backoff_base_seconds|integer|5|300|V-001,V-002"
  "daemon.idle_backoff_max_seconds|integer|60|3600|V-001,V-002"
  "governance.daily_cost_cap_usd|number|1.00|10000.00|V-001"
  "governance.monthly_cost_cap_usd|number|10.00|100000.00|V-001"
  "governance.per_request_cost_cap_usd|number|1.00|5000.00|V-001"
  "governance.max_concurrent_requests|integer|1|50|V-001"
  "governance.disk_usage_limit_gb|number|1.0|500.0|V-001"
  "governance.rate_limit_backoff_base_seconds|integer|5|300|V-001,V-002"
  "governance.rate_limit_backoff_max_seconds|integer|60|3600|V-001,V-002"
  "trust.system_default_level|integer|0|3|V-007"
  "parallel.max_worktrees|integer|1|20|V-014"
  "parallel.max_tracks|integer|1|10|V-001"
  "parallel.disk_warning_threshold_gb|number|0.5|50.0|V-001"
  "parallel.disk_hard_limit_gb|number|1.0|100.0|V-001"
  "parallel.stall_timeout_minutes|integer|5|120|V-001,V-002"
  "parallel.conflict_ai_confidence_threshold|number|0.0|1.0|V-015"
  "parallel.worktree_cleanup_delay_seconds|integer|0|3600|V-001"
  "state_machine.context_window_threshold_pct|integer|50|95|V-001"
  "review_gates.default_threshold|integer|0|100|V-018"
  "review_gates.max_iterations|integer|1|10|V-001"
  "review_gates.disagreement_threshold|integer|0|50|V-001"
  "decomposition.max_children_per_parent|integer|1|50|V-001"
  "decomposition.max_pipeline_depth|integer|2|8|V-001"
  "decomposition.max_total_nodes|integer|10|500|V-001"
  "decomposition.explosion_alert_threshold|integer|50|100|V-001"
  "versioning.quality_regression_margin|integer|1|20|V-001"
  "backward_cascade.max_depth|integer|1|5|V-001"
  "pipeline_control.max_concurrent_pipelines|integer|1|20|V-001"
  "intake.max_queue_depth|integer|5|500|V-001"
  "intake.starvation_threshold_hours|integer|1|168|V-001"
  "intake.duplicate_similarity_threshold|number|0.5|1.0|V-001"
  "intake.max_clarifying_rounds|integer|1|10|V-001"
  "intake.response_timeout_minutes|integer|10|1440|V-001,V-002"
  "intake.rate_limits.submissions_per_hour|integer|1|100|V-001"
  "intake.rate_limits.queries_per_minute|integer|10|600|V-001"
  "notifications.batching.interval_minutes|integer|5|1440|V-001,V-002"
  "notifications.fatigue.threshold_per_hour|integer|5|200|V-001"
  "notifications.fatigue.digest_cooldown_minutes|integer|5|120|V-001,V-002"
  "notifications.cross_request.failure_window_minutes|integer|10|1440|V-001,V-002"
  "notifications.cross_request.failure_threshold|integer|2|20|V-001"
  "agents.anomaly_detection.approval_rate_threshold|number|0.0|1.0|V-001"
  "agents.anomaly_detection.escalation_rate_threshold|number|0.0|1.0|V-001"
  "agents.anomaly_detection.observation_threshold|integer|5|50|V-001"
  "agents.modification_rate_limits.max_new_agents_per_week|integer|0|5|V-001"
  "agents.modification_rate_limits.max_modifications_per_agent_per_week|integer|0|5|V-001"
  "agents.canary_period_days|integer|1|30|V-001"
  "production_intelligence.error_detection.default_error_rate_percent|number|0.1|100.0|V-001"
  "production_intelligence.error_detection.default_sustained_duration_min|integer|1|120|V-001"
  "production_intelligence.anomaly_detection.sensitivity|number|1.0|5.0|V-001"
  "production_intelligence.anomaly_detection.baseline_window_days|integer|7|90|V-001"
  "production_intelligence.trend_analysis.min_slope_threshold|number|0.01|0.5|V-001"
  "production_intelligence.governance.cooldown_days|integer|1|30|V-001"
  "production_intelligence.governance.oscillation_threshold|integer|2|10|V-001"
  "production_intelligence.governance.oscillation_window_days|integer|7|90|V-001"
  "production_intelligence.governance.effectiveness_comparison_days|integer|1|30|V-001"
  "production_intelligence.governance.effectiveness_improvement_threshold|number|0.01|0.5|V-001"
  "cleanup.auto_cleanup_interval_iterations|integer|10|1000|V-001"
  "retention.completed_request_days|integer|7|365|V-001"
  "retention.event_log_days|integer|30|365|V-001"
  "retention.cost_ledger_months|integer|3|60|V-001"
  "retention.daemon_log_days|integer|7|365|V-001"
  "retention.observation_report_days|integer|30|365|V-001"
  "retention.observation_archive_days|integer|90|1825|V-001"
  "retention.archive_days|integer|90|1825|V-001"
  "retention.config_validation_log_days|integer|1|30|V-001"
  "escalation.retry_limits.quality_gate_max_iterations|integer|1|10|V-001"
  "escalation.retry_limits.technical_max_approaches|integer|1|10|V-001"
)
```

For `daemon.max_turns_by_phase.*` (V-011): iterate all 13 phase keys, assert each is an integer >= 1.

For `state_machine.retry_limits_by_phase.*` (V-012): iterate all 13 phase keys, assert each is an integer >= 0.

For `review_gates.thresholds_by_type.*` (V-018): iterate all 5 type keys, assert each is an integer between 0 and 100 inclusive.

#### Step 3: Cross-Field Validation (V-003, V-004, V-019, V-020)

```bash
# V-003: daily_cost_cap_usd <= monthly_cost_cap_usd (Error)
daily=$(echo "$config" | jq '.governance.daily_cost_cap_usd')
monthly=$(echo "$config" | jq '.governance.monthly_cost_cap_usd')
if (( $(echo "$daily > $monthly" | bc -l) )); then
  emit_validation_error "V-003" "governance.daily_cost_cap_usd" "$daily" \
    "Must be <= governance.monthly_cost_cap_usd ($monthly)" "$source"
fi

# V-004: per_request_cost_cap_usd <= daily_cost_cap_usd (Warning)
per_req=$(echo "$config" | jq '.governance.per_request_cost_cap_usd')
if (( $(echo "$per_req > $daily" | bc -l) )); then
  emit_validation_warning "V-004" "governance.per_request_cost_cap_usd" "$per_req" \
    "Should be <= governance.daily_cost_cap_usd ($daily)" "$source"
fi

# V-019: rate_limit_backoff_max_seconds >= rate_limit_backoff_base_seconds (Error)
base=$(echo "$config" | jq '.governance.rate_limit_backoff_base_seconds')
max=$(echo "$config" | jq '.governance.rate_limit_backoff_max_seconds')
if (( max < base )); then
  emit_validation_error "V-019" "governance.rate_limit_backoff_max_seconds" "$max" \
    "Must be >= governance.rate_limit_backoff_base_seconds ($base)" "$source"
fi

# V-020: disk_hard_limit_gb >= disk_warning_threshold_gb (Error)
hard=$(echo "$config" | jq '.parallel.disk_hard_limit_gb')
warn=$(echo "$config" | jq '.parallel.disk_warning_threshold_gb')
if (( $(echo "$hard < $warn" | bc -l) )); then
  emit_validation_error "V-020" "parallel.disk_hard_limit_gb" "$hard" \
    "Must be >= parallel.disk_warning_threshold_gb ($warn)" "$source"
fi
```

#### Step 4: Path Validation (V-005, V-006)

```bash
# V-005: Each allowlist path must be absolute (Error)
# V-006: Each allowlist path must exist and contain .git (Warning)
while IFS= read -r repo_path; do
  if [[ "$repo_path" != /* ]]; then
    emit_validation_error "V-005" "repositories.allowlist" "$repo_path" \
      "Must be an absolute path" "$source"
  elif [[ ! -d "$repo_path" ]] || [[ ! -d "$repo_path/.git" ]]; then
    emit_validation_warning "V-006" "repositories.allowlist" "$repo_path" \
      "Path does not exist or is not a git repository" "$source"
  fi
done < <(echo "$config" | jq -r '.repositories.allowlist[]?')
```

#### Step 5: Enum and Special Validation (V-007, V-009, V-010, V-013, V-016)

```bash
# V-007: trust.system_default_level in {0,1,2,3} (already covered by range in step 2)

# V-009: DND times must be valid HH:MM (Error)
for field in "notifications.dnd.start" "notifications.dnd.end"; do
  value=$(echo "$config" | jq -r ".$field")
  if [[ ! "$value" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; then
    emit_validation_error "V-009" "$field" "$value" "Must be valid HH:MM format" "$source"
  fi
done

# V-010: DND timezone must be valid IANA timezone (Error)
tz=$(echo "$config" | jq -r '.notifications.dnd.timezone')
if [[ -n "$tz" ]] && [[ "$tz" != "null" ]]; then
  if ! TZ="$tz" date +%Z >/dev/null 2>&1; then
    emit_validation_error "V-010" "notifications.dnd.timezone" "$tz" \
      "Must be a valid IANA timezone string" "$source"
  fi
fi

# V-013: escalation.routing.mode in {"default", "advanced"} (Error)
mode=$(echo "$config" | jq -r '.escalation.routing.mode')
if [[ "$mode" != "default" && "$mode" != "advanced" ]]; then
  emit_validation_error "V-013" "escalation.routing.mode" "$mode" \
    'Must be "default" or "advanced"' "$source"
fi

# V-016: notifications.delivery.default_method in {"cli","discord","slack","file_drop"} (Error)
method=$(echo "$config" | jq -r '.notifications.delivery.default_method')
case "$method" in
  cli|discord|slack|file_drop) ;;
  *) emit_validation_error "V-016" "notifications.delivery.default_method" "$method" \
       'Must be one of "cli", "discord", "slack", "file_drop"' "$source" ;;
esac
```

#### Immutable Field Enforcement

```bash
# trust.promotion.require_human_approval must be true
val=$(echo "$config" | jq '.trust.promotion.require_human_approval')
if [[ "$val" != "true" ]]; then
  emit_validation_error "IMMUTABLE" "trust.promotion.require_human_approval" "$val" \
    "Immutable field: must be true" "$source"
fi

# emergency.restart_requires_human must be true
val=$(echo "$config" | jq '.emergency.restart_requires_human')
if [[ "$val" != "true" ]]; then
  emit_validation_error "IMMUTABLE" "emergency.restart_requires_human" "$val" \
    "Immutable field: must be true" "$source"
fi
```

#### Security Permissions Check (V-017)

```bash
# V-017: Warn if file is world/group-readable and contains webhook URLs
check_permissions() {
  local file_path="$1"
  local config_content="$2"
  local has_webhooks
  has_webhooks=$(echo "$config_content" | jq '[
    .notifications.delivery.discord.webhook_url,
    .notifications.delivery.slack.webhook_url
  ] | map(select(. != null and . != "")) | length')
  
  if (( has_webhooks > 0 )); then
    local perms
    if [[ "$(uname)" == "Darwin" ]]; then
      perms=$(stat -f "%Lp" "$file_path" 2>/dev/null)
    else
      perms=$(stat -c "%a" "$file_path" 2>/dev/null)
    fi
    # Check if group or other have read bits
    if [[ -n "$perms" ]] && (( (perms % 100 / 10) > 0 || (perms % 10) > 0 )); then
      emit_validation_warning "V-017" "file_permissions" "$perms" \
        "Config file is group/world-readable and contains webhook URLs" "$file_path"
    fi
  fi
}
```

### Structured Validation Error Output

**`emit_validation_error()`** and **`emit_validation_warning()`** both write a JSON object matching the Section 4.4 schema:

```bash
emit_validation_error() {
  local rule="$1" field="$2" value="$3" constraint="$4" source="$5"
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local message="${field}: ${constraint} (got: ${value})"
  
  local entry
  entry=$(jq -nc \
    --arg ts "$timestamp" \
    --arg level "error" \
    --arg rule "$rule" \
    --arg field "$field" \
    --argjson value "$(echo "$value" | jq -R '.')" \
    --arg constraint "$constraint" \
    --arg source "$source" \
    --arg message "$message" \
    '{timestamp:$ts, level:$level, rule:$rule, field:$field, value:$value, constraint:$constraint, source:$source, message:$message}')
  
  echo "$entry" >&2
  local log_dir="${HOME}/.autonomous-dev/logs"
  mkdir -p "$log_dir"
  echo "$entry" >> "${log_dir}/config-validation.log"
  
  VALIDATION_HAS_ERRORS=1
}
```

The log file is appended to, never overwritten. All errors are reported (the pipeline does not stop at the first error).

## Acceptance Criteria

1. `--config.governance.daily_cost_cap_usd=50` produces `{"governance":{"daily_cost_cap_usd":50}}` (number, not string).
2. `--config.trust.promotion.enabled=true` produces `{"trust":{"promotion":{"enabled":true}}}` (boolean).
3. `--config.escalation.routing.mode=advanced` produces `{"escalation":{"routing":{"mode":"advanced"}}}` (string).
4. Multiple CLI overrides merge correctly into a single JSON object.
5. All 20 validation rules (V-001 through V-020) are implemented.
6. Each Error-severity violation causes `validate_config` to return non-zero.
7. Warning-severity violations are logged but do not block (return code still 0 if only warnings).
8. Immutable fields (`require_human_approval`, `restart_requires_human`) reject `false` values with Error severity.
9. Each validation error includes: timestamp, level, rule ID, field path, invalid value, constraint description, source file path, and human-readable message.
10. Validation errors are written to both stderr and `~/.autonomous-dev/logs/config-validation.log`.
11. Log file is created if it does not exist.
12. Log file is appended, not overwritten.
13. All errors are reported (not just the first).

## Test Cases

1. **CLI number parsing**: `--config.governance.daily_cost_cap_usd=50` yields `50` (number).
2. **CLI float parsing**: `--config.parallel.disk_warning_threshold_gb=2.5` yields `2.5`.
3. **CLI boolean parsing**: `--config.trust.promotion.enabled=false` yields `false` (boolean).
4. **CLI string parsing**: `--config.escalation.routing.mode=advanced` yields `"advanced"` (string).
5. **CLI deep path**: `--config.daemon.max_turns_by_phase.code=150` yields `{"daemon":{"max_turns_by_phase":{"code":150}}}`.
6. **Multiple overrides**: Two overrides in different subtrees merge correctly.
7. **V-001 positive**: All numeric fields have valid numbers. Validation passes.
8. **V-001 negative**: `governance.daily_cost_cap_usd` is the string `"fifty"`. Validation fails with V-001.
9. **V-002 positive**: `daemon.poll_interval_seconds` is 30. Passes.
10. **V-002 negative**: `daemon.poll_interval_seconds` is 0. Fails with V-002.
11. **V-003 positive**: `daily_cost_cap_usd=100`, `monthly_cost_cap_usd=2000`. Passes.
12. **V-003 negative**: `daily_cost_cap_usd=150`, `monthly_cost_cap_usd=100`. Fails with V-003.
13. **V-004 positive**: `per_request_cost_cap_usd=50`, `daily_cost_cap_usd=100`. Passes.
14. **V-004 negative**: `per_request_cost_cap_usd=200`, `daily_cost_cap_usd=100`. Warns with V-004 (does not fail).
15. **V-005 positive**: Allowlist path `/Users/dev/repo`. Passes.
16. **V-005 negative**: Allowlist path `relative/path`. Fails with V-005.
17. **V-009 positive**: DND start `22:00`. Passes.
18. **V-009 negative**: DND start `25:00`. Fails with V-009.
19. **V-010 positive**: Timezone `America/New_York`. Passes.
20. **V-010 negative**: Timezone `Mars/Olympus_Mons`. Fails with V-010.
21. **V-017 positive**: Config file is 0600 with webhook URLs. No warning.
22. **V-017 negative**: Config file is 0644 with webhook URLs. Warns with V-017.
23. **V-019 negative**: `rate_limit_backoff_max_seconds=10`, `base=30`. Fails with V-019.
24. **V-020 negative**: `disk_hard_limit_gb=1.0`, `disk_warning_threshold_gb=2.0`. Fails with V-020.
25. **Immutable field**: `trust.promotion.require_human_approval=false`. Fails with IMMUTABLE.
26. **All errors reported**: Config with three violations produces three error entries in the log, not one.
27. **Structured output format**: Each error entry is valid JSON matching Section 4.4 schema.
