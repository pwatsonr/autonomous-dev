#!/usr/bin/env bash
# config_validator.sh -- Five-step validation pipeline for autonomous-dev config
#
# Source this file, then call:
#   validate_config <merged_json> [source_label]
#
# Exit code: 0 if only warnings (or clean), 1 if any Error-severity violation.
# All errors/warnings are written to stderr AND appended to
# ~/.autonomous-dev/logs/config-validation.log
#
# Implements rules V-001 through V-020 plus immutable field enforcement.

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve PLUGIN_ROOT if not already set
# ---------------------------------------------------------------------------
if [[ -z "${PLUGIN_ROOT:-}" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# ---------------------------------------------------------------------------
# Global state -- reset per validate_config invocation
# ---------------------------------------------------------------------------
VALIDATION_HAS_ERRORS=0

# ---------------------------------------------------------------------------
# Logging helpers (to stderr so stdout stays clean)
# ---------------------------------------------------------------------------
_validator_log() {
  echo "[config_validator] $*" >&2
}

# ---------------------------------------------------------------------------
# emit_validation_error -- Structured Error output (JSON to stderr + log)
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# emit_validation_warning -- Structured Warning output (JSON to stderr + log)
# ---------------------------------------------------------------------------
emit_validation_warning() {
  local rule="$1" field="$2" value="$3" constraint="$4" source="$5"
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local message="${field}: ${constraint} (got: ${value})"

  local entry
  entry=$(jq -nc \
    --arg ts "$timestamp" \
    --arg level "warning" \
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
}

# ===========================================================================
# Step 2: Schema Type/Range Validation
# ===========================================================================

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

# Phase keys for V-011 and V-012
PHASE_KEYS=(
  "intake" "prd" "prd_review" "tdd" "tdd_review"
  "plan" "plan_review" "spec" "spec_review"
  "code" "code_review" "integration" "deploy"
)

# Review gate type keys for V-018
REVIEW_GATE_TYPES=("PRD" "TDD" "Plan" "Spec" "Code")

# ---------------------------------------------------------------------------
# validate_numeric_rules -- Run all NUMERIC_RULES against the config
# ---------------------------------------------------------------------------
validate_numeric_rules() {
  local config="$1"
  local source="$2"

  for rule_line in "${NUMERIC_RULES[@]}"; do
    IFS='|' read -r json_path expected_type min_val max_val rule_ids <<< "$rule_line"

    # Convert dot-path to jq path
    local jq_path
    jq_path=$(echo "$json_path" | sed 's/\././g')
    local raw_value
    raw_value=$(echo "$config" | jq -r ".${jq_path} // empty")

    # If the field is absent/null, skip (it may be optional or defaulted)
    if [[ -z "$raw_value" ]]; then
      continue
    fi

    # V-001: Check it is actually a number
    if ! echo "$raw_value" | jq -e 'tonumber' > /dev/null 2>&1; then
      emit_validation_error "V-001" "$json_path" "$raw_value" \
        "Must be a $expected_type" "$source"
      continue
    fi

    local num_value="$raw_value"

    # For integer type, check there is no decimal part
    if [[ "$expected_type" == "integer" ]]; then
      if echo "$num_value" | grep -q '\.'; then
        emit_validation_error "V-001" "$json_path" "$raw_value" \
          "Must be an integer (no decimal point)" "$source"
        continue
      fi
    fi

    # Range check
    if (( $(echo "$num_value < $min_val" | bc -l) )); then
      # Determine which rule to cite
      local range_rule
      range_rule=$(echo "$rule_ids" | tr ',' '\n' | head -1)
      emit_validation_error "$range_rule" "$json_path" "$raw_value" \
        "Must be >= $min_val and <= $max_val" "$source"
    elif (( $(echo "$num_value > $max_val" | bc -l) )); then
      local range_rule
      range_rule=$(echo "$rule_ids" | tr ',' '\n' | head -1)
      emit_validation_error "$range_rule" "$json_path" "$raw_value" \
        "Must be >= $min_val and <= $max_val" "$source"
    fi
  done
}

# ---------------------------------------------------------------------------
# validate_phase_map -- V-011: max_turns_by_phase, V-012: retry_limits_by_phase
# ---------------------------------------------------------------------------
validate_phase_maps() {
  local config="$1"
  local source="$2"

  # V-011: daemon.max_turns_by_phase.* must be integer >= 1
  for phase in "${PHASE_KEYS[@]}"; do
    local val
    val=$(echo "$config" | jq -r ".daemon.max_turns_by_phase.${phase} // empty")
    if [[ -z "$val" ]]; then
      continue
    fi
    if ! echo "$val" | jq -e 'tonumber' > /dev/null 2>&1; then
      emit_validation_error "V-011" "daemon.max_turns_by_phase.${phase}" "$val" \
        "Must be an integer >= 1" "$source"
      continue
    fi
    if echo "$val" | grep -q '\.'; then
      emit_validation_error "V-011" "daemon.max_turns_by_phase.${phase}" "$val" \
        "Must be an integer (no decimal point)" "$source"
      continue
    fi
    if (( val < 1 )); then
      emit_validation_error "V-011" "daemon.max_turns_by_phase.${phase}" "$val" \
        "Must be an integer >= 1" "$source"
    fi
  done

  # V-012: state_machine.retry_limits_by_phase.* must be integer >= 0
  for phase in "${PHASE_KEYS[@]}"; do
    local val
    val=$(echo "$config" | jq -r ".state_machine.retry_limits_by_phase.${phase} // empty")
    if [[ -z "$val" ]]; then
      continue
    fi
    if ! echo "$val" | jq -e 'tonumber' > /dev/null 2>&1; then
      emit_validation_error "V-012" "state_machine.retry_limits_by_phase.${phase}" "$val" \
        "Must be an integer >= 0" "$source"
      continue
    fi
    if echo "$val" | grep -q '\.'; then
      emit_validation_error "V-012" "state_machine.retry_limits_by_phase.${phase}" "$val" \
        "Must be an integer (no decimal point)" "$source"
      continue
    fi
    if (( val < 0 )); then
      emit_validation_error "V-012" "state_machine.retry_limits_by_phase.${phase}" "$val" \
        "Must be an integer >= 0" "$source"
    fi
  done
}

# ---------------------------------------------------------------------------
# validate_review_gate_thresholds -- V-018: thresholds_by_type 0..100
# ---------------------------------------------------------------------------
validate_review_gate_thresholds() {
  local config="$1"
  local source="$2"

  for gate_type in "${REVIEW_GATE_TYPES[@]}"; do
    local val
    val=$(echo "$config" | jq -r ".review_gates.thresholds_by_type.${gate_type} // empty")
    if [[ -z "$val" ]]; then
      continue
    fi
    if ! echo "$val" | jq -e 'tonumber' > /dev/null 2>&1; then
      emit_validation_error "V-018" "review_gates.thresholds_by_type.${gate_type}" "$val" \
        "Must be an integer between 0 and 100" "$source"
      continue
    fi
    if echo "$val" | grep -q '\.'; then
      emit_validation_error "V-018" "review_gates.thresholds_by_type.${gate_type}" "$val" \
        "Must be an integer (no decimal point)" "$source"
      continue
    fi
    if (( val < 0 || val > 100 )); then
      emit_validation_error "V-018" "review_gates.thresholds_by_type.${gate_type}" "$val" \
        "Must be an integer between 0 and 100" "$source"
    fi
  done
}

# ===========================================================================
# Step 3: Cross-Field Validation
# ===========================================================================
validate_cross_field() {
  local config="$1"
  local source="$2"

  # V-003: daily_cost_cap_usd <= monthly_cost_cap_usd (Error)
  local daily monthly
  daily=$(echo "$config" | jq '.governance.daily_cost_cap_usd')
  monthly=$(echo "$config" | jq '.governance.monthly_cost_cap_usd')
  if [[ "$daily" != "null" ]] && [[ "$monthly" != "null" ]]; then
    if (( $(echo "$daily > $monthly" | bc -l) )); then
      emit_validation_error "V-003" "governance.daily_cost_cap_usd" "$daily" \
        "Must be <= governance.monthly_cost_cap_usd ($monthly)" "$source"
    fi
  fi

  # V-004: per_request_cost_cap_usd <= daily_cost_cap_usd (Warning)
  local per_req
  per_req=$(echo "$config" | jq '.governance.per_request_cost_cap_usd')
  if [[ "$per_req" != "null" ]] && [[ "$daily" != "null" ]]; then
    if (( $(echo "$per_req > $daily" | bc -l) )); then
      emit_validation_warning "V-004" "governance.per_request_cost_cap_usd" "$per_req" \
        "Should be <= governance.daily_cost_cap_usd ($daily)" "$source"
    fi
  fi

  # V-019: rate_limit_backoff_max_seconds >= rate_limit_backoff_base_seconds (Error)
  local base max_val
  base=$(echo "$config" | jq '.governance.rate_limit_backoff_base_seconds')
  max_val=$(echo "$config" | jq '.governance.rate_limit_backoff_max_seconds')
  if [[ "$base" != "null" ]] && [[ "$max_val" != "null" ]]; then
    if (( max_val < base )); then
      emit_validation_error "V-019" "governance.rate_limit_backoff_max_seconds" "$max_val" \
        "Must be >= governance.rate_limit_backoff_base_seconds ($base)" "$source"
    fi
  fi

  # V-020: disk_hard_limit_gb >= disk_warning_threshold_gb (Error)
  local hard warn
  hard=$(echo "$config" | jq '.parallel.disk_hard_limit_gb')
  warn=$(echo "$config" | jq '.parallel.disk_warning_threshold_gb')
  if [[ "$hard" != "null" ]] && [[ "$warn" != "null" ]]; then
    if (( $(echo "$hard < $warn" | bc -l) )); then
      emit_validation_error "V-020" "parallel.disk_hard_limit_gb" "$hard" \
        "Must be >= parallel.disk_warning_threshold_gb ($warn)" "$source"
    fi
  fi
}

# ===========================================================================
# Step 4: Path Validation
# ===========================================================================
validate_paths() {
  local config="$1"
  local source="$2"

  # V-005: Each allowlist path must be absolute (Error)
  # V-006: Each allowlist path must exist and contain .git (Warning)
  while IFS= read -r repo_path; do
    if [[ -z "$repo_path" ]]; then
      continue
    fi
    if [[ "$repo_path" != /* ]]; then
      emit_validation_error "V-005" "repositories.allowlist" "$repo_path" \
        "Must be an absolute path" "$source"
    elif [[ ! -d "$repo_path" ]] || [[ ! -d "$repo_path/.git" ]]; then
      emit_validation_warning "V-006" "repositories.allowlist" "$repo_path" \
        "Path does not exist or is not a git repository" "$source"
    fi
  done < <(echo "$config" | jq -r '.repositories.allowlist[]?')
}

# ===========================================================================
# Step 5: Enum and Special Validation
# ===========================================================================
validate_enums_and_special() {
  local config="$1"
  local source="$2"

  # V-007: trust.system_default_level in {0,1,2,3}
  # (Already covered by range in step 2 numeric rules)

  # V-009: DND times must be valid HH:MM (Error)
  for field in "notifications.dnd.start" "notifications.dnd.end"; do
    local value
    value=$(echo "$config" | jq -r ".${field}")
    if [[ "$value" == "null" ]] || [[ -z "$value" ]]; then
      continue
    fi
    if [[ ! "$value" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; then
      emit_validation_error "V-009" "$field" "$value" "Must be valid HH:MM format" "$source"
    fi
  done

  # V-010: DND timezone must be valid IANA timezone (Error)
  local tz
  tz=$(echo "$config" | jq -r '.notifications.dnd.timezone')
  if [[ -n "$tz" ]] && [[ "$tz" != "null" ]]; then
    if ! TZ="$tz" date +%Z >/dev/null 2>&1; then
      emit_validation_error "V-010" "notifications.dnd.timezone" "$tz" \
        "Must be a valid IANA timezone string" "$source"
    fi
  fi

  # V-013: escalation.routing.mode in {"default", "advanced"} (Error)
  local mode
  mode=$(echo "$config" | jq -r '.escalation.routing.mode')
  if [[ "$mode" != "null" ]] && [[ -n "$mode" ]]; then
    if [[ "$mode" != "default" && "$mode" != "advanced" ]]; then
      emit_validation_error "V-013" "escalation.routing.mode" "$mode" \
        'Must be "default" or "advanced"' "$source"
    fi
  fi

  # V-016: notifications.delivery.default_method in {"cli","discord","slack","file_drop"} (Error)
  local method
  method=$(echo "$config" | jq -r '.notifications.delivery.default_method')
  if [[ "$method" != "null" ]] && [[ -n "$method" ]]; then
    case "$method" in
      cli|discord|slack|file_drop) ;;
      *) emit_validation_error "V-016" "notifications.delivery.default_method" "$method" \
           'Must be one of "cli", "discord", "slack", "file_drop"' "$source" ;;
    esac
  fi
}

# ===========================================================================
# Immutable Field Enforcement
# ===========================================================================
validate_immutable_fields() {
  local config="$1"
  local source="$2"

  # trust.promotion.require_human_approval must be true
  local val
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
}

# ===========================================================================
# Security Permissions Check (V-017)
# ===========================================================================
check_permissions() {
  local file_path="$1"
  local config_content="$2"

  # Skip if file does not exist
  if [[ ! -f "$file_path" ]]; then
    return 0
  fi

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

# ===========================================================================
# validate_config -- Entry point for the five-step validation pipeline
#
# Usage: validate_config <merged_json> [source_label]
#   merged_json: the fully-merged config JSON string
#   source_label: optional label for error messages (default: "merged")
#
# Returns: 0 if no errors (warnings OK), 1 if any Error-severity violation.
# ===========================================================================
validate_config() {
  local config="${1:-}"
  local source="${2:-merged}"

  # Reset error state
  VALIDATION_HAS_ERRORS=0

  # Verify jq is available
  if ! command -v jq > /dev/null 2>&1; then
    _validator_log "ERROR: jq is required but not installed."
    return 1
  fi

  # Step 1: JSON Parse Check -- merged result must be a valid JSON object
  local config_type
  config_type=$(echo "$config" | jq -r 'type' 2>/dev/null) || {
    emit_validation_error "PARSE" "root" "$config" \
      "Merged config is not valid JSON" "$source"
    return 1
  }
  if [[ "$config_type" != "object" ]]; then
    emit_validation_error "PARSE" "root" "$config_type" \
      "Merged config must be a JSON object" "$source"
    return 1
  fi

  # Step 2: Schema Type/Range Validation (V-001, V-002, V-007, V-008, V-011, V-012, V-014, V-015, V-018)
  validate_numeric_rules "$config" "$source"
  validate_phase_maps "$config" "$source"
  validate_review_gate_thresholds "$config" "$source"

  # Step 3: Cross-Field Validation (V-003, V-004, V-019, V-020)
  validate_cross_field "$config" "$source"

  # Step 4: Path Validation (V-005, V-006)
  validate_paths "$config" "$source"

  # Step 5: Enum and Special Validation (V-007, V-009, V-010, V-013, V-016)
  validate_enums_and_special "$config" "$source"

  # Immutable Field Enforcement
  validate_immutable_fields "$config" "$source"

  # Security Permissions Check (V-017)
  # Check global config file
  local global_path="${HOME}/.claude/autonomous-dev.json"
  if [[ -f "$global_path" ]]; then
    local global_content
    global_content=$(cat "$global_path" 2>/dev/null || echo "{}")
    check_permissions "$global_path" "$global_content"
  fi
  # Check project config file
  if [[ -n "${REPO_ROOT:-}" ]]; then
    local project_path="${REPO_ROOT}/.claude/autonomous-dev.json"
    if [[ -f "$project_path" ]]; then
      local project_content
      project_content=$(cat "$project_path" 2>/dev/null || echo "{}")
      check_permissions "$project_path" "$project_content"
    fi
  fi

  # Return based on error state
  if (( VALIDATION_HAS_ERRORS )); then
    return 1
  fi
  return 0
}
