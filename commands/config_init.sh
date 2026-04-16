#!/usr/bin/env bash
# config_init.sh -- Generate default autonomous-dev config at global or project path
#
# Usage:
#   autonomous-dev config init --global [--force]
#   autonomous-dev config init --project [--force]
#
# Creates a minimal starter config file and a companion .commented reference file.

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve PLUGIN_ROOT
# ---------------------------------------------------------------------------
if [[ -z "${PLUGIN_ROOT:-}" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# ---------------------------------------------------------------------------
# generate_commented_config -- Produces a pseudo-JSON reference file
# with // comments documenting every field, its type, default, range,
# and description. For human reference only; not parsed by the system.
# ---------------------------------------------------------------------------
generate_commented_config() {
  cat <<'COMMENTED_EOF'
// autonomous-dev configuration reference
// This file is for documentation only. Edit autonomous-dev.json instead.
//
// Layer precedence: CLI flags > project > global > built-in defaults
{
  // --- Daemon ---
  // "daemon.poll_interval_seconds": 30,            // integer, 5-600. Seconds between daemon iterations.
  // "daemon.heartbeat_interval_seconds": 30,        // integer, 5-120. Heartbeat write interval.
  // "daemon.circuit_breaker_threshold": 3,           // integer, 1-20. Consecutive failures before circuit trip.
  // "daemon.log_retention_days": 30,                 // integer, 1-365. Days to retain daemon logs.
  // "daemon.idle_backoff_base_seconds": 30,          // integer, 5-300. Base idle backoff interval.
  // "daemon.idle_backoff_max_seconds": 900,          // integer, 60-3600. Maximum idle backoff interval.
  // "daemon.max_turns_by_phase.<phase>": <int>,      // integer >= 1. Max Claude turns per phase.
  //   Phases: intake, prd, prd_review, tdd, tdd_review, plan, plan_review,
  //           spec, spec_review, code, code_review, integration, deploy

  // --- State Machine ---
  // "state_machine.retry_limits_by_phase.<phase>": <int>,  // integer >= 0. Retries per phase.
  // "state_machine.timeouts_by_phase.<phase>": "<dur>",    // string. Phase timeout (e.g. "30m").
  // "state_machine.context_window_threshold_pct": 80,      // integer, 50-95. Context window usage trigger.

  // --- Governance ---
  // "governance.daily_cost_cap_usd": 100.00,         // number, 1-10000. Daily spend cap (UTC reset).
  // "governance.monthly_cost_cap_usd": 2000.00,      // number, 10-100000. Monthly spend cap (UTC reset).
  // "governance.per_request_cost_cap_usd": 50.00,    // number, 1-5000. Per-request spend cap.
  // "governance.max_concurrent_requests": 3,          // integer, 1-50. Max simultaneous requests.
  // "governance.disk_usage_limit_gb": 10.0,           // number, 1-500. Max disk usage in GB.
  // "governance.rate_limit_backoff_base_seconds": 30, // integer, 5-300. Rate-limit backoff base.
  // "governance.rate_limit_backoff_max_seconds": 900, // integer, 60-3600. Rate-limit backoff max.

  // --- Repositories ---
  // "repositories.allowlist": [],                     // array of strings. Absolute paths to allowed repos.
  // "repositories.overrides": {},                     // object. Per-repo config overrides keyed by path.

  // --- Trust ---
  // "trust.system_default_level": 1,                 // integer, 0-3. Default trust level for new repos.
  // "trust.repositories": {},                         // object. Per-repo trust overrides.
  // "trust.promotion.enabled": true,                  // boolean. Enable automatic trust promotion.
  // "trust.promotion.min_consecutive_successes": 20,  // integer. Successes needed for promotion.
  // "trust.promotion.require_human_approval": true,   // boolean. IMMUTABLE -- must be true.

  // --- Escalation ---
  // "escalation.routing.mode": "default",             // enum: "default" | "advanced".
  // "escalation.routing.default_target": "pm-lead",   // string. Default escalation target.
  // "escalation.routing.advanced.<category>.primary":  // string. Primary escalation target per category.
  // "escalation.routing.advanced.<category>.secondary":// string. Fallback escalation target.
  // "escalation.routing.advanced.<category>.timeout_minutes": // integer. Escalation timeout.
  //   Categories: product, technical, infrastructure, security, cost, quality
  // "escalation.timeout_behavior.default": "pause",   // string. What to do on escalation timeout.
  // "escalation.retry_limits.quality_gate_max_iterations": 3,    // integer, 1-10.
  // "escalation.retry_limits.technical_max_approaches": 3,       // integer, 1-10.
  // "escalation.verbosity.default": "standard",       // string. Escalation message verbosity.

  // --- Notifications ---
  // "notifications.delivery.default_method": "cli",   // enum: "cli" | "discord" | "slack" | "file_drop".
  // "notifications.delivery.discord.webhook_url": null,// string|null. Discord webhook URL.
  // "notifications.delivery.discord.channel_id": null, // string|null. Discord channel ID.
  // "notifications.delivery.slack.webhook_url": null,  // string|null. Slack webhook URL.
  // "notifications.delivery.slack.channel": null,      // string|null. Slack channel name.
  // "notifications.batching.enabled": true,            // boolean. Enable notification batching.
  // "notifications.batching.interval_minutes": 60,     // integer, 5-1440. Batching interval.
  // "notifications.batching.exempt_types": [...],      // array. Types exempt from batching.
  // "notifications.dnd.enabled": false,                // boolean. Enable do-not-disturb.
  // "notifications.dnd.start": "22:00",                // string, HH:MM. DND start time.
  // "notifications.dnd.end": "07:00",                  // string, HH:MM. DND end time.
  // "notifications.dnd.timezone": "America/New_York",  // string. IANA timezone for DND.
  // "notifications.dnd.breakthrough_urgency": [...],   // array. Urgency levels that bypass DND.
  // "notifications.fatigue.enabled": true,             // boolean. Enable fatigue detection.
  // "notifications.fatigue.threshold_per_hour": 20,    // integer, 5-200. Max notifications/hour.
  // "notifications.fatigue.digest_cooldown_minutes": 30,// integer, 5-120. Cooldown after digest.
  // "notifications.cross_request.enabled": true,       // boolean. Enable cross-request failure alerts.
  // "notifications.cross_request.failure_window_minutes": 60,  // integer, 10-1440.
  // "notifications.cross_request.failure_threshold": 3,        // integer, 2-20.
  // "notifications.summary_schedule": "daily",         // string. Summary notification schedule.
  // "notifications.daily_digest_time": "09:00",        // string. Daily digest time (HH:MM).

  // --- Review Gates ---
  // "review_gates.default_threshold": 85,             // integer, 0-100. Default pass threshold.
  // "review_gates.thresholds_by_type.PRD": 85,        // integer, 0-100.
  // "review_gates.thresholds_by_type.TDD": 85,        // integer, 0-100.
  // "review_gates.thresholds_by_type.Plan": 80,       // integer, 0-100.
  // "review_gates.thresholds_by_type.Spec": 80,       // integer, 0-100.
  // "review_gates.thresholds_by_type.Code": 85,       // integer, 0-100.
  // "review_gates.max_iterations": 3,                 // integer, 1-10. Max review iterations.
  // "review_gates.panel_size.<type>": <int>,           // integer. Number of reviewers per type.
  // "review_gates.score_aggregation": "mean",          // string. Aggregation method.
  // "review_gates.disagreement_threshold": 15,         // integer, 0-50.

  // --- Decomposition ---
  // "decomposition.max_children_per_parent": 10,      // integer, 1-50.
  // "decomposition.max_pipeline_depth": 4,             // integer, 2-8.
  // "decomposition.max_total_nodes": 100,              // integer, 10-500.
  // "decomposition.explosion_alert_threshold": 75,     // integer, 50-100.

  // --- Versioning ---
  // "versioning.quality_regression_margin": 5,         // integer, 1-20. Allowed regression margin.

  // --- Backward Cascade ---
  // "backward_cascade.max_depth": 2,                   // integer, 1-5. Max cascade depth.
  // "backward_cascade.require_human_confirmation": false,// boolean.

  // --- Parallel ---
  // "parallel.max_worktrees": 5,                       // integer, 1-20. Max git worktrees.
  // "parallel.max_tracks": 3,                          // integer, 1-10. Max parallel tracks.
  // "parallel.disk_warning_threshold_gb": 2.0,         // number, 0.5-50. Disk warning threshold.
  // "parallel.disk_hard_limit_gb": 5.0,                // number, 1-100. Disk hard limit.
  // "parallel.stall_timeout_minutes": 15,              // integer, 5-120. Stall detection timeout.
  // "parallel.agent_turn_budget.<size>": <int>,        // integer. Turn budget by task size.
  // "parallel.conflict_ai_confidence_threshold": 0.85, // number, 0.0-1.0.
  // "parallel.worktree_cleanup_delay_seconds": 300,    // integer, 0-3600.

  // --- Pipeline Control ---
  // "pipeline_control.default_priority": "normal",     // string. Default pipeline priority.
  // "pipeline_control.max_concurrent_pipelines": 5,    // integer, 1-20.

  // --- Agents ---
  // "agents.anomaly_detection.approval_rate_threshold": 0.70,    // number, 0.0-1.0.
  // "agents.anomaly_detection.escalation_rate_threshold": 0.30,  // number, 0.0-1.0.
  // "agents.anomaly_detection.observation_threshold": 10,        // integer, 5-50.
  // "agents.modification_rate_limits.max_new_agents_per_week": 1,            // integer, 0-5.
  // "agents.modification_rate_limits.max_modifications_per_agent_per_week": 1,// integer, 0-5.
  // "agents.canary_period_days": 7,                    // integer, 1-30.

  // --- Production Intelligence ---
  // "production_intelligence.enabled": true,            // boolean.
  // "production_intelligence.schedule": "0 */4 * * *",  // string. Cron schedule.
  // "production_intelligence.error_detection.default_error_rate_percent": 5.0,   // number, 0.1-100.
  // "production_intelligence.error_detection.default_sustained_duration_min": 10, // integer, 1-120.
  // "production_intelligence.anomaly_detection.method": "z_score",  // string.
  // "production_intelligence.anomaly_detection.sensitivity": 2.5,   // number, 1.0-5.0.
  // "production_intelligence.anomaly_detection.baseline_window_days": 14,  // integer, 7-90.
  // "production_intelligence.trend_analysis.enabled": true,         // boolean.
  // "production_intelligence.trend_analysis.windows": [7, 14, 30], // array of integers.
  // "production_intelligence.trend_analysis.min_slope_threshold": 0.05, // number, 0.01-0.5.
  // "production_intelligence.governance.cooldown_days": 7,          // integer, 1-30.
  // "production_intelligence.governance.oscillation_threshold": 3,  // integer, 2-10.
  // "production_intelligence.governance.oscillation_window_days": 30, // integer, 7-90.
  // "production_intelligence.governance.effectiveness_comparison_days": 7,     // integer, 1-30.
  // "production_intelligence.governance.effectiveness_improvement_threshold": 0.10, // number, 0.01-0.5.

  // --- Intake ---
  // "intake.max_queue_depth": 50,                      // integer, 5-500.
  // "intake.starvation_threshold_hours": 48,            // integer, 1-168.
  // "intake.duplicate_similarity_threshold": 0.85,      // number, 0.5-1.0.
  // "intake.max_clarifying_rounds": 5,                  // integer, 1-10.
  // "intake.response_timeout_minutes": 240,             // integer, 10-1440.
  // "intake.response_timeout_action": "pause",          // string.
  // "intake.rate_limits.submissions_per_hour": 10,      // integer, 1-100.
  // "intake.rate_limits.queries_per_minute": 60,        // integer, 10-600.

  // --- Cleanup ---
  // "cleanup.auto_cleanup_interval_iterations": 100,    // integer, 10-1000.
  // "cleanup.delete_remote_branches": true,             // boolean.

  // --- Retention ---
  // "retention.completed_request_days": 30,             // integer, 7-365.
  // "retention.event_log_days": 90,                     // integer, 30-365.
  // "retention.cost_ledger_months": 12,                 // integer, 3-60.
  // "retention.daemon_log_days": 30,                    // integer, 7-365.
  // "retention.observation_report_days": 90,            // integer, 30-365.
  // "retention.observation_archive_days": 365,          // integer, 90-1825.
  // "retention.archive_days": 365,                      // integer, 90-1825.
  // "retention.config_validation_log_days": 7,          // integer, 1-30.

  // --- Audit ---
  // "audit.integrity.hash_chain_enabled": false,        // boolean.

  // --- Emergency ---
  // "emergency.kill_default_mode": "graceful",          // string.
  // "emergency.restart_requires_human": true,           // boolean. IMMUTABLE -- must be true.
}
COMMENTED_EOF
}

# ---------------------------------------------------------------------------
# config_init -- Main entry point
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Run if executed directly (not sourced)
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  config_init "$@"
fi
