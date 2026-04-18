# TDD-010: Configuration & Resource Governance

| Field          | Value                                                                                                                                                   |
|----------------|---------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Title**      | Configuration & Resource Governance                                                                                                                     |
| **TDD ID**     | TDD-010                                                                                                                                                 |
| **Version**    | 0.1.0                                                                                                                                                   |
| **Date**       | 2026-04-08                                                                                                                                              |
| **Status**     | Draft                                                                                                                                                   |
| **Author**     | Patrick Watson                                                                                                                                          |
| **Parent PRDs**| PRD-001 (System Core & Daemon Engine), PRD-007 (Escalation & Trust Framework)                                                                           |
| **References** | PRD-002 (Document Pipeline), PRD-003 (Agent Factory), PRD-004 (Parallel Execution), PRD-005 (Production Intelligence), PRD-006 (Intake & Communication) |

---

## 1. Overview

This TDD defines the technical design for the **Configuration & Resource Governance** layer of the `autonomous-dev` plugin. This layer is the cross-cutting foundation that every other subsystem depends on. It owns three responsibilities:

1. **Configuration**: Load, merge, validate, and expose a layered configuration system that consolidates parameters from all seven PRDs into a single file.
2. **Cost Governance**: Track, aggregate, and enforce spending limits across requests, days, and months via an append-only cost ledger.
3. **Resource Governance**: Monitor disk usage, worktree counts, active sessions, API rate limits, and enforce cleanup/retention policies.

Every supervisor-loop iteration begins by reading the effective configuration and checking resource budgets. If any budget is exceeded or any configuration is invalid, the iteration halts before spawning a Claude Code session. This "fail-closed" design ensures the system never operates with incorrect assumptions about its own constraints.

### 1.1 Design Principles

- **Single source of truth**: One configuration schema governs the entire system. No subsystem invents its own configuration file format.
- **Fail closed**: Missing, corrupted, or invalid configuration causes the daemon to refuse new work rather than proceed with defaults that might be wrong.
- **Append-only accounting**: The cost ledger is never edited in place. Every cost entry is a new line. Aggregates are computed on read.
- **Defense in depth**: Cost control has three independent circuit breakers (per-request, daily, monthly). Any one of them can stop runaway spending.
- **Hot-reloadable where safe**: Configuration changes that affect future iterations (notification channels, trust levels, cost caps) are picked up without daemon restart. Changes that affect in-flight sessions (turn budgets, phase timeouts) take effect at the next session boundary.

---

## 2. Architecture

### 2.1 Component Diagram

```
                   CLI Flags (highest precedence)
                          |
                          v
              +-----------+-----------+
              |   ConfigLoader        |
              |  +-----------------+  |
              |  | 1. Read global  |  |
              |  |    ~/.claude/   |  |
              |  |    autonomous-  |  |
              |  |    dev.json     |  |
              |  +-----------------+  |
              |  | 2. Read project |  |
              |  |    .claude/     |  |
              |  |    autonomous-  |  |
              |  |    dev.json     |  |
              |  +-----------------+  |
              |  | 3. Deep-merge   |  |
              |  |    with CLI     |  |
              |  |    overrides    |  |
              |  +-----------------+  |
              |  | 4. Apply        |  |
              |  |    defaults     |  |
              |  +-----------------+  |
              |  | 5. Validate     |  |
              |  |    schema       |  |
              |  +-----------------+  |
              +-----------+-----------+
                          |
                          v
              +-----------+-----------+
              |   EffectiveConfig     |
              |   (immutable for      |
              |    this iteration)    |
              +-----------+-----------+
                    |           |
          +---------+           +---------+
          v                               v
+---------+---------+           +---------+---------+
| CostGovernor      |           | ResourceMonitor   |
| +---------------+ |           | +---------------+ |
| | Read ledger   | |           | | Disk usage    | |
| | Check caps    | |           | | Worktree cnt  | |
| | Record costs  | |           | | Session cnt   | |
| +---------------+ |           | | Rate limits   | |
+---------+---------+           | +---------------+ |
          |                     +---------+---------+
          v                               |
+---------+---------+                     v
| cost-ledger.jsonl |           +---------+---------+
| (append-only)     |           | CleanupEngine     |
+-------------------+           | +---------------+ |
                                | | State files   | |
                                | | Branches      | |
                                | | Worktrees     | |
                                | | Observations  | |
                                | | Event logs    | |
                                | +---------------+ |
                                +-------------------+
```

### 2.2 Call Sequence Per Iteration

```
SupervisorLoop
  |
  +-- ConfigLoader.load()
  |     |-- read_global_config()
  |     |-- read_project_config()      # for highest-priority request's repo
  |     |-- merge_cli_overrides()
  |     |-- apply_defaults()
  |     |-- validate()                 # fail-closed on error
  |     +-- return EffectiveConfig
  |
  +-- CostGovernor.check_budgets(EffectiveConfig)
  |     |-- read_ledger_aggregates()
  |     |-- check_monthly_cap()        # fail-closed on exceed
  |     |-- check_daily_cap()          # fail-closed on exceed
  |     |-- check_per_request_cap()    # skip request on exceed
  |     +-- return BudgetStatus
  |
  +-- ResourceMonitor.check_resources(EffectiveConfig)
  |     |-- check_disk_usage()         # block new work on exceed
  |     |-- check_worktree_count()     # queue on exceed
  |     |-- check_active_sessions()    # queue on exceed
  |     |-- check_rate_limit_state()   # backoff on active limit
  |     +-- return ResourceStatus
  |
  +-- [spawn Claude Code session if all checks pass]
  |
  +-- CostGovernor.record_cost(request_id, session_cost)
  |     |-- append_to_ledger()
  |     +-- update_request_state()
  |
  +-- CleanupEngine.run_if_due(EffectiveConfig)
        |-- cleanup_completed_requests()
        |-- cleanup_stale_branches()
        |-- rotate_event_logs()
        +-- prune_observation_reports()
```

### 2.3 Plugin Hook Integration

The configuration and governance layer integrates with Claude Code plugin hooks at the following points:

| Hook              | Action                                                                                      |
|-------------------|---------------------------------------------------------------------------------------------|
| `SessionStart`    | ConfigLoader validates config. CostGovernor checks all budgets. ResourceMonitor checks all resources. If any check fails, the hook returns a non-zero exit code to prevent session launch. |
| `Stop`            | CostGovernor records the session's cost from Claude Code's output. ResourceMonitor updates worktree and session counts. |
| `PreCompact`      | ResourceMonitor logs a context-window-exhaustion event. The state machine checkpoints current progress before the compact operation proceeds. |
| `SubagentStop`    | CostGovernor records the subagent's individual cost contribution. Turn count is incremented on the parent request. |

---

## 3. Detailed Design

### 3.1 Layered Configuration System

#### 3.1.1 Layer Precedence

Configuration is resolved with the following precedence (highest wins):

1. **CLI flags** --- passed as `--config.key=value` arguments to `autonomous-dev` commands.
2. **Project-level** --- `.claude/autonomous-dev.json` in the repository root.
3. **Global** --- `~/.claude/autonomous-dev.json` in the user's home directory.
4. **Built-in defaults** --- hardcoded in the `config_defaults.json` file shipped with the plugin.

#### 3.1.2 Deep-Merge Semantics

The merge algorithm is a recursive deep merge with the following rules:

| Source Type | Target Type | Result                                                          |
|-------------|-------------|-----------------------------------------------------------------|
| Object      | Object      | Recurse: merge each key. Source keys override target keys.       |
| Array       | Array       | **Replace** (not concatenate). The higher-precedence array wins entirely. This prevents confusing partial-array merges. |
| Scalar      | Scalar      | Higher-precedence scalar wins.                                   |
| Any         | Missing     | Higher-precedence value is used.                                 |
| Missing     | Any         | Lower-precedence value is retained.                              |

Rationale for array-replace: Concatenating arrays (e.g., the `repositories.allowlist`) would make it impossible for a project-level config to narrow the allowlist defined globally. Replace semantics give each layer full control.

#### 3.1.3 Merge Implementation

```bash
# merge_config.sh
# Uses jq's `*` operator for recursive object merge.
# Arrays at any depth use the higher-precedence version.

merge_configs() {
  local base="$1"    # lower precedence (e.g., global)
  local overlay="$2" # higher precedence (e.g., project)

  jq -n \
    --argjson base "$base" \
    --argjson overlay "$overlay" \
    '$base * $overlay'
}
```

The `jq` `*` operator performs recursive object merge where overlay keys overwrite base keys. For arrays, `*` uses the overlay's array, which matches our replace semantics.

#### 3.1.4 CLI Override Parsing

CLI overrides use dot-notation to target specific keys:

```
autonomous-dev submit --config.governance.daily_cost_cap_usd=50
autonomous-dev daemon start --config.daemon.poll_interval_seconds=10
```

The parser splits on `.` to build a nested JSON object, then merges it as the highest-precedence layer:

```bash
parse_cli_override() {
  local key_path="$1"  # e.g., "governance.daily_cost_cap_usd"
  local value="$2"     # e.g., "50"

  # Build nested JSON from dot path
  echo "$value" | jq -R --arg path "$key_path" '
    ($path | split(".")) as $keys |
    reduce range($keys | length - 1; -1; -1) as $i (
      (. | try tonumber // try (if . == "true" then true elif . == "false" then false else . end));
      {($keys[$i]): .}
    )
  '
}
```

#### 3.1.5 Config File Locations

| Layer     | Path                                        | Created By                |
|-----------|---------------------------------------------|---------------------------|
| Global    | `~/.claude/autonomous-dev.json`             | `autonomous-dev config init --global` |
| Project   | `{repo}/.claude/autonomous-dev.json`        | `autonomous-dev config init --project` |
| Defaults  | `{plugin-root}/config_defaults.json`        | Plugin installation       |

#### 3.1.6 Hot Reload

The configuration is re-read at the start of every supervisor-loop iteration. There is no file-watcher or signal-based reload. This is intentional: the loop already runs frequently (every 30 seconds when idle, immediately when work is available), and re-reading a small JSON file is negligible overhead.

Fields that are safe to hot-reload (take effect next iteration):
- All `governance.*` fields (cost caps, concurrency limits)
- All `notifications.*` fields
- All `trust.*` fields
- `repositories.allowlist`
- `cleanup.*` and `retention.*`

Fields that take effect at the next session boundary:
- `daemon.max_turns_by_phase.*`
- `state_machine.timeouts_by_phase.*`
- `parallel.*` (worktree limits, track limits)

Fields that require daemon restart:
- `daemon.poll_interval_seconds` (affects the sleep loop timing)
- `daemon.heartbeat_interval_seconds`

### 3.2 Configuration Validation

#### 3.2.1 Validation Pipeline

Validation runs every time `ConfigLoader.load()` is called. The pipeline is:

1. **JSON parse**: Verify the file is syntactically valid JSON. On failure: log the parse error with line/column, refuse to start.
2. **Schema validation**: Verify every field matches its expected type and constraints. Uses a declarative schema (Section 4.1).
3. **Cross-field validation**: Check semantic constraints that span multiple fields (e.g., `monthly_cost_cap_usd >= daily_cost_cap_usd`).
4. **Path validation**: Verify that all file paths in the config (allowlist repos, log paths) exist and are accessible.
5. **Security validation**: Warn if the config file is world-readable and contains sensitive values (webhook URLs).

#### 3.2.2 Validation Rules

| Rule ID | Fields                                    | Constraint                                                         | Severity |
|---------|-------------------------------------------|--------------------------------------------------------------------|----------|
| V-001   | All numeric fields                        | Must be a number, not a string.                                     | Error    |
| V-002   | All `*_seconds`, `*_minutes` fields       | Must be > 0.                                                        | Error    |
| V-003   | `governance.daily_cost_cap_usd`           | Must be <= `governance.monthly_cost_cap_usd`.                       | Error    |
| V-004   | `governance.per_request_cost_cap_usd`     | Must be <= `governance.daily_cost_cap_usd`.                         | Warning  |
| V-005   | `repositories.allowlist`                  | Each path must be an absolute path.                                  | Error    |
| V-006   | `repositories.allowlist`                  | Each path must exist and contain a `.git` directory.                 | Warning  |
| V-007   | `trust.system_default_level`              | Must be 0, 1, 2, or 3.                                              | Error    |
| V-008   | `daemon.circuit_breaker_threshold`        | Must be >= 1.                                                        | Error    |
| V-009   | `notifications.dnd.start`, `dnd.end`      | Must be valid HH:MM format.                                         | Error    |
| V-010   | `notifications.dnd.timezone`              | Must be a valid IANA timezone string.                                | Error    |
| V-011   | `daemon.max_turns_by_phase.*`             | Each value must be >= 1.                                             | Error    |
| V-012   | `state_machine.retry_limits_by_phase.*`   | Each value must be >= 0.                                             | Error    |
| V-013   | `escalation.routing.mode`                 | Must be `"default"` or `"advanced"`.                                 | Error    |
| V-014   | `parallel.max_worktrees`                  | Must be >= 1.                                                        | Error    |
| V-015   | `parallel.conflict_ai_confidence_threshold` | Must be between 0.0 and 1.0 inclusive.                             | Error    |
| V-016   | `notifications.delivery.default_method`   | Must be one of `"cli"`, `"discord"`, `"slack"`, `"file_drop"`.       | Error    |
| V-017   | Config file permissions                   | Warn if file mode allows group/world read and `notifications.delivery.overrides` contains webhook URLs. | Warning |
| V-018   | `review_gates.thresholds_by_type.*`       | Each value must be between 0 and 100 inclusive.                      | Error    |
| V-019   | `governance.rate_limit_backoff_max_seconds` | Must be >= `governance.rate_limit_backoff_base_seconds`.           | Error    |
| V-020   | `parallel.disk_hard_limit_gb`             | Must be >= `parallel.disk_warning_threshold_gb`.                     | Error    |

#### 3.2.3 Validation Severity

- **Error**: The daemon refuses to start or process work. The operator must fix the configuration.
- **Warning**: The daemon starts but logs a warning. The operator should address the issue.

#### 3.2.4 Validation Output

Validation errors are written to both stderr and `~/.autonomous-dev/logs/config-validation.log`:

```json
{
  "timestamp": "2026-04-08T09:00:00Z",
  "level": "error",
  "rule": "V-003",
  "field": "governance.daily_cost_cap_usd",
  "value": 150,
  "constraint": "Must be <= governance.monthly_cost_cap_usd (100)",
  "source": "~/.claude/autonomous-dev.json",
  "message": "Daily cost cap ($150) exceeds monthly cost cap ($100)."
}
```

### 3.3 Cost Tracking Engine

#### 3.3.1 Cost Extraction

After each Claude Code session exits, the supervisor loop parses the session's stdout/stderr for cost information. Claude Code prints session cost in its summary output. The extractor uses a regex pattern to capture the dollar amount:

```bash
extract_session_cost() {
  local session_output="$1"
  # Claude Code outputs: "Total cost: $X.XX"
  # Also handle: "Session cost: $X.XX" and "Cost: $X.XX"
  echo "$session_output" | grep -oP '(?:Total |Session )?[Cc]ost:\s*\$\K[0-9]+\.[0-9]+' | tail -1
}
```

If no cost is found in the output (e.g., the session crashed before printing), the system records `0.00` and logs a warning event. This is a known limitation; cost will be under-reported for crashed sessions.

#### 3.3.2 Per-Request Cost Tracking

Each request's `state.json` includes `cost_accrued_usd` (cumulative) and each entry in `phase_history` includes `cost_usd` (per-phase). After recording a session's cost:

1. The phase's `cost_usd` field is incremented.
2. The request's `cost_accrued_usd` field is recalculated as the sum of all phase costs.
3. Both writes happen as part of the atomic state-file update (write to `.tmp`, then `mv`).

#### 3.3.3 Cost Ledger

The global cost ledger lives at `~/.autonomous-dev/cost-ledger.jsonl`. It is an append-only JSONL file (one JSON object per line). Every cost event produces exactly one ledger entry.

**Ledger entry schema:**

```json
{
  "timestamp": "2026-04-08T10:05:30Z",
  "request_id": "REQ-20260408-a3f1",
  "repository": "/Users/pwatson/codebase/dashboard-app",
  "phase": "prd",
  "session_id": "sess_def456",
  "cost_usd": 1.85,
  "turns_used": 28,
  "cumulative_request_cost_usd": 1.97,
  "daily_total_usd": 12.43,
  "monthly_total_usd": 187.22
}
```

The `daily_total_usd` and `monthly_total_usd` fields are **computed at write time** by scanning the ledger for same-day/same-month entries. This denormalization makes budget checks a single-line read (check the last entry) rather than a full scan.

#### 3.3.4 Ledger Aggregation

For budget enforcement, the system needs current-day and current-month totals. Two strategies are available:

**Strategy A: Tail-read (default, used for budget checks)**
Read the last line of the ledger. Its `daily_total_usd` and `monthly_total_usd` are authoritative for the current day/month, as long as the date in the last entry matches today's date. If the date does not match (new day/month), the running total resets to 0.

**Strategy B: Full scan (used for reporting and `autonomous-dev cost` queries)**
Stream the entire ledger through `jq` to compute arbitrary aggregates: cost per request, cost per repository, cost per day, cost per month, cost per phase.

```bash
# Example: get today's total
todays_cost() {
  local today
  today=$(date -u +"%Y-%m-%d")
  local last_line
  last_line=$(tail -1 ~/.autonomous-dev/cost-ledger.jsonl)
  local last_date
  last_date=$(echo "$last_line" | jq -r '.timestamp[:10]')
  if [[ "$last_date" == "$today" ]]; then
    echo "$last_line" | jq -r '.daily_total_usd'
  else
    echo "0.00"
  fi
}
```

#### 3.3.5 Ledger Rotation

The cost ledger is never modified, but it can grow large. At the start of each month, the `CleanupEngine` copies the previous month's entries to `~/.autonomous-dev/cost-ledger-YYYY-MM.jsonl` and starts a new active ledger. Archived monthly ledgers are retained for 12 months by default (configurable via `retention.cost_ledger_months`).

#### 3.3.6 Cost Reporting CLI

```
autonomous-dev cost                  # today's spend and current month's spend
autonomous-dev cost --daily          # daily breakdown for current month
autonomous-dev cost --monthly        # monthly breakdown for current year
autonomous-dev cost --request REQ-X  # cost breakdown for a specific request
autonomous-dev cost --repo /path     # cost breakdown for a specific repository
```

### 3.4 Budget Enforcement

#### 3.4.1 Enforcement Points

Budget checks happen at two points in each iteration:

1. **Pre-session check** (in `CostGovernor.check_budgets`): Before spawning a Claude Code session, verify that no cap is already exceeded. If any cap is exceeded, the iteration does not spawn a session.
2. **Post-session check** (in `CostGovernor.record_cost`): After recording the session's cost, check whether the new total exceeds any cap. If a cap is now exceeded, transition affected requests to `paused` and emit a cost escalation.

#### 3.4.2 Cap Hierarchy

| Cap                      | Config Key                                | Default  | Scope         | Action on Exceed                                                    |
|--------------------------|-------------------------------------------|----------|---------------|---------------------------------------------------------------------|
| Per-request              | `governance.per_request_cost_cap_usd`     | $50      | One request   | Pause the request. Emit `cost` escalation for that request.          |
| Daily                    | `governance.daily_cost_cap_usd`           | $100     | All requests  | Pause ALL requests. Emit `cost` escalation. Resume next calendar day (UTC) or when cap is raised. |
| Monthly                  | `governance.monthly_cost_cap_usd`         | $2,000   | All requests  | Pause ALL requests. Emit `cost` escalation. Resume next calendar month (UTC) or when cap is raised. |

#### 3.4.3 Cost Escalation Payload

When a cost cap is exceeded, the system emits an escalation with type `cost`:

```json
{
  "escalation_type": "cost",
  "urgency": "immediate",
  "cap_type": "daily",
  "cap_value_usd": 100.00,
  "current_spend_usd": 102.47,
  "overage_usd": 2.47,
  "affected_requests": ["REQ-20260408-a3f1", "REQ-20260408-b2c4"],
  "recommendation": "Review active requests. Either raise the daily cap or cancel low-priority requests."
}
```

#### 3.4.4 Cap Override for Priority Requests

By default, no request is exempt from cost caps. This is a deliberate safety choice. If a high-priority request is blocked by a cost cap, the operator must either raise the cap or cancel competing requests. This prevents "priority creep" where every request claims exemption.

This is flagged as an open question in PRD-001 OQ-9. The current design takes the conservative position.

### 3.5 Repository Allowlist

#### 3.5.1 Purpose

The allowlist is a security boundary. The system will only create branches, worktrees, commits, and PRs in repositories that are explicitly listed. This prevents accidental or malicious targeting of arbitrary codebases.

#### 3.5.2 Validation

At request intake (`autonomous-dev submit`), the target repository path is checked against `repositories.allowlist`. Validation rules:

1. The path must be an exact match (no glob patterns, no prefix matching).
2. Symlinks are resolved with `realpath` before comparison.
3. The resolved path must exist on disk.
4. The resolved path must contain a `.git` directory (i.e., it must be a git repository).

```bash
validate_repository() {
  local repo_path="$1"
  local resolved
  resolved=$(realpath "$repo_path" 2>/dev/null) || {
    echo "ERROR: Path does not exist: $repo_path"
    return 1
  }

  if [[ ! -d "$resolved/.git" ]]; then
    echo "ERROR: Not a git repository: $resolved"
    return 1
  fi

  local allowed=false
  while IFS= read -r allowed_path; do
    local resolved_allowed
    resolved_allowed=$(realpath "$allowed_path" 2>/dev/null) || continue
    if [[ "$resolved" == "$resolved_allowed" ]]; then
      allowed=true
      break
    fi
  done < <(jq -r '.repositories.allowlist[]' "$EFFECTIVE_CONFIG")

  if [[ "$allowed" != "true" ]]; then
    echo "ERROR: Repository not on allowlist: $resolved"
    return 1
  fi

  return 0
}
```

#### 3.5.3 Per-Repository Configuration

The allowlist entry may optionally include per-repository overrides that are merged into the project-level config:

```json
{
  "repositories": {
    "allowlist": [
      "/Users/pwatson/codebase/dashboard-app",
      "/Users/pwatson/codebase/api-service"
    ],
    "overrides": {
      "/Users/pwatson/codebase/api-service": {
        "trust": { "default_level": 2 },
        "governance": { "per_request_cost_cap_usd": 75 }
      }
    }
  }
}
```

Repository overrides are merged between the project-level config and CLI flags in the precedence chain: CLI > repo override > project > global > defaults.

### 3.6 Resource Monitoring

#### 3.6.1 Disk Usage Monitoring

The system tracks disk usage of worktree directories. Two thresholds are enforced:

| Threshold         | Config Key                           | Default | Action                                   |
|-------------------|--------------------------------------|---------|------------------------------------------|
| Warning           | `parallel.disk_warning_threshold_gb` | 2 GB    | Log warning event. Continue processing.   |
| Hard limit        | `parallel.disk_hard_limit_gb`        | 5 GB    | Block new worktree creation. Emit alert.  |
| Legacy (PRD-001)  | `governance.disk_usage_limit_gb`     | 10 GB   | Block all new requests. Emit alert.       |

The `governance.disk_usage_limit_gb` is a system-wide hard limit on the `~/.autonomous-dev/` directory total size. The `parallel.disk_*` thresholds are specific to worktree directories.

Disk usage is measured using `du -sb` (Linux) or `du -sk` (macOS, converted) on the relevant directories. The measurement runs once per iteration; it is not a continuous monitor.

```bash
check_disk_usage() {
  local path="$1"
  local limit_bytes="$2"

  local usage_bytes
  if [[ "$(uname)" == "Darwin" ]]; then
    usage_bytes=$(du -sk "$path" 2>/dev/null | awk '{print $1 * 1024}')
  else
    usage_bytes=$(du -sb "$path" 2>/dev/null | awk '{print $1}')
  fi

  if (( usage_bytes > limit_bytes )); then
    return 1  # over limit
  fi
  return 0
}
```

#### 3.6.2 Worktree Count Monitoring

The system counts active git worktrees using `git worktree list --porcelain` in each allowlisted repository. The count is compared against `parallel.max_worktrees`.

#### 3.6.3 Active Session Count

The system counts active Claude Code sessions by counting request state files where `status` is not a terminal state (`completed`, `cancelled`, `failed`) and the request has a `current_session_pid` that is still alive (verified via `kill -0`).

#### 3.6.4 Rate Limit Awareness

When the Claude Code CLI returns an error indicating API rate limiting (HTTP 429 or rate-limit error text in output), the system enters a rate-limit backoff state:

**State file:** `~/.autonomous-dev/rate-limit-state.json`

```json
{
  "active": true,
  "triggered_at": "2026-04-08T14:00:00Z",
  "current_backoff_seconds": 120,
  "retry_at": "2026-04-08T14:02:00Z",
  "consecutive_rate_limits": 3
}
```

**Backoff sequence:** `base`, `base * 2`, `base * 4`, `base * 8`, `base * 16`, then pause and escalate.

Using defaults (base = 30s, max = 900s): 30s, 60s, 120s, 240s, 480s, then pause.

The backoff state is global: when a rate limit is detected, ALL requests pause (not just the one that hit the limit). This prevents other requests from hammering the API while one is already being limited.

```bash
handle_rate_limit() {
  local state_file="$HOME/.autonomous-dev/rate-limit-state.json"
  local base_seconds
  base_seconds=$(jq -r '.governance.rate_limit_backoff_base_seconds' "$EFFECTIVE_CONFIG")
  local max_seconds
  max_seconds=$(jq -r '.governance.rate_limit_backoff_max_seconds' "$EFFECTIVE_CONFIG")

  local consecutive=0
  if [[ -f "$state_file" ]]; then
    consecutive=$(jq -r '.consecutive_rate_limits' "$state_file")
  fi
  consecutive=$((consecutive + 1))

  local backoff=$((base_seconds * (2 ** (consecutive - 1))))
  if (( backoff > max_seconds )); then
    # Exceeded max backoff; pause and escalate
    emit_escalation "cost" "immediate" \
      "API rate limit persists after $consecutive consecutive retries. System pausing all work."
    set_kill_switch "rate_limit_exceeded"
    return 1
  fi

  local retry_at
  retry_at=$(date -u -d "+${backoff} seconds" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
    || date -u -v "+${backoff}S" +"%Y-%m-%dT%H:%M:%SZ")

  jq -n \
    --argjson active true \
    --arg triggered_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    --argjson backoff "$backoff" \
    --arg retry_at "$retry_at" \
    --argjson consecutive "$consecutive" \
    '{active: $active, triggered_at: $triggered_at, current_backoff_seconds: $backoff, retry_at: $retry_at, consecutive_rate_limits: $consecutive}' \
    > "${state_file}.tmp" && mv "${state_file}.tmp" "$state_file"

  return 0
}
```

The rate-limit state is cleared (reset to `active: false`, `consecutive_rate_limits: 0`) after a successful session completes without triggering a rate limit.

### 3.7 Cleanup Policies

#### 3.7.1 Artifact Types and Retention

| Artifact Type              | Location                                                | Default Retention | Config Key                                     |
|----------------------------|---------------------------------------------------------|-------------------|-------------------------------------------------|
| Request state directories  | `{repo}/.autonomous-dev/requests/{id}/`                 | 30 days           | `retention.completed_request_days`              |
| Event logs                 | `{repo}/.autonomous-dev/requests/{id}/events.jsonl`     | 90 days           | `retention.event_log_days`                      |
| Cost ledger (monthly)      | `~/.autonomous-dev/cost-ledger-YYYY-MM.jsonl`           | 12 months         | `retention.cost_ledger_months`                  |
| Daemon logs                | `~/.autonomous-dev/logs/daemon.log`                     | 30 days           | `retention.daemon_log_days`                     |
| Observation reports        | `{repo}/.autonomous-dev/observations/`                  | 90 days           | `retention.observation_report_days`             |
| Observation archives       | `{repo}/.autonomous-dev/observations/archive/`          | 365 days          | `retention.observation_archive_days`            |
| Git worktrees              | Created per request in the repo                         | Removed on completion + delay | `parallel.worktree_cleanup_delay_seconds` |
| Remote branches            | `autonomous/REQ-{id}` on origin                         | Removed on archive | `cleanup.delete_remote_branches`               |
| Archived requests          | `~/.autonomous-dev/archive/`                            | 365 days          | `retention.archive_days`                        |
| Config validation logs     | `~/.autonomous-dev/logs/config-validation.log`          | 7 days            | `retention.config_validation_log_days`          |

#### 3.7.2 Cleanup Triggers

Cleanup runs in two modes:

1. **Automatic**: The `CleanupEngine` runs at the end of every 100th supervisor-loop iteration (approximately once per ~50 minutes at default poll interval). It only processes artifacts past their retention period.
2. **Manual**: The `autonomous-dev cleanup` command triggers an immediate cleanup run. The `--dry-run` flag lists what would be cleaned without taking action.

#### 3.7.3 Cleanup Algorithm

```
for each repo in allowlist:
  for each request_dir in {repo}/.autonomous-dev/requests/:
    state = read state.json
    if state.status in (completed, cancelled, failed):
      age_days = (now - state.updated_at) in days
      if age_days > retention.completed_request_days:
        archive_request(request_dir)  # tar.gz state.json + events.jsonl
        delete worktree if exists
        delete remote branch if cleanup.delete_remote_branches == true
        delete request_dir

  for each observation in {repo}/.autonomous-dev/observations/:
    age_days = (now - observation.created_at) in days
    if age_days > retention.observation_report_days:
      move to archive/

  for each archived_observation in {repo}/.autonomous-dev/observations/archive/:
    age_days = (now - archived_observation.created_at) in days
    if age_days > retention.observation_archive_days:
      delete

rotate daemon logs older than retention.daemon_log_days
rotate config validation logs older than retention.config_validation_log_days
rotate archived cost ledgers older than retention.cost_ledger_months
rotate archived requests older than retention.archive_days
```

#### 3.7.4 Archive Format

Archived requests are stored as gzipped tarballs:

```
~/.autonomous-dev/archive/REQ-20260408-a3f1.tar.gz
  -> REQ-20260408-a3f1/state.json
  -> REQ-20260408-a3f1/events.jsonl
```

Working artifacts (generated documents, code snapshots, review feedback) are NOT included in the archive. Only the state file and event log are preserved, as required by PRD-001 FR-701.

---

## 4. Data Models

### 4.1 Complete Configuration Schema

This is the **single source of truth** for all configurable parameters across the entire `autonomous-dev` system. Every field is documented with its type, default value, validation constraints, and the PRD requirement it satisfies.

```json
{
  "$schema_version": 1,

  "daemon": {
    "poll_interval_seconds":        { "type": "integer", "default": 30,    "min": 5,   "max": 600,  "description": "Seconds between supervisor-loop iterations when no work is available.", "prd": "FR-407" },
    "heartbeat_interval_seconds":   { "type": "integer", "default": 30,    "min": 5,   "max": 120,  "description": "Seconds between heartbeat file writes.", "prd": "FR-103" },
    "circuit_breaker_threshold":    { "type": "integer", "default": 3,     "min": 1,   "max": 20,   "description": "Consecutive failed iterations before the circuit breaker trips.", "prd": "FR-105" },
    "log_retention_days":           { "type": "integer", "default": 30,    "min": 1,   "max": 365,  "description": "Days to retain daemon log files before rotation.", "prd": "FR-110" },
    "idle_backoff_base_seconds":    { "type": "integer", "default": 30,    "min": 5,   "max": 300,  "description": "Base sleep interval when no work is available.", "prd": "FR-408" },
    "idle_backoff_max_seconds":     { "type": "integer", "default": 900,   "min": 60,  "max": 3600, "description": "Maximum sleep interval during idle exponential backoff.", "prd": "FR-408" },
    "max_turns_by_phase": {
      "type": "object",
      "description": "Maximum Claude Code turns allowed per pipeline phase. Exceeding this terminates the session and triggers retry/escalation logic.",
      "prd": "FR-108, FR-508",
      "properties": {
        "intake":       { "type": "integer", "default": 10  },
        "prd":          { "type": "integer", "default": 50  },
        "prd_review":   { "type": "integer", "default": 30  },
        "tdd":          { "type": "integer", "default": 50  },
        "tdd_review":   { "type": "integer", "default": 30  },
        "plan":         { "type": "integer", "default": 50  },
        "plan_review":  { "type": "integer", "default": 30  },
        "spec":         { "type": "integer", "default": 50  },
        "spec_review":  { "type": "integer", "default": 30  },
        "code":         { "type": "integer", "default": 200 },
        "code_review":  { "type": "integer", "default": 50  },
        "integration":  { "type": "integer", "default": 100 },
        "deploy":       { "type": "integer", "default": 30  }
      }
    }
  },

  "state_machine": {
    "retry_limits_by_phase": {
      "type": "object",
      "description": "Maximum retry attempts per phase before escalation.",
      "prd": "FR-204, FR-302, FR-306",
      "properties": {
        "intake":       { "type": "integer", "default": 1 },
        "prd":          { "type": "integer", "default": 2 },
        "prd_review":   { "type": "integer", "default": 3 },
        "tdd":          { "type": "integer", "default": 2 },
        "tdd_review":   { "type": "integer", "default": 3 },
        "plan":         { "type": "integer", "default": 2 },
        "plan_review":  { "type": "integer", "default": 3 },
        "spec":         { "type": "integer", "default": 2 },
        "spec_review":  { "type": "integer", "default": 3 },
        "code":         { "type": "integer", "default": 3 },
        "code_review":  { "type": "integer", "default": 3 },
        "integration":  { "type": "integer", "default": 2 },
        "deploy":       { "type": "integer", "default": 2 }
      }
    },
    "timeouts_by_phase": {
      "type": "object",
      "description": "Maximum wall-clock time per phase before timeout. Format: '<number>m' for minutes.",
      "prd": "FR-204",
      "properties": {
        "intake":       { "type": "string", "default": "5m"   },
        "prd":          { "type": "string", "default": "30m"  },
        "prd_review":   { "type": "string", "default": "20m"  },
        "tdd":          { "type": "string", "default": "45m"  },
        "tdd_review":   { "type": "string", "default": "20m"  },
        "plan":         { "type": "string", "default": "30m"  },
        "plan_review":  { "type": "string", "default": "20m"  },
        "spec":         { "type": "string", "default": "45m"  },
        "spec_review":  { "type": "string", "default": "20m"  },
        "code":         { "type": "string", "default": "120m" },
        "code_review":  { "type": "string", "default": "30m"  },
        "integration":  { "type": "string", "default": "60m"  },
        "deploy":       { "type": "string", "default": "30m"  }
      }
    },
    "context_window_threshold_pct": { "type": "integer", "default": 80,   "min": 50,  "max": 95,   "description": "Percentage of context window usage that triggers a graceful exit and session handoff.", "prd": "FR-308" }
  },

  "governance": {
    "daily_cost_cap_usd":             { "type": "number",  "default": 100.00,  "min": 1.00,    "max": 10000.00, "description": "Maximum USD spend per calendar day (UTC). All requests pause when exceeded.", "prd": "FR-502" },
    "monthly_cost_cap_usd":           { "type": "number",  "default": 2000.00, "min": 10.00,   "max": 100000.00, "description": "Maximum USD spend per calendar month (UTC). All requests pause when exceeded.", "prd": "FR-502" },
    "per_request_cost_cap_usd":       { "type": "number",  "default": 50.00,   "min": 1.00,    "max": 5000.00, "description": "Maximum USD spend per individual request. The request pauses when exceeded.", "prd": "FR-503" },
    "max_concurrent_requests":        { "type": "integer", "default": 3,       "min": 1,       "max": 50,       "description": "Maximum requests being actively processed simultaneously. Excess requests queue in intake.", "prd": "FR-504" },
    "disk_usage_limit_gb":            { "type": "number",  "default": 10.0,    "min": 1.0,     "max": 500.0,   "description": "Maximum total disk usage of ~/.autonomous-dev/ directory. New requests blocked when exceeded.", "prd": "FR-506" },
    "rate_limit_backoff_base_seconds": { "type": "integer", "default": 30,     "min": 5,       "max": 300,     "description": "Initial backoff duration when an API rate limit is detected.", "prd": "FR-505" },
    "rate_limit_backoff_max_seconds":  { "type": "integer", "default": 900,    "min": 60,      "max": 3600,    "description": "Maximum backoff duration before the system pauses and escalates.", "prd": "FR-505" }
  },

  "repositories": {
    "allowlist": {
      "type": "array",
      "items": { "type": "string" },
      "default": [],
      "description": "Absolute paths to git repositories the system is allowed to operate on. Requests targeting unlisted repos are rejected at intake.",
      "prd": "FR-507, FR-606"
    },
    "overrides": {
      "type": "object",
      "default": {},
      "description": "Per-repository configuration overrides. Keys are absolute repo paths. Values are partial config objects merged at repo-override precedence."
    }
  },

  "trust": {
    "system_default_level":  { "type": "integer", "default": 1, "min": 0, "max": 3, "description": "Default trust level assigned to newly registered repositories. 0=full oversight, 1=guided, 2=PRD-only approval, 3=autonomous.", "prd": "FR-04, FR-607" },
    "repositories": {
      "type": "object",
      "default": {},
      "description": "Per-repository trust configuration. Keys are repo identifiers (org/repo or absolute path).",
      "prd": "FR-03",
      "value_schema": {
        "default_level":   { "type": "integer", "min": 0, "max": 3, "description": "Default trust level for this repository." },
        "auto_demotion": {
          "enabled":              { "type": "boolean", "default": true,  "description": "Whether the system automatically demotes trust level after consecutive failures." },
          "consecutive_failures": { "type": "integer", "default": 3,     "min": 1, "max": 20, "description": "Number of consecutive gate failures that trigger automatic demotion." },
          "demote_to":            { "type": "integer", "default": 1,     "min": 0, "max": 2,  "description": "Trust level to demote to on automatic demotion." }
        }
      }
    },
    "promotion": {
      "enabled":                    { "type": "boolean", "default": true,  "description": "Whether the system suggests trust-level promotions based on track record.", "prd": "FR-07" },
      "min_consecutive_successes":  { "type": "integer", "default": 20,    "min": 5, "max": 100, "description": "Minimum consecutive successful deliveries before suggesting promotion.", "prd": "FR-07" },
      "require_human_approval":     { "type": "boolean", "default": true,  "immutable": true, "description": "Trust promotions require human approval. This field cannot be set to false.", "prd": "FR-08" }
    }
  },

  "escalation": {
    "routing": {
      "mode":           { "type": "string",  "default": "default", "enum": ["default", "advanced"], "description": "Routing mode. 'default' sends all escalations to default_target. 'advanced' routes by escalation type.", "prd": "FR-22, FR-23" },
      "default_target": { "type": "string",  "default": "pm-lead", "description": "Default routing target for all escalations in 'default' mode.", "prd": "FR-22" },
      "advanced": {
        "type": "object",
        "description": "Per-type routing targets. Only used when mode is 'advanced'.",
        "prd": "FR-23, FR-24",
        "properties": {
          "product":        { "primary": { "type": "string", "default": "pm-lead" },       "secondary": { "type": "string", "default": "tech-lead" },     "timeout_minutes": { "type": "integer", "default": 60 } },
          "technical":      { "primary": { "type": "string", "default": "tech-lead" },     "secondary": { "type": "string", "default": "pm-lead" },       "timeout_minutes": { "type": "integer", "default": 120 } },
          "infrastructure": { "primary": { "type": "string", "default": "sys-operator" },  "secondary": { "type": "string", "default": "tech-lead" },     "timeout_minutes": { "type": "integer", "default": 30 } },
          "security":       { "primary": { "type": "string", "default": "security-lead" }, "secondary": { "type": "string", "default": "pm-lead" },       "timeout_minutes": { "type": "integer", "default": 15 } },
          "cost":           { "primary": { "type": "string", "default": "pm-lead" },       "timeout_minutes": { "type": "integer", "default": 60 } },
          "quality":        { "primary": { "type": "string", "default": "tech-lead" },     "secondary": { "type": "string", "default": "pm-lead" },       "timeout_minutes": { "type": "integer", "default": 120 } }
        }
      }
    },
    "timeout_behavior": {
      "default":    { "type": "string", "default": "pause", "enum": ["pause", "retry", "skip", "cancel"], "description": "What to do when an escalation times out without human response.", "prd": "FR-25" },
      "overrides": {
        "type": "object",
        "default": {},
        "description": "Per-escalation-type timeout behavior overrides.",
        "value_schema": { "type": "string", "enum": ["pause", "retry", "skip", "cancel"] }
      }
    },
    "retry_limits": {
      "quality_gate_max_iterations": { "type": "integer", "default": 3,  "min": 1, "max": 10, "description": "Maximum review-retry iterations before a quality escalation is raised.", "prd": "FR-16" },
      "technical_max_approaches":    { "type": "integer", "default": 3,  "min": 1, "max": 10, "description": "Maximum different implementation approaches before a technical escalation is raised.", "prd": "PRD-007 US-08" }
    },
    "verbosity": {
      "default":   { "type": "string", "default": "standard", "enum": ["terse", "standard", "verbose"], "description": "Default escalation message verbosity.", "prd": "FR-21" },
      "overrides": {
        "type": "object",
        "default": {},
        "description": "Per-repository or per-team verbosity overrides.",
        "value_schema": { "type": "string", "enum": ["terse", "standard", "verbose"] }
      }
    }
  },

  "notifications": {
    "delivery": {
      "default_method": { "type": "string", "default": "cli", "enum": ["cli", "discord", "slack", "file_drop"], "description": "Default notification delivery method.", "prd": "FR-49" },
      "overrides": {
        "type": "object",
        "default": {},
        "description": "Per-event-type delivery method overrides. Keys are event types (escalation, completion, daily_digest, phase_transition, gate_approved, gate_rejected, error).",
        "value_schema": { "type": "string", "enum": ["cli", "discord", "slack", "file_drop"] }
      },
      "channels": {
        "type": "array",
        "default": [{"type": "file", "path": "~/.autonomous-dev/notifications.log"}],
        "description": "Notification channel definitions.",
        "prd": "FR-605",
        "items_schema": {
          "type":        { "type": "string", "enum": ["file", "webhook", "cli"] },
          "path":        { "type": "string", "description": "File path for 'file' type." },
          "url":         { "type": "string", "description": "Webhook URL for 'webhook' type." }
        }
      },
      "discord": {
        "webhook_url":  { "type": "string",  "default": null, "description": "Discord webhook URL for embed notifications." },
        "channel_id":   { "type": "string",  "default": null, "description": "Discord channel ID for bot-based notifications." }
      },
      "slack": {
        "webhook_url":  { "type": "string",  "default": null, "description": "Slack webhook URL for Block Kit notifications." },
        "channel":      { "type": "string",  "default": null, "description": "Slack channel name for bot-based notifications." }
      }
    },
    "batching": {
      "enabled":           { "type": "boolean", "default": true,  "description": "Whether non-urgent notifications are batched into periodic digests.", "prd": "FR-51" },
      "interval_minutes":  { "type": "integer", "default": 60,    "min": 5, "max": 1440, "description": "Interval in minutes between batch notification deliveries.", "prd": "FR-51" },
      "exempt_types": {
        "type": "array",
        "items": { "type": "string" },
        "default": ["escalation", "error"],
        "description": "Notification event types that are always sent immediately, never batched."
      }
    },
    "dnd": {
      "enabled":              { "type": "boolean", "default": false, "description": "Whether Do Not Disturb hours are enforced.", "prd": "FR-52" },
      "start":                { "type": "string",  "default": "22:00", "description": "DND start time in HH:MM format.", "prd": "FR-52" },
      "end":                  { "type": "string",  "default": "07:00", "description": "DND end time in HH:MM format.", "prd": "FR-52" },
      "timezone":             { "type": "string",  "default": "America/New_York", "description": "IANA timezone for DND schedule.", "prd": "FR-52" },
      "breakthrough_urgency": {
        "type": "array",
        "items": { "type": "string" },
        "default": ["immediate"],
        "description": "Escalation urgency levels that bypass DND and are delivered immediately.",
        "prd": "FR-52"
      }
    },
    "fatigue": {
      "enabled":                    { "type": "boolean", "default": true, "description": "Whether notification fatigue detection is active.", "prd": "FR-54" },
      "threshold_per_hour":         { "type": "integer", "default": 20,   "min": 5, "max": 200, "description": "Notifications per hour to a single recipient before fatigue mode activates.", "prd": "FR-54" },
      "digest_cooldown_minutes":    { "type": "integer", "default": 30,   "min": 5, "max": 120, "description": "Minutes between digest deliveries when in fatigue mode.", "prd": "FR-54" }
    },
    "cross_request": {
      "enabled":                  { "type": "boolean", "default": true, "description": "Whether cross-request failure pattern detection is active.", "prd": "FR-55" },
      "failure_window_minutes":   { "type": "integer", "default": 60,   "min": 10, "max": 1440, "description": "Time window for detecting correlated failures across requests.", "prd": "FR-55" },
      "failure_threshold":        { "type": "integer", "default": 3,    "min": 2,  "max": 20,   "description": "Number of failures within the window to trigger a systemic-issue alert.", "prd": "FR-55" }
    },
    "summary_schedule":   { "type": "string",  "default": "daily",   "enum": ["daily", "weekly", "off"], "description": "Schedule for summary/digest notifications.", "prd": "FR-605" },
    "daily_digest_time":  { "type": "string",  "default": "09:00",   "description": "Time (HH:MM in configured timezone) to send the daily digest.", "prd": "PRD-006 FR-22" }
  },

  "review_gates": {
    "default_threshold":       { "type": "integer", "default": 85, "min": 0, "max": 100, "description": "Default minimum aggregate review score for gate approval.", "prd": "PRD-002 FR-014" },
    "thresholds_by_type": {
      "type": "object",
      "description": "Per-document-type approval thresholds.",
      "prd": "PRD-002 FR-014",
      "properties": {
        "PRD":  { "type": "integer", "default": 85 },
        "TDD":  { "type": "integer", "default": 85 },
        "Plan": { "type": "integer", "default": 80 },
        "Spec": { "type": "integer", "default": 80 },
        "Code": { "type": "integer", "default": 85 }
      }
    },
    "max_iterations":          { "type": "integer", "default": 3,      "min": 1, "max": 10,  "description": "Maximum review-retry iterations per gate before escalation.", "prd": "PRD-002 FR-017" },
    "panel_size": {
      "type": "object",
      "description": "Number of AI reviewer agents per review gate.",
      "prd": "PRD-002 FR-011",
      "properties": {
        "PRD":  { "type": "integer", "default": 2 },
        "TDD":  { "type": "integer", "default": 2 },
        "Plan": { "type": "integer", "default": 1 },
        "Spec": { "type": "integer", "default": 1 },
        "Code": { "type": "integer", "default": 2 }
      }
    },
    "score_aggregation":       { "type": "string",  "default": "mean", "enum": ["mean", "median", "min"], "description": "Method for aggregating scores from multiple reviewers.", "prd": "PRD-002 FR-013" },
    "disagreement_threshold":  { "type": "integer", "default": 15,     "min": 0, "max": 50,  "description": "Score variance between reviewers that triggers a disagreement flag.", "prd": "PRD-002 FR-013" }
  },

  "decomposition": {
    "max_children_per_parent":   { "type": "integer", "default": 10,  "min": 1,  "max": 50,  "description": "Maximum child documents per parent in decomposition.", "prd": "PRD-002 FR-036" },
    "max_pipeline_depth":        { "type": "integer", "default": 4,   "min": 2,  "max": 8,   "description": "Maximum decomposition depth (PRD -> TDD -> Plan -> Spec).", "prd": "PRD-002 FR-037" },
    "max_total_nodes":           { "type": "integer", "default": 100, "min": 10, "max": 500, "description": "Maximum total nodes across an entire pipeline tree before explosion alert.", "prd": "PRD-002 FR-041" },
    "explosion_alert_threshold": { "type": "integer", "default": 75,  "min": 50, "max": 100, "description": "Percentage of max_total_nodes at which the operator is warned.", "prd": "PRD-002 FR-041" }
  },

  "versioning": {
    "quality_regression_margin": { "type": "integer", "default": 5, "min": 1, "max": 20, "description": "Points below previous version score that triggers a quality-regression flag.", "prd": "PRD-002 FR-054" }
  },

  "backward_cascade": {
    "max_depth":                   { "type": "integer", "default": 2,     "min": 1, "max": 5, "description": "Maximum levels a backward cascade can propagate upstream.", "prd": "PRD-002 FR-074" },
    "require_human_confirmation":  { "type": "boolean", "default": false, "description": "Whether backward cascades require human confirmation before executing." }
  },

  "parallel": {
    "max_worktrees":                      { "type": "integer", "default": 5,    "min": 1,   "max": 20,   "description": "Maximum concurrent git worktrees across all requests.", "prd": "PRD-004 FR-006" },
    "max_tracks":                         { "type": "integer", "default": 3,    "min": 1,   "max": 10,   "description": "Maximum simultaneously executing parallel tracks per request.", "prd": "PRD-004 FR-014" },
    "disk_warning_threshold_gb":          { "type": "number",  "default": 2.0,  "min": 0.5, "max": 50.0, "description": "Aggregate worktree disk usage (GB) that triggers a warning event.", "prd": "PRD-004 FR-007" },
    "disk_hard_limit_gb":                 { "type": "number",  "default": 5.0,  "min": 1.0, "max": 100.0, "description": "Aggregate worktree disk usage (GB) that blocks new worktree creation.", "prd": "PRD-004 NFR-006" },
    "stall_timeout_minutes":              { "type": "integer", "default": 15,   "min": 5,   "max": 120,  "description": "Minutes without phase advancement before a track is flagged as stalled.", "prd": "PRD-004 FR-044" },
    "agent_turn_budget": {
      "type": "object",
      "description": "Turn budgets for parallel execution agents, segmented by estimated complexity.",
      "prd": "PRD-004 FR-021, FR-023",
      "properties": {
        "small":  { "type": "integer", "default": 30  },
        "medium": { "type": "integer", "default": 60  },
        "large":  { "type": "integer", "default": 120 }
      }
    },
    "conflict_ai_confidence_threshold":   { "type": "number",  "default": 0.85, "min": 0.0, "max": 1.0, "description": "Minimum AI confidence for automated merge-conflict resolution. Below this, escalate.", "prd": "PRD-004" },
    "worktree_cleanup_delay_seconds":     { "type": "integer", "default": 300,  "min": 0,   "max": 3600, "description": "Seconds to wait after track completion before worktree removal (allows inspection).", "prd": "PRD-004" }
  },

  "pipeline_control": {
    "default_priority":         { "type": "string",  "default": "normal",  "enum": ["critical", "high", "normal", "low"], "description": "Default priority for newly submitted requests.", "prd": "PRD-002 FR-084" },
    "max_concurrent_pipelines": { "type": "integer", "default": 5,         "min": 1, "max": 20, "description": "Maximum concurrent pipeline trees being processed.", "prd": "PRD-002" }
  },

  "agents": {
    "anomaly_detection": {
      "approval_rate_threshold":       { "type": "number",  "default": 0.70, "min": 0.0, "max": 1.0, "description": "Agent approval rate below which an alert is raised.", "prd": "PRD-003 FR-09" },
      "escalation_rate_threshold":     { "type": "number",  "default": 0.30, "min": 0.0, "max": 1.0, "description": "Agent escalation rate above which an alert is raised.", "prd": "PRD-003 FR-09" },
      "observation_threshold":         { "type": "integer", "default": 10,   "min": 5, "max": 50, "description": "Minimum invocations before the system proposes modifications.", "prd": "PRD-003 FR-13" }
    },
    "modification_rate_limits": {
      "max_new_agents_per_week":       { "type": "integer", "default": 1, "min": 0, "max": 5, "description": "Maximum new agent creations per calendar week.", "prd": "PRD-003 FR-24" },
      "max_modifications_per_agent_per_week": { "type": "integer", "default": 1, "min": 0, "max": 5, "description": "Maximum modifications per agent per calendar week.", "prd": "PRD-003 FR-24" }
    },
    "canary_period_days":              { "type": "integer", "default": 7, "min": 1, "max": 30, "description": "Duration of canary testing for proposed agent modifications.", "prd": "PRD-003 FR-17" }
  },

  "production_intelligence": {
    "enabled":   { "type": "boolean", "default": true,         "description": "Whether the production observation loop is active.", "prd": "PRD-005" },
    "schedule":  { "type": "string",  "default": "0 */4 * * *", "description": "Cron expression or simple interval for observation runs.", "prd": "PRD-005 FR-006" },
    "error_detection": {
      "default_error_rate_percent":      { "type": "number",  "default": 5.0,  "min": 0.1, "max": 100.0, "description": "Default error rate threshold for triggering an observation.", "prd": "PRD-005 FR-015" },
      "default_sustained_duration_min":  { "type": "integer", "default": 10,   "min": 1,   "max": 120,   "description": "Default minimum sustained duration before an observation triggers.", "prd": "PRD-005 FR-015" }
    },
    "anomaly_detection": {
      "method":                { "type": "string",  "default": "z_score", "enum": ["z_score", "std_deviation", "iqr"], "description": "Statistical method for anomaly detection.", "prd": "PRD-005 FR-018" },
      "sensitivity":           { "type": "number",  "default": 2.5,      "min": 1.0, "max": 5.0, "description": "Z-score or equivalent threshold for anomaly flagging.", "prd": "PRD-005 FR-018" },
      "baseline_window_days":  { "type": "integer", "default": 14,       "min": 7,   "max": 90,  "description": "Rolling window of historical data used as baseline.", "prd": "PRD-005 FR-018" }
    },
    "trend_analysis": {
      "enabled":              { "type": "boolean", "default": true,          "description": "Whether trend analysis is active." },
      "windows":              { "type": "array",   "default": [7, 14, 30],  "description": "Comparison window sizes in days.", "prd": "PRD-005 FR-019" },
      "min_slope_threshold":  { "type": "number",  "default": 0.05, "min": 0.01, "max": 0.5, "description": "Minimum change rate per window to flag a trend.", "prd": "PRD-005 FR-019" }
    },
    "governance": {
      "cooldown_days":                      { "type": "integer", "default": 7,    "min": 1, "max": 30,  "description": "Cooldown period after a fix deployment before re-observing.", "prd": "PRD-005 FR-032" },
      "oscillation_threshold":              { "type": "integer", "default": 3,    "min": 2, "max": 10,  "description": "Observations in window that constitute a systemic issue.", "prd": "PRD-005" },
      "oscillation_window_days":            { "type": "integer", "default": 30,   "min": 7, "max": 90,  "description": "Window for oscillation detection.", "prd": "PRD-005" },
      "effectiveness_comparison_days":      { "type": "integer", "default": 7,    "min": 1, "max": 30,  "description": "Days before/after deployment to compare for effectiveness.", "prd": "PRD-005 FR-035" },
      "effectiveness_improvement_threshold": { "type": "number", "default": 0.10, "min": 0.01, "max": 0.5, "description": "Minimum improvement ratio to consider a fix effective.", "prd": "PRD-005 FR-035" }
    }
  },

  "intake": {
    "max_queue_depth":            { "type": "integer", "default": 50,    "min": 5,  "max": 500, "description": "Maximum pending requests in the intake queue.", "prd": "PRD-006 FR-15" },
    "starvation_threshold_hours": { "type": "integer", "default": 48,    "min": 1,  "max": 168, "description": "Hours a low-priority request waits before automatic priority promotion.", "prd": "PRD-006 FR-16" },
    "duplicate_similarity_threshold": { "type": "number", "default": 0.85, "min": 0.5, "max": 1.0, "description": "Cosine similarity threshold for duplicate request detection.", "prd": "PRD-006 FR-10" },
    "max_clarifying_rounds":      { "type": "integer", "default": 5,     "min": 1,  "max": 10,  "description": "Maximum clarifying-question rounds before escalation.", "prd": "PRD-006 FR-28" },
    "response_timeout_minutes":   { "type": "integer", "default": 240,   "min": 10, "max": 1440, "description": "Minutes to wait for human input before timeout action.", "prd": "PRD-006 FR-26" },
    "response_timeout_action":    { "type": "string",  "default": "pause", "enum": ["pause", "default", "escalate"], "description": "Action when human response times out.", "prd": "PRD-006 FR-26" },
    "rate_limits": {
      "submissions_per_hour":     { "type": "integer", "default": 10, "min": 1, "max": 100, "description": "Maximum request submissions per user per rolling hour.", "prd": "PRD-006 FR-44" },
      "queries_per_minute":       { "type": "integer", "default": 60, "min": 10, "max": 600, "description": "Maximum status/list queries per user per rolling minute.", "prd": "PRD-006 FR-45" }
    }
  },

  "cleanup": {
    "auto_cleanup_interval_iterations": { "type": "integer", "default": 100,  "min": 10,  "max": 1000, "description": "Supervisor-loop iterations between automatic cleanup runs." },
    "delete_remote_branches":           { "type": "boolean", "default": true,  "description": "Whether remote branches are deleted when archiving completed requests.", "prd": "FR-305" }
  },

  "retention": {
    "completed_request_days":       { "type": "integer", "default": 30,  "min": 7,   "max": 365,  "description": "Days to retain completed/cancelled/failed request state directories before archival.", "prd": "FR-700" },
    "event_log_days":               { "type": "integer", "default": 90,  "min": 30,  "max": 365,  "description": "Days to retain active event logs before archival.", "prd": "PRD-007 FR-47" },
    "cost_ledger_months":           { "type": "integer", "default": 12,  "min": 3,   "max": 60,   "description": "Months to retain archived monthly cost ledger files." },
    "daemon_log_days":              { "type": "integer", "default": 30,  "min": 7,   "max": 365,  "description": "Days to retain daemon log files before deletion.", "prd": "FR-602" },
    "observation_report_days":      { "type": "integer", "default": 90,  "min": 30,  "max": 365,  "description": "Days to retain observation reports before archival.", "prd": "PRD-005 FR-040" },
    "observation_archive_days":     { "type": "integer", "default": 365, "min": 90,  "max": 1825, "description": "Days to retain archived observation reports before deletion.", "prd": "PRD-005 FR-040" },
    "archive_days":                 { "type": "integer", "default": 365, "min": 90,  "max": 1825, "description": "Days to retain archived request tarballs before deletion." },
    "config_validation_log_days":   { "type": "integer", "default": 7,   "min": 1,   "max": 30,   "description": "Days to retain config validation logs." }
  },

  "audit": {
    "integrity": {
      "hash_chain_enabled":  { "type": "boolean", "default": false, "description": "Whether event log entries are hash-chained for tamper detection. Planned for Phase 3.", "prd": "PRD-007 FR-46" }
    }
  },

  "emergency": {
    "kill_default_mode":       { "type": "string",  "default": "graceful", "enum": ["graceful", "hard"], "description": "Default kill-switch behavior. 'graceful' waits for current atomic operation. 'hard' interrupts immediately.", "prd": "PRD-007 FR-34" },
    "restart_requires_human":  { "type": "boolean", "default": true, "immutable": true, "description": "After a kill, the system requires human action to restart. Cannot be set to false.", "prd": "PRD-007 FR-36" }
  }
}
```

### 4.2 Cost Ledger Entry Schema

Each line in `~/.autonomous-dev/cost-ledger.jsonl`:

```json
{
  "timestamp":                   "string (ISO 8601, UTC)",
  "request_id":                  "string (REQ-YYYYMMDD-XXXX)",
  "repository":                  "string (absolute path)",
  "phase":                       "string (pipeline phase name)",
  "session_id":                  "string (Claude Code session ID)",
  "cost_usd":                    "number (session cost in USD)",
  "turns_used":                  "integer (turns consumed in session)",
  "cumulative_request_cost_usd": "number (running total for this request)",
  "daily_total_usd":             "number (running total for current UTC day)",
  "monthly_total_usd":           "number (running total for current UTC month)"
}
```

### 4.3 Rate Limit State Schema

Stored at `~/.autonomous-dev/rate-limit-state.json`:

```json
{
  "active":                    "boolean",
  "triggered_at":              "string (ISO 8601, UTC) | null",
  "current_backoff_seconds":   "integer",
  "retry_at":                  "string (ISO 8601, UTC) | null",
  "consecutive_rate_limits":   "integer"
}
```

### 4.4 Config Validation Error Schema

Written to `~/.autonomous-dev/logs/config-validation.log`:

```json
{
  "timestamp": "string (ISO 8601, UTC)",
  "level":     "string (error | warning)",
  "rule":      "string (V-NNN)",
  "field":     "string (dot-notation path)",
  "value":     "any (the invalid value)",
  "constraint":"string (human-readable constraint description)",
  "source":    "string (file path where the invalid value was found)",
  "message":   "string (human-readable error message)"
}
```

---

## 5. Error Handling

### 5.1 Configuration Errors

| Error                          | Detection                              | Response                                                        |
|--------------------------------|----------------------------------------|-----------------------------------------------------------------|
| Config file not found          | `stat` returns non-zero                | Use next-lower-precedence layer. If no layer exists, use defaults only. Log warning. |
| Config file is invalid JSON    | `jq` parse failure                     | Refuse to start. Log the parse error with line/column.           |
| Schema validation failure      | Validation pipeline step 2             | Refuse to start. Log all validation errors (not just the first). |
| Cross-field validation failure | Validation pipeline step 3             | Refuse to start. Log the constraint violation.                   |
| Path does not exist            | Validation pipeline step 4 (allowlist) | Warning for allowlist paths. Error for critical paths (log dir). |
| Permission issue               | Validation pipeline step 5             | Warning. Operator should fix file permissions.                   |

### 5.2 Cost Ledger Errors

| Error                          | Detection                              | Response                                                        |
|--------------------------------|----------------------------------------|-----------------------------------------------------------------|
| Ledger file missing            | `stat` returns non-zero                | Create a new empty ledger file. Log warning. Daily/monthly totals start at 0. |
| Ledger file corrupted          | Last line fails JSON parse             | Refuse to start. Operator must fix or remove the file.           |
| Ledger write failure           | `mv` of temp file fails               | Log error. Retry once. If retry fails, pause all requests and escalate. The cost was incurred but is unrecorded; the system errs on the side of caution. |
| Stale daily total              | Last entry's date != today             | Daily total resets to 0. Monthly total carries forward if same month. |
| Stale monthly total            | Last entry's month != this month       | Both daily and monthly totals reset to 0.                        |

### 5.3 Resource Monitor Errors

| Error                          | Detection                              | Response                                                        |
|--------------------------------|----------------------------------------|-----------------------------------------------------------------|
| `du` command fails             | Non-zero exit code                     | Log warning. Skip disk check for this iteration. Do NOT block work due to inability to measure. |
| Rate limit state file missing  | `stat` returns non-zero                | Treat as "no active rate limit". Create file on next rate limit event. |
| Rate limit state corrupted     | JSON parse failure                     | Delete the file and create a fresh one. Log warning.             |
| Worktree list command fails    | `git worktree list` non-zero           | Log warning. Assume worktree count is at max (conservative).     |

### 5.4 Cleanup Errors

| Error                          | Detection                              | Response                                                        |
|--------------------------------|----------------------------------------|-----------------------------------------------------------------|
| Archive creation fails         | `tar` non-zero exit                    | Log error. Skip this request's cleanup. Retry next cycle.        |
| Remote branch deletion fails   | `git push --delete` non-zero           | Log warning. Continue with local cleanup. Orphaned remote branches are not critical. |
| Worktree removal fails         | `git worktree remove` non-zero         | Log error. Attempt force removal. If still fails, flag for manual intervention. |

---

## 6. Security

### 6.1 Configuration File Security

- Configuration files may contain sensitive values (webhook URLs, channel IDs). The validation pipeline warns if the file has group/world-readable permissions.
- The system never writes API keys, tokens, or passwords to configuration files. Webhook URLs are the most sensitive value and are documented as such.
- The `autonomous-dev config show` command redacts webhook URLs in its output, showing only the domain.

### 6.2 Cost Ledger Integrity

- The ledger is append-only. There is no command or code path that modifies or deletes existing entries.
- Ledger rotation (monthly) copies entries to a new file; the original is renamed, not modified.
- Hash-chain integrity for the event log (PRD-007 FR-46) is planned for Phase 3. The cost ledger may adopt the same mechanism if tamper detection is needed.

### 6.3 Repository Allowlist

- The allowlist is the primary security boundary preventing the system from operating on arbitrary repositories.
- Symlinks are resolved before comparison, preventing bypass via symbolic links.
- The allowlist is checked at intake AND at session spawn (defense in depth). Even if a state file is manually edited to point to a non-allowlisted repo, the session will not run.

### 6.4 Immutable Fields

Two configuration fields are marked `immutable: true`:
- `trust.promotion.require_human_approval` (always `true`)
- `emergency.restart_requires_human` (always `true`)

The validation pipeline rejects any config file that sets these to `false`. This prevents an operator from accidentally removing safety rails.

---

## 7. Testing Strategy

### 7.1 Unit Tests

| Component         | Test Cases                                                                                     |
|-------------------|------------------------------------------------------------------------------------------------|
| ConfigLoader      | Merge two objects (deep merge). Array replacement semantics. CLI override parsing. Missing layers handled. Defaults applied for all missing fields. |
| Validation        | All 20 validation rules (V-001 through V-020). Each rule has a positive test (valid value passes) and a negative test (invalid value produces the expected error). Cross-field validations. |
| CostGovernor      | Budget check with amounts below/at/above each cap. Daily total reset on new day. Monthly total reset on new month. Ledger entry construction. Cost extraction regex against sample Claude Code outputs. |
| ResourceMonitor   | Disk usage calculation. Worktree counting. Rate limit state machine transitions (active -> backoff -> retry -> clear, active -> max -> escalate). |
| CleanupEngine     | Retention calculation for each artifact type. Archive creation. Dry-run mode produces correct output without side effects. |

All state machine logic for these components is implemented as pure functions (input -> output) testable without spawning Claude Code sessions, per PRD-001 NFR-09.

### 7.2 Integration Tests

| Scenario                                           | Validation                                                             |
|----------------------------------------------------|------------------------------------------------------------------------|
| Full config load with global + project + CLI layers | Merged config matches expected values. Precedence is correct.          |
| Cost cap enforcement end-to-end                    | Submit request, simulate cost recording, verify pause when cap hit.     |
| Rate limit detection and backoff                   | Inject rate-limit error into session output. Verify backoff state file created. Verify next iteration sleeps for correct duration. |
| Cleanup of completed request                       | Create a completed request older than retention. Run cleanup. Verify archive created, state dir removed, worktree removed. |
| Config hot-reload                                  | Modify config between iterations. Verify new values take effect.        |

### 7.3 Property-Based Tests

| Property                                           | Generator                                                              |
|----------------------------------------------------|------------------------------------------------------------------------|
| Deep merge is associative                          | Random nested JSON objects. `merge(merge(a, b), c) == merge(a, merge(b, c))` |
| Validation catches all out-of-range values         | Random values outside declared min/max bounds for every numeric field.  |
| Cost ledger daily total is monotonically increasing within a day | Random sequence of cost entries within a single UTC day.    |
| Config defaults produce a valid configuration      | Load defaults only. Run full validation. Must pass with zero errors.    |

### 7.4 Test Fixtures

A `test/fixtures/` directory will contain:
- `config-valid-full.json` --- a config file with every field explicitly set to a non-default value.
- `config-valid-minimal.json` --- an empty `{}` (all defaults).
- `config-invalid-*.json` --- one file per validation rule, each containing exactly one invalid field.
- `cost-ledger-sample.jsonl` --- a ledger with entries spanning multiple days and months.
- `claude-output-with-cost.txt` --- sample Claude Code session output containing cost information.
- `claude-output-crashed.txt` --- sample output from a crashed session (no cost line).

---

## 8. Trade-offs & Alternatives

### 8.1 JSONL vs. SQLite for Cost Ledger

**Chosen: JSONL (append-only)**

| Factor          | JSONL                                      | SQLite                                      |
|-----------------|--------------------------------------------|----------------------------------------------|
| Simplicity      | Append with `>>`. No library needed.        | Requires `sqlite3` binary or library.         |
| Crash safety    | Partial writes lose at most one line.       | WAL mode provides crash safety.               |
| Query speed     | O(n) scan for aggregates.                   | O(1) with indexes.                            |
| Dependencies    | `jq` (already required).                    | `sqlite3` (additional dependency).            |
| Auditability    | Human-readable with `cat`/`tail`.           | Requires `sqlite3` tool to inspect.           |
| Concurrency     | Append is safe from a single writer.        | Better for multi-writer scenarios.            |

JSONL was chosen because the system has a single writer (the supervisor loop), queries are infrequent (CLI commands, not real-time dashboards), and minimizing dependencies is a design goal (PRD-001 NFR-06: only `bash`, `claude`, `jq`, `git`). If query performance becomes a bottleneck (unlikely for the projected ~100 entries/day), a migration to SQLite is straightforward since the schema is simple.

### 8.2 Array Merge: Replace vs. Concatenate

**Chosen: Replace**

Replace semantics mean a project-level config's `repositories.allowlist` completely overrides the global one. This was chosen over concatenation because:
- It is impossible to *remove* an item from a concatenated array without a separate "deny" mechanism.
- The allowlist is a security boundary; partial merges could lead to unexpected permissions.
- Every other major configuration system (Kubernetes, Terraform, ESLint) uses replace for arrays.

### 8.3 Cost Aggregates: Denormalized in Ledger vs. Computed on Read

**Chosen: Denormalized (daily_total_usd, monthly_total_usd in each entry)**

This trades a small amount of additional write work for O(1) budget checks. Since budget checks happen every iteration (every 30 seconds) and ledger writes happen only when a session completes (perhaps a few times per hour), the read/write ratio strongly favors denormalization.

### 8.4 Config Format: JSON vs. YAML vs. TOML

**Chosen: JSON**

| Factor          | JSON                | YAML                | TOML                |
|-----------------|---------------------|---------------------|---------------------|
| Parsing in bash | `jq` (robust)       | Requires `yq` or Python | No standard bash tool |
| Comments        | Not supported        | Supported           | Supported           |
| Human editing   | Verbose but unambiguous | Concise but whitespace-sensitive | Clean but less known |
| PRD requirement | FR-601 specifies JSON | ---                 | ---                 |

JSON was specified in PRD-001 FR-601 and is directly parseable with `jq`, which is already a hard dependency. The lack of comments is a downside; the `config init` command generates a companion `autonomous-dev.json.commented` file with documentation, while the actual config remains pure JSON.

### 8.5 Rate Limit Scope: Per-Request vs. Global

**Chosen: Global**

When one request hits a rate limit, ALL requests pause. This is more conservative than necessary (only the rate-limited request needs to wait), but it prevents N concurrent requests from each independently hitting the rate limit and generating N separate backoff cycles. A global pause-and-resume is simpler, more predictable, and safer for API quota management.

---

## 9. Implementation Plan

### Phase 1: Configuration Foundation (Week 1)

| Task | Description | Dependencies |
|------|-------------|--------------|
| 1.1 | Create `config_defaults.json` with all fields and defaults from Section 4.1. | None |
| 1.2 | Implement `config_loader.sh`: read global, read project, deep-merge with `jq`. | 1.1 |
| 1.3 | Implement CLI override parsing (`parse_cli_override`). | 1.2 |
| 1.4 | Implement validation pipeline: JSON parse, type checks, range checks, cross-field rules. | 1.2 |
| 1.5 | Implement `autonomous-dev config init` (generate default config) and `config show` (display effective config with source annotations). | 1.2, 1.4 |
| 1.6 | Unit tests for all merge, parse, and validation logic. | 1.2, 1.3, 1.4 |

### Phase 2: Cost Governance (Week 2)

| Task | Description | Dependencies |
|------|-------------|--------------|
| 2.1 | Implement cost extraction from Claude Code session output. | None |
| 2.2 | Implement cost ledger: append entry, compute daily/monthly aggregates. | 2.1 |
| 2.3 | Implement budget enforcement: pre-session check, post-session check, cap hierarchy. | 2.2 |
| 2.4 | Implement cost escalation payload construction. | 2.3 |
| 2.5 | Implement `autonomous-dev cost` CLI commands (daily, monthly, per-request, per-repo). | 2.2 |
| 2.6 | Unit and integration tests for cost tracking and enforcement. | 2.1 - 2.5 |

### Phase 3: Resource Monitoring (Week 3)

| Task | Description | Dependencies |
|------|-------------|--------------|
| 3.1 | Implement disk usage monitoring (system-wide and worktree-specific). | Phase 1 |
| 3.2 | Implement worktree and session counting. | Phase 1 |
| 3.3 | Implement rate-limit detection and backoff state machine. | Phase 1 |
| 3.4 | Implement repository allowlist validation. | Phase 1 |
| 3.5 | Integration tests: disk limits, rate-limit backoff sequence, allowlist rejection. | 3.1 - 3.4 |

### Phase 4: Cleanup & Retention (Week 4)

| Task | Description | Dependencies |
|------|-------------|--------------|
| 4.1 | Implement per-artifact-type retention calculation. | Phase 1 |
| 4.2 | Implement archive creation (tar.gz of state + events). | 4.1 |
| 4.3 | Implement worktree and remote branch cleanup. | 4.1 |
| 4.4 | Implement cost ledger rotation (monthly). | Phase 2 |
| 4.5 | Implement `autonomous-dev cleanup` with `--dry-run`. | 4.1 - 4.4 |
| 4.6 | Implement automatic cleanup trigger in supervisor loop. | 4.5 |
| 4.7 | Integration tests: end-to-end cleanup of aged artifacts. | 4.1 - 4.6 |

### Phase 5: Plugin Hook Integration (Week 5)

| Task | Description | Dependencies |
|------|-------------|--------------|
| 5.1 | Wire `SessionStart` hook: config validation + budget check + resource check. | Phases 1-3 |
| 5.2 | Wire `Stop` hook: cost recording + resource count update. | Phase 2, 3 |
| 5.3 | Wire `PreCompact` hook: context-window-exhaustion logging + checkpoint. | Phase 1 |
| 5.4 | Wire `SubagentStop` hook: individual cost attribution. | Phase 2 |
| 5.5 | End-to-end integration test: full iteration cycle with all hooks. | 5.1 - 5.4 |

---

## 10. Open Questions

| ID    | Question                                                                                                   | Impact                                                        | Owner          | Status |
|-------|------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------|----------------|--------|
| OQ-1  | Should cost extraction support multiple Claude Code output formats (versioned), or should we pin to one known format and fail loudly on change? | Determines fragility of cost tracking. Pinning is safer but requires updates on CLI changes. | System Operator | Open |
| OQ-2  | Should the cost ledger include a `model` field to track which Claude model was used per session? Cost per token varies by model. | Affects accuracy of cost projections and per-model reporting. | PM Lead | Open |
| OQ-3  | PRD-001 OQ-9 asks whether high-priority requests should be exempt from per-request cost caps. This TDD takes the conservative "no exemptions" position. Should we revisit? | High-priority requests could be blocked by their own cost cap while lower-priority requests finish cheaply. | PM Lead | Open |
| OQ-4  | Should config validation run in a "strict" mode (warnings become errors) for production deployments? | Would catch more issues at startup but may be too aggressive during initial setup. | System Operator | Open |
| OQ-5  | The `jq` deep-merge operator (`*`) has specific behavior for `null` values (null in overlay removes the key). Should we pre-filter nulls from config files, or document this as expected behavior? | Operators could accidentally remove fields by setting them to `null` in a project config. | Staff Engineer | Open |
| OQ-6  | PRD-005 defines its own `intelligence.yaml` config format. Should all production-intelligence config be folded into the main `autonomous-dev.json`, or should it remain a separate file for separation of concerns? | Single file is simpler for the config system. Separate file is easier for teams who only manage observability. | PM Lead | Open |
| OQ-7  | PRD-006 defines `intake-auth.yaml` for RBAC configuration. Same question: fold into main config or keep separate? Auth config has different access sensitivity than general settings. | Security considerations favor a separate file with tighter permissions. Operational simplicity favors one file. | Security Lead | Open |
| OQ-8  | Should the cost ledger support retroactive correction entries (e.g., "the previous entry over-reported by $X due to a parsing bug")? Or should corrections be out-of-band? | Affects ledger append-only guarantees and aggregate accuracy. | Staff Engineer | Open |
| OQ-9  | What happens if an operator changes `retention.completed_request_days` from 30 to 7? Should existing archived requests that are between 7 and 30 days old be cleaned up on the next cycle, or should the shorter retention apply only to newly completed requests? | Retroactive application could surprise operators. Prospective-only is safer but leaves stale data. | System Operator | Open |
| OQ-10 | Should the `autonomous-dev config show` command display the complete schema (all fields, even those at defaults) or only fields that have been explicitly set? | Complete display is more useful for debugging. Explicit-only is cleaner for understanding customization. The current design shows all with source annotations. | Staff Engineer | Open |

---

*End of TDD-010: Configuration & Resource Governance*
