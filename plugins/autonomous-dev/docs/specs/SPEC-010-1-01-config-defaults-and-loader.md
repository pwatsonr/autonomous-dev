# SPEC-010-1-01: Config Defaults File & Layer Loading with Deep Merge

## Metadata
- **Parent Plan**: PLAN-010-1
- **Tasks Covered**: Task 1, Task 2
- **Estimated effort**: 10 hours

## Description

Create the built-in `config_defaults.json` file transcribing the complete configuration schema from TDD-010 Section 4.1, and implement `config_loader.sh` with four-layer precedence loading and `jq`-based deep merge with array-replace semantics.

## Files to Create/Modify

| Action | Path | Purpose |
|--------|------|---------|
| Create | `config_defaults.json` | Built-in defaults layer (lowest precedence) |
| Create | `lib/config_loader.sh` | Layer reading, deep merge, effective config production |

## Implementation Details

### config_defaults.json

The file contains every field from TDD-010 Section 4.1 with its documented default value. The file uses flat values (no type/min/max metadata -- those are for validation). The structure is:

```json
{
  "$schema_version": 1,

  "daemon": {
    "poll_interval_seconds": 30,
    "heartbeat_interval_seconds": 30,
    "circuit_breaker_threshold": 3,
    "log_retention_days": 30,
    "idle_backoff_base_seconds": 30,
    "idle_backoff_max_seconds": 900,
    "max_turns_by_phase": {
      "intake": 10,
      "prd": 50,
      "prd_review": 30,
      "tdd": 50,
      "tdd_review": 30,
      "plan": 50,
      "plan_review": 30,
      "spec": 50,
      "spec_review": 30,
      "code": 200,
      "code_review": 50,
      "integration": 100,
      "deploy": 30
    }
  },

  "state_machine": {
    "retry_limits_by_phase": {
      "intake": 1,
      "prd": 2,
      "prd_review": 3,
      "tdd": 2,
      "tdd_review": 3,
      "plan": 2,
      "plan_review": 3,
      "spec": 2,
      "spec_review": 3,
      "code": 3,
      "code_review": 3,
      "integration": 2,
      "deploy": 2
    },
    "timeouts_by_phase": {
      "intake": "5m",
      "prd": "30m",
      "prd_review": "20m",
      "tdd": "45m",
      "tdd_review": "20m",
      "plan": "30m",
      "plan_review": "20m",
      "spec": "45m",
      "spec_review": "20m",
      "code": "120m",
      "code_review": "30m",
      "integration": "60m",
      "deploy": "30m"
    },
    "context_window_threshold_pct": 80
  },

  "governance": {
    "daily_cost_cap_usd": 100.00,
    "monthly_cost_cap_usd": 2000.00,
    "per_request_cost_cap_usd": 50.00,
    "max_concurrent_requests": 3,
    "disk_usage_limit_gb": 10.0,
    "rate_limit_backoff_base_seconds": 30,
    "rate_limit_backoff_max_seconds": 900
  },

  "repositories": {
    "allowlist": [],
    "overrides": {}
  },

  "trust": {
    "system_default_level": 1,
    "repositories": {},
    "promotion": {
      "enabled": true,
      "min_consecutive_successes": 20,
      "require_human_approval": true
    }
  },

  "escalation": {
    "routing": {
      "mode": "default",
      "default_target": "pm-lead",
      "advanced": {
        "product":        { "primary": "pm-lead",       "secondary": "tech-lead",     "timeout_minutes": 60 },
        "technical":      { "primary": "tech-lead",     "secondary": "pm-lead",       "timeout_minutes": 120 },
        "infrastructure": { "primary": "sys-operator",  "secondary": "tech-lead",     "timeout_minutes": 30 },
        "security":       { "primary": "security-lead", "secondary": "pm-lead",       "timeout_minutes": 15 },
        "cost":           { "primary": "pm-lead",       "timeout_minutes": 60 },
        "quality":        { "primary": "tech-lead",     "secondary": "pm-lead",       "timeout_minutes": 120 }
      }
    },
    "timeout_behavior": {
      "default": "pause",
      "overrides": {}
    },
    "retry_limits": {
      "quality_gate_max_iterations": 3,
      "technical_max_approaches": 3
    },
    "verbosity": {
      "default": "standard",
      "overrides": {}
    }
  },

  "notifications": {
    "delivery": {
      "default_method": "cli",
      "overrides": {},
      "channels": [{"type": "file", "path": "~/.autonomous-dev/notifications.log"}],
      "discord": {
        "webhook_url": null,
        "channel_id": null
      },
      "slack": {
        "webhook_url": null,
        "channel": null
      }
    },
    "batching": {
      "enabled": true,
      "interval_minutes": 60,
      "exempt_types": ["escalation", "error"]
    },
    "dnd": {
      "enabled": false,
      "start": "22:00",
      "end": "07:00",
      "timezone": "America/New_York",
      "breakthrough_urgency": ["immediate"]
    },
    "fatigue": {
      "enabled": true,
      "threshold_per_hour": 20,
      "digest_cooldown_minutes": 30
    },
    "cross_request": {
      "enabled": true,
      "failure_window_minutes": 60,
      "failure_threshold": 3
    },
    "summary_schedule": "daily",
    "daily_digest_time": "09:00"
  },

  "review_gates": {
    "default_threshold": 85,
    "thresholds_by_type": {
      "PRD": 85,
      "TDD": 85,
      "Plan": 80,
      "Spec": 80,
      "Code": 85
    },
    "max_iterations": 3,
    "panel_size": {
      "PRD": 2,
      "TDD": 2,
      "Plan": 1,
      "Spec": 1,
      "Code": 2
    },
    "score_aggregation": "mean",
    "disagreement_threshold": 15
  },

  "decomposition": {
    "max_children_per_parent": 10,
    "max_pipeline_depth": 4,
    "max_total_nodes": 100,
    "explosion_alert_threshold": 75
  },

  "versioning": {
    "quality_regression_margin": 5
  },

  "backward_cascade": {
    "max_depth": 2,
    "require_human_confirmation": false
  },

  "parallel": {
    "max_worktrees": 5,
    "max_tracks": 3,
    "disk_warning_threshold_gb": 2.0,
    "disk_hard_limit_gb": 5.0,
    "stall_timeout_minutes": 15,
    "agent_turn_budget": {
      "small": 30,
      "medium": 60,
      "large": 120
    },
    "conflict_ai_confidence_threshold": 0.85,
    "worktree_cleanup_delay_seconds": 300
  },

  "pipeline_control": {
    "default_priority": "normal",
    "max_concurrent_pipelines": 5
  },

  "agents": {
    "anomaly_detection": {
      "approval_rate_threshold": 0.70,
      "escalation_rate_threshold": 0.30,
      "observation_threshold": 10
    },
    "modification_rate_limits": {
      "max_new_agents_per_week": 1,
      "max_modifications_per_agent_per_week": 1
    },
    "canary_period_days": 7
  },

  "production_intelligence": {
    "enabled": true,
    "schedule": "0 */4 * * *",
    "error_detection": {
      "default_error_rate_percent": 5.0,
      "default_sustained_duration_min": 10
    },
    "anomaly_detection": {
      "method": "z_score",
      "sensitivity": 2.5,
      "baseline_window_days": 14
    },
    "trend_analysis": {
      "enabled": true,
      "windows": [7, 14, 30],
      "min_slope_threshold": 0.05
    },
    "governance": {
      "cooldown_days": 7,
      "oscillation_threshold": 3,
      "oscillation_window_days": 30,
      "effectiveness_comparison_days": 7,
      "effectiveness_improvement_threshold": 0.10
    }
  },

  "intake": {
    "max_queue_depth": 50,
    "starvation_threshold_hours": 48,
    "duplicate_similarity_threshold": 0.85,
    "max_clarifying_rounds": 5,
    "response_timeout_minutes": 240,
    "response_timeout_action": "pause",
    "rate_limits": {
      "submissions_per_hour": 10,
      "queries_per_minute": 60
    }
  },

  "cleanup": {
    "auto_cleanup_interval_iterations": 100,
    "delete_remote_branches": true
  },

  "retention": {
    "completed_request_days": 30,
    "event_log_days": 90,
    "cost_ledger_months": 12,
    "daemon_log_days": 30,
    "observation_report_days": 90,
    "observation_archive_days": 365,
    "archive_days": 365,
    "config_validation_log_days": 7
  },

  "audit": {
    "integrity": {
      "hash_chain_enabled": false
    }
  },

  "emergency": {
    "kill_default_mode": "graceful",
    "restart_requires_human": true
  }
}
```

### lib/config_loader.sh

#### Public API

```bash
# Source this file, then call:
#   load_config [--config.key.subkey=value ...]
# Returns: merged JSON on stdout
# Exit code: 0 on success, 1 on validation error
```

#### Key Functions

**`load_config()`** -- Entry point. Orchestrates the full load:
1. Verify `jq` is installed (`command -v jq` or exit 1 with error).
2. Read built-in defaults from `${PLUGIN_ROOT}/config_defaults.json`.
3. Read global config from `${HOME}/.claude/autonomous-dev.json` (skip if missing, log warning).
4. Read project config from `${REPO_ROOT}/.claude/autonomous-dev.json` (skip if missing, log warning).
5. Parse CLI overrides into a JSON object.
6. Merge in order: `defaults * global * project * cli_overrides` using `merge_configs()`.
7. Return the merged JSON on stdout.

**`merge_configs()`** -- Two-argument recursive deep merge using `jq`:

```bash
merge_configs() {
  local base="$1"
  local overlay="$2"
  jq -n --argjson base "$base" --argjson overlay "$overlay" '$base * $overlay'
}
```

The `jq` `*` operator handles array-replace semantics natively (overlay arrays replace base arrays entirely).

**`read_config_file()`** -- Safely read a JSON config file:

```bash
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
```

**Layer merge chain** (four-layer):

```bash
local merged
merged=$(merge_configs "$defaults" "$global_config")
merged=$(merge_configs "$merged" "$project_config")
merged=$(merge_configs "$merged" "$cli_overrides")
```

## Acceptance Criteria

1. `config_defaults.json` passes `jq .` without error.
2. Every field from TDD-010 Section 4.1 is present with its documented default value -- no field is omitted.
3. Four-layer merge produces correct output when all layers are present.
4. Four-layer merge produces correct output when global and/or project layers are absent (falls back silently with a log warning).
5. Four-layer merge produces correct output when a layer is an empty `{}` object.
6. Array fields from higher-precedence layers fully replace lower-precedence arrays (no concatenation).
7. Missing layers are silently skipped with a log warning to stderr.
8. `load_config` exits with code 1 and a clear error if `jq` is not installed.
9. `load_config` exits with code 1 if any config file is present but contains invalid JSON.
10. Deeply nested object merges work correctly (e.g., `daemon.max_turns_by_phase.code` from project overrides `defaults`).

## Test Cases

1. **Defaults-only load**: No global or project config exists. `load_config` returns the full defaults JSON. Every field matches `config_defaults.json`.
2. **Global override**: Global config sets `governance.daily_cost_cap_usd: 200`. Merged result has 200 for that field and defaults for all others.
3. **Project override over global**: Global sets `governance.daily_cost_cap_usd: 200`. Project sets it to `150`. Merged result is 150.
4. **Array replacement**: Defaults has `repositories.allowlist: []`. Global sets `["/repo/a", "/repo/b"]`. Project sets `["/repo/c"]`. Merged result is `["/repo/c"]` (not `["/repo/a", "/repo/b", "/repo/c"]`).
5. **Deep nested merge**: Global sets `daemon.max_turns_by_phase.code: 100`. Project sets `daemon.max_turns_by_phase.prd: 30`. Merged result has `code: 100` AND `prd: 30` (both applied, not one replacing the other at the object level).
6. **Empty layer**: Global config is `{}`. Project config sets one field. Merge produces defaults with only the project's one field overridden.
7. **Missing global file**: Global config path does not exist. No error. Merged result equals defaults merged with project.
8. **Invalid JSON global file**: Global config contains `{invalid`. `load_config` returns exit code 1 with error on stderr.
9. **jq not installed**: `jq` is not on PATH. `load_config` returns exit code 1 with "jq is required" message.
10. **Null value handling**: Global config sets `governance.disk_usage_limit_gb: null`. After merge, the key is removed by `jq *` semantics. Document this behavior.
