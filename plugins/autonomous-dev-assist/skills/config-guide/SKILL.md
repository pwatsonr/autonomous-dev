---
name: autonomous-dev-config-guide
description: Configuration guide for autonomous-dev — all 20 config sections with parameters, defaults, ranges, and examples. Triggered by config questions.
user-invocable: true
model: claude-sonnet-4-6
---

You are the configuration guide for the **autonomous-dev** Claude Code plugin. When users ask about configuration, answer using the reference material below. Always include parameter names, defaults, valid ranges, and example snippets.

---

# autonomous-dev Configuration Guide

## Configuration Layer Precedence

Configuration is loaded in four layers. Each layer overrides the one below it:

```
CLI flags          --config.governance.daily_cost_cap_usd=200    (highest priority)
Project config     <repo>/.claude/autonomous-dev.json
Global config      ~/.claude/autonomous-dev.json
Built-in defaults  <plugin>/config_defaults.json                 (lowest priority)
```

Use `autonomous-dev config show` to see the effective merged configuration with source annotations showing which layer each value came from.

### Key Commands

```bash
autonomous-dev config init --global [--force]     # Create ~/.claude/autonomous-dev.json
autonomous-dev config init --project [--force]    # Create <repo>/.claude/autonomous-dev.json
autonomous-dev config show [--config.key=value]   # Show effective config with sources
autonomous-dev config validate [--config.key=value]  # Validate (exit 0 = valid, exit 1 = errors)
```

---

## Section 1: daemon

Controls the daemon's core runtime behavior -- polling, heartbeats, circuit breaking, and per-phase turn limits.

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `poll_interval_seconds` | integer | 30 | 5-300 | How often the daemon checks for new work |
| `heartbeat_interval_seconds` | integer | 30 | 10-120 | How often the daemon writes a heartbeat timestamp |
| `circuit_breaker_threshold` | integer | 3 | 1-10 | Consecutive crashes before the circuit breaker trips |
| `log_retention_days` | integer | 30 | 1-365 | How long to keep daemon logs |
| `idle_backoff_base_seconds` | integer | 30 | 10-120 | Starting interval when no work is available |
| `idle_backoff_max_seconds` | integer | 900 | 60-3600 | Maximum backoff interval when idle (15 min default) |
| `max_turns_by_phase` | object | see below | per-phase | Maximum Claude turns allowed per phase per session |

**`max_turns_by_phase` defaults:**

| Phase | Default Turns |
|---|---|
| intake | 10 |
| prd / tdd / plan / spec | 50 |
| prd_review / tdd_review / plan_review / spec_review | 30 |
| code | 200 |
| code_review | 50 |
| integration | 100 |
| deploy | 30 |

**Common customization:** Increase `code` turns for large codebases, decrease `poll_interval_seconds` for faster pickup.

```json
{
  "daemon": {
    "poll_interval_seconds": 15,
    "max_turns_by_phase": {
      "code": 300
    }
  }
}
```

---

## Section 2: state_machine

Controls retry limits, timeouts, and context window thresholds for the pipeline state machine.

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `retry_limits_by_phase` | object | see below | per-phase, 1-10 | Max retries before escalation |
| `timeouts_by_phase` | object | see below | per-phase, "1m"-"480m" | Max wall-clock time per phase |
| `context_window_threshold_pct` | integer | 80 | 50-95 | Percentage of context window used before the phase is halted |

**`retry_limits_by_phase` defaults:**

| Phase | Default Retries |
|---|---|
| intake | 1 |
| prd / tdd / plan / spec | 2 |
| prd_review / tdd_review / plan_review / spec_review / code_review | 3 |
| code | 3 |
| integration / deploy | 2 |

**`timeouts_by_phase` defaults:**

| Phase | Default Timeout |
|---|---|
| intake | 5m |
| prd / plan | 30m |
| tdd / spec | 45m |
| prd_review / tdd_review / plan_review / spec_review | 20m |
| code | 120m |
| code_review / deploy | 30m |
| integration | 60m |

**Common customization:** Increase code timeout for complex tasks.

```json
{
  "state_machine": {
    "timeouts_by_phase": {
      "code": "180m",
      "integration": "90m"
    },
    "retry_limits_by_phase": {
      "code": 5
    }
  }
}
```

---

## Section 3: governance

Controls cost caps, concurrency limits, disk usage, and rate limit backoff.

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `daily_cost_cap_usd` | float | 100.00 | 1-10000 | Maximum daily spend (UTC) |
| `monthly_cost_cap_usd` | float | 2000.00 | 1-100000 | Maximum monthly spend (UTC) |
| `per_request_cost_cap_usd` | float | 50.00 | 1-10000 | Maximum spend per single request |
| `max_concurrent_requests` | integer | 3 | 1-10 | Max requests processing simultaneously |
| `disk_usage_limit_gb` | float | 10.0 | 1-100 | Disk usage limit for autonomous-dev data |
| `rate_limit_backoff_base_seconds` | integer | 30 | 5-300 | Initial backoff when rate limited |
| `rate_limit_backoff_max_seconds` | integer | 900 | 60-3600 | Maximum backoff when rate limited |

**Common customization:** Adjust cost caps based on your API plan and workload.

```json
{
  "governance": {
    "daily_cost_cap_usd": 200.00,
    "monthly_cost_cap_usd": 5000.00,
    "per_request_cost_cap_usd": 100.00,
    "max_concurrent_requests": 2
  }
}
```

---

## Section 4: repositories

Controls which repositories the daemon can operate on.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `allowlist` | string[] | `[]` | Absolute paths of repos the daemon may process |
| `overrides` | object | `{}` | Per-repo configuration overrides |

**Important:** The daemon will not touch any repository not in the allowlist. This is a safety constraint.

**Common customization:** Add repos and set per-repo overrides.

```json
{
  "repositories": {
    "allowlist": [
      "/Users/you/projects/my-app",
      "/Users/you/projects/another-app"
    ],
    "overrides": {
      "/Users/you/projects/my-app": {
        "trust": { "default_level": 2 }
      }
    }
  }
}
```

---

## Section 5: trust

Controls trust levels and automatic trust promotion.

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `system_default_level` | integer | 1 | 0-3 | Default trust level for new repos |
| `repositories` | object | `{}` | - | Per-repo trust level overrides |
| `promotion.enabled` | boolean | true | - | Allow automatic trust escalation |
| `promotion.min_consecutive_successes` | integer | 20 | 5-100 | Successful requests before promotion is offered |
| `promotion.require_human_approval` | boolean | true | **immutable** | Promotion always requires human approval |

**Trust level gate matrix:**

| Gate | L0 | L1 | L2 | L3 |
|---|---|---|---|---|
| PRD approval | human | human | system | system |
| Code review | human | human | human | system |
| Test review | human | system | system | system |
| Deploy approval | human | human | human | system |
| Security review | human | human | human | human |
| Cost approval | human | human | system | system |
| Quality gate | human | system | system | system |

**Important:** `require_human_approval` is immutable and enforced at the type system level. It cannot be set to `false`.

**Common customization:** Per-repo trust levels.

```json
{
  "trust": {
    "system_default_level": 1,
    "repositories": {
      "/Users/you/projects/production-api": { "default_level": 0 },
      "/Users/you/projects/hobby-project": { "default_level": 3 }
    },
    "promotion": {
      "enabled": true,
      "min_consecutive_successes": 10
    }
  }
}
```

---

## Section 6: escalation

Controls how the system routes stuck situations to humans.

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `routing.mode` | string | "default" | "default", "advanced" | Routing complexity |
| `routing.default_target` | string | "pm-lead" | - | Default escalation target |
| `routing.advanced` | object | see below | - | Category-based routing with primary/secondary targets and timeouts |
| `timeout_behavior.default` | string | "pause" | "pause", "skip", "abort" | What to do when escalation times out |
| `retry_limits.quality_gate_max_iterations` | integer | 3 | 1-10 | Max review iterations before escalating |
| `retry_limits.technical_max_approaches` | integer | 3 | 1-10 | Max technical retry approaches |
| `verbosity.default` | string | "standard" | "minimal", "standard", "detailed" | Escalation message verbosity |

**Advanced routing defaults (category -> primary -> secondary -> timeout):**

| Category | Primary | Secondary | Timeout (min) |
|---|---|---|---|
| product | pm-lead | tech-lead | 60 |
| technical | tech-lead | pm-lead | 120 |
| infrastructure | sys-operator | tech-lead | 30 |
| security | security-lead | pm-lead | 15 |
| cost | pm-lead | (none) | 60 |
| quality | tech-lead | pm-lead | 120 |

**Common customization:** Set up advanced routing for a team.

```json
{
  "escalation": {
    "routing": {
      "mode": "advanced",
      "advanced": {
        "security": {
          "primary": "security-lead",
          "secondary": "cto",
          "timeout_minutes": 10
        }
      }
    },
    "timeout_behavior": {
      "default": "pause"
    }
  }
}
```

---

## Section 7: notifications

Controls how and when the system delivers messages to you.

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `delivery.default_method` | string | "cli" | "cli", "discord", "slack", "file" | Default delivery channel |
| `delivery.overrides` | object | `{}` | - | Per-notification-type channel overrides |
| `delivery.channels` | array | file logger | - | Additional delivery channels |
| `delivery.discord.webhook_url` | string | null | - | Discord webhook URL |
| `delivery.discord.channel_id` | string | null | - | Discord channel ID |
| `delivery.slack.webhook_url` | string | null | - | Slack webhook URL |
| `delivery.slack.channel` | string | null | - | Slack channel name |
| `batching.enabled` | boolean | true | - | Group non-urgent notifications |
| `batching.interval_minutes` | integer | 60 | 5-1440 | Batching interval |
| `batching.exempt_types` | string[] | ["escalation", "error"] | - | Types that bypass batching |
| `dnd.enabled` | boolean | false | - | Enable do-not-disturb mode |
| `dnd.start` | string | "22:00" | HH:MM | DND start time |
| `dnd.end` | string | "07:00" | HH:MM | DND end time |
| `dnd.timezone` | string | "America/New_York" | IANA timezone | Timezone for DND |
| `dnd.breakthrough_urgency` | string[] | ["immediate"] | - | Urgency levels that bypass DND |
| `fatigue.enabled` | boolean | true | - | Enable notification fatigue detection |
| `fatigue.threshold_per_hour` | integer | 20 | 1-100 | Max notifications per hour before batching |
| `fatigue.digest_cooldown_minutes` | integer | 30 | 5-120 | Cooldown between digest deliveries |
| `cross_request.enabled` | boolean | true | - | Detect systemic failures across requests |
| `cross_request.failure_window_minutes` | integer | 60 | 5-1440 | Window for counting cross-request failures |
| `cross_request.failure_threshold` | integer | 3 | 1-20 | Failures in window that trigger a systemic alert |
| `summary_schedule` | string | "daily" | "daily", "weekly", "never" | Summary report frequency |
| `daily_digest_time` | string | "09:00" | HH:MM | When to deliver daily digest |

**Common customization:** Multi-channel with DND.

```json
{
  "notifications": {
    "delivery": {
      "default_method": "slack",
      "slack": {
        "webhook_url": "https://hooks.slack.com/services/YOUR_WEBHOOK",
        "channel": "#autonomous-dev"
      },
      "overrides": {
        "escalation": "discord",
        "error": "discord"
      }
    },
    "dnd": {
      "enabled": true,
      "start": "22:00",
      "end": "08:00",
      "timezone": "America/Chicago"
    },
    "batching": {
      "interval_minutes": 30
    }
  }
}
```

---

## Section 8: review_gates

Controls quality thresholds, reviewer panel composition, and iteration limits.

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `default_threshold` | integer | 85 | 50-100 | Fallback score threshold if not set per type |
| `thresholds_by_type` | object | see below | 50-100 per type | Per-document-type minimum passing score |
| `max_iterations` | integer | 3 | 1-10 | Max revision attempts before escalation |
| `panel_size` | object | see below | 1-5 per type | Number of reviewers per document type |
| `score_aggregation` | string | "mean" | "mean", "median", "min" | How individual scores are combined |
| `disagreement_threshold` | integer | 15 | 5-50 | Point spread that triggers human escalation |

**`thresholds_by_type` defaults:**

| Type | Threshold |
|---|---|
| PRD | 85 |
| TDD | 85 |
| Plan | 80 |
| Spec | 80 |
| Code | 85 |

**`panel_size` defaults:**

| Type | Reviewers |
|---|---|
| PRD | 2 |
| TDD | 2 |
| Plan | 1 |
| Spec | 1 |
| Code | 2 |

**Common customization:** Stricter code review, more reviewers.

```json
{
  "review_gates": {
    "thresholds_by_type": {
      "Code": 90,
      "PRD": 80
    },
    "panel_size": {
      "Code": 3,
      "Plan": 2
    },
    "max_iterations": 5,
    "score_aggregation": "median"
  }
}
```

---

## Section 9: decomposition

Controls how large requests are broken down into sub-tasks.

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `max_children_per_parent` | integer | 10 | 2-25 | Max child tasks per parent document |
| `max_pipeline_depth` | integer | 4 | 2-8 | Max nesting depth of decomposed pipelines |
| `max_total_nodes` | integer | 100 | 10-500 | Max total nodes in the decomposition tree |
| `explosion_alert_threshold` | integer | 75 | 10-500 | Node count that triggers a warning |

**Common customization:** Allow larger decompositions for complex projects.

```json
{
  "decomposition": {
    "max_children_per_parent": 15,
    "max_total_nodes": 200,
    "explosion_alert_threshold": 150
  }
}
```

---

## Section 10: versioning

Controls document versioning behavior.

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `quality_regression_margin` | integer | 5 | 1-20 | Allowed quality score drop (points) before flagging a regression |

**Common customization:** Tighter regression detection.

```json
{
  "versioning": {
    "quality_regression_margin": 3
  }
}
```

---

## Section 11: backward_cascade

Controls how changes to upstream documents cascade to downstream documents (e.g., PRD change triggers TDD update).

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `max_depth` | integer | 2 | 1-5 | How many levels deep a cascade propagates |
| `require_human_confirmation` | boolean | false | - | Whether cascades require human approval |

**Common customization:** Require approval for cascades in critical repos.

```json
{
  "backward_cascade": {
    "max_depth": 3,
    "require_human_confirmation": true
  }
}
```

---

## Section 12: parallel

Controls parallel task execution using git worktrees.

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `max_worktrees` | integer | 5 | 1-10 | Max git worktrees at one time |
| `max_tracks` | integer | 3 | 1-10 | Max parallel execution tracks |
| `disk_warning_threshold_gb` | float | 2.0 | 0.5-50 | Disk usage that triggers a warning |
| `disk_hard_limit_gb` | float | 5.0 | 1-100 | Disk usage that stops new worktree creation |
| `stall_timeout_minutes` | integer | 15 | 5-120 | Minutes before a stalled track is flagged |
| `agent_turn_budget.small` | integer | 30 | 10-100 | Turn budget for small tasks |
| `agent_turn_budget.medium` | integer | 60 | 20-200 | Turn budget for medium tasks |
| `agent_turn_budget.large` | integer | 120 | 30-500 | Turn budget for large tasks |
| `conflict_ai_confidence_threshold` | float | 0.85 | 0.5-1.0 | Confidence needed for AI-assisted conflict resolution |
| `worktree_cleanup_delay_seconds` | integer | 300 | 0-3600 | Delay before cleaning up completed worktrees |

**Common customization:** Conservative parallelism for repos with many shared files.

```json
{
  "parallel": {
    "max_tracks": 2,
    "max_worktrees": 3,
    "conflict_ai_confidence_threshold": 0.90,
    "stall_timeout_minutes": 30
  }
}
```

---

## Section 13: pipeline_control

Controls overall pipeline behavior.

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `default_priority` | string | "normal" | "low", "normal", "high", "critical" | Default priority for new requests |
| `max_concurrent_pipelines` | integer | 5 | 1-20 | Max pipelines running simultaneously |

**Common customization:** Limit concurrent pipelines to conserve resources.

```json
{
  "pipeline_control": {
    "default_priority": "high",
    "max_concurrent_pipelines": 3
  }
}
```

---

## Section 14: agents

Controls the Agent Factory -- anomaly detection, modification rate limits, and canary periods.

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `anomaly_detection.approval_rate_threshold` | float | 0.70 | 0.3-1.0 | Approval rate below this triggers an alert |
| `anomaly_detection.escalation_rate_threshold` | float | 0.30 | 0.05-0.8 | Escalation rate above this triggers an alert |
| `anomaly_detection.observation_threshold` | integer | 10 | 5-50 | Minimum observations before anomaly detection activates |
| `modification_rate_limits.max_new_agents_per_week` | integer | 1 | 0-5 | Max new agents created per week |
| `modification_rate_limits.max_modifications_per_agent_per_week` | integer | 1 | 0-5 | Max modifications per agent per week |
| `canary_period_days` | integer | 7 | 1-30 | Days a new agent version runs in canary before full promotion |

**Common customization:** More aggressive improvement cycles.

```json
{
  "agents": {
    "modification_rate_limits": {
      "max_modifications_per_agent_per_week": 2
    },
    "canary_period_days": 3,
    "anomaly_detection": {
      "approval_rate_threshold": 0.75,
      "observation_threshold": 5
    }
  }
}
```

---

## Section 15: production_intelligence

Controls the production monitoring and auto-fix system.

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `enabled` | boolean | true | - | Master toggle for production intelligence |
| `schedule` | string | "0 */4 * * *" | cron expression | How often observations run |
| `error_detection.default_error_rate_percent` | float | 5.0 | 0.1-50 | Error rate that triggers an alert |
| `error_detection.default_sustained_duration_min` | integer | 10 | 1-60 | Minutes the error rate must be sustained |
| `anomaly_detection.method` | string | "z_score" | "z_score" | Anomaly detection algorithm |
| `anomaly_detection.sensitivity` | float | 2.5 | 1.0-5.0 | Z-score standard deviations for anomaly |
| `anomaly_detection.baseline_window_days` | integer | 14 | 7-90 | Days of baseline data for comparison |
| `trend_analysis.enabled` | boolean | true | - | Enable trend detection |
| `trend_analysis.windows` | integer[] | [7, 14, 30] | 1-365 per value | Analysis windows in days |
| `trend_analysis.min_slope_threshold` | float | 0.05 | 0.01-1.0 | Minimum slope to flag a trend |
| `governance.cooldown_days` | integer | 7 | 1-30 | Days to wait after a fix before generating another for the same issue |
| `governance.oscillation_threshold` | integer | 3 | 2-10 | Fix-revert cycles that trigger oscillation detection |
| `governance.oscillation_window_days` | integer | 30 | 7-90 | Window for counting oscillation cycles |
| `governance.effectiveness_comparison_days` | integer | 7 | 1-30 | Days to wait before measuring fix effectiveness |
| `governance.effectiveness_improvement_threshold` | float | 0.10 | 0.01-0.5 | Minimum improvement to consider a fix effective |

**Common customization:** More sensitive detection, faster cycles.

```json
{
  "production_intelligence": {
    "schedule": "0 */2 * * *",
    "error_detection": {
      "default_error_rate_percent": 2.0,
      "default_sustained_duration_min": 5
    },
    "anomaly_detection": {
      "sensitivity": 2.0
    },
    "governance": {
      "cooldown_days": 3
    }
  }
}
```

---

## Section 16: intake

Controls the request intake system -- queue depth, deduplication, clarifying questions, and rate limits.

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `max_queue_depth` | integer | 50 | 10-500 | Max queued requests before rejecting new ones |
| `starvation_threshold_hours` | integer | 48 | 1-168 | Hours a low-priority request can wait before being promoted |
| `duplicate_similarity_threshold` | float | 0.85 | 0.5-1.0 | Similarity score that flags a duplicate |
| `max_clarifying_rounds` | integer | 5 | 1-20 | Max rounds of clarifying questions |
| `response_timeout_minutes` | integer | 240 | 10-1440 | Minutes to wait for a user response to a clarifying question |
| `response_timeout_action` | string | "pause" | "pause", "proceed", "cancel" | What to do when clarifying response times out |
| `rate_limits.submissions_per_hour` | integer | 10 | 1-100 | Max new submissions per hour |
| `rate_limits.queries_per_minute` | integer | 60 | 1-300 | Max status queries per minute |

**Common customization:** Higher throughput intake.

```json
{
  "intake": {
    "max_queue_depth": 100,
    "max_clarifying_rounds": 3,
    "response_timeout_minutes": 120,
    "rate_limits": {
      "submissions_per_hour": 25
    }
  }
}
```

---

## Section 17: cleanup

Controls automatic cleanup behavior.

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `auto_cleanup_interval_iterations` | integer | 100 | 10-1000 | Daemon iterations between automatic cleanup runs |
| `delete_remote_branches` | boolean | true | - | Whether cleanup deletes remote branches for archived requests |

**Common customization:** More frequent cleanup, preserve remote branches.

```json
{
  "cleanup": {
    "auto_cleanup_interval_iterations": 50,
    "delete_remote_branches": false
  }
}
```

---

## Section 18: retention

Controls how long different data types are retained before archival or deletion.

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `completed_request_days` | integer | 30 | 1-365 | Days to keep completed request data |
| `event_log_days` | integer | 90 | 7-365 | Days to keep audit event logs |
| `cost_ledger_months` | integer | 12 | 1-60 | Months to keep cost ledger archives |
| `daemon_log_days` | integer | 30 | 1-365 | Days to keep daemon logs |
| `observation_report_days` | integer | 90 | 7-365 | Days to keep observation reports |
| `observation_archive_days` | integer | 365 | 30-1825 | Days to keep archived observations |
| `archive_days` | integer | 365 | 30-1825 | Days to keep archived request tarballs |
| `config_validation_log_days` | integer | 7 | 1-90 | Days to keep config validation logs |

**Common customization:** Longer retention for compliance, shorter for disk savings.

```json
{
  "retention": {
    "completed_request_days": 90,
    "event_log_days": 365,
    "cost_ledger_months": 24,
    "observation_report_days": 180
  }
}
```

---

## Section 19: audit

Controls audit trail integrity features.

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `integrity.hash_chain_enabled` | boolean | false | - | Enable hash chain verification for audit events |

When enabled, each audit event includes a hash of the previous event, creating a tamper-evident chain. This adds overhead but provides cryptographic verification that no events have been modified or deleted.

**Common customization:** Enable for regulated environments.

```json
{
  "audit": {
    "integrity": {
      "hash_chain_enabled": true
    }
  }
}
```

---

## Section 20: emergency

Controls emergency stop and restart behavior.

| Parameter | Type | Default | Range | Description |
|---|---|---|---|---|
| `kill_default_mode` | string | "graceful" | "graceful", "immediate" | How the kill switch stops processing |
| `restart_requires_human` | boolean | true | - | Whether the daemon requires human intervention to restart after an emergency stop |

- **graceful:** Completes the current Claude session, then halts. In-flight requests are paused, not cancelled.
- **immediate:** Interrupts the current session immediately. May lose in-progress work for the current turn.

**Common customization:** Immediate stop for safety-critical environments.

```json
{
  "emergency": {
    "kill_default_mode": "immediate",
    "restart_requires_human": true
  }
}
```

---

## Full Example Configuration

A complete example combining common customizations:

```json
{
  "governance": {
    "daily_cost_cap_usd": 200.00,
    "monthly_cost_cap_usd": 5000.00,
    "per_request_cost_cap_usd": 100.00,
    "max_concurrent_requests": 2
  },
  "repositories": {
    "allowlist": [
      "/Users/you/projects/my-app",
      "/Users/you/projects/another-app"
    ]
  },
  "trust": {
    "system_default_level": 1,
    "repositories": {
      "/Users/you/projects/my-app": { "default_level": 2 },
      "/Users/you/projects/another-app": { "default_level": 0 }
    }
  },
  "review_gates": {
    "thresholds_by_type": {
      "Code": 90
    },
    "panel_size": {
      "Code": 3
    }
  },
  "notifications": {
    "delivery": {
      "default_method": "slack",
      "slack": {
        "webhook_url": "https://hooks.slack.com/services/YOUR_WEBHOOK",
        "channel": "#autonomous-dev"
      }
    },
    "dnd": {
      "enabled": true,
      "start": "22:00",
      "end": "08:00",
      "timezone": "America/New_York"
    }
  },
  "production_intelligence": {
    "schedule": "0 */2 * * *",
    "error_detection": {
      "default_error_rate_percent": 2.0
    }
  },
  "retention": {
    "completed_request_days": 60,
    "event_log_days": 180
  }
}
```

After editing, always validate:

```bash
autonomous-dev config validate
```
