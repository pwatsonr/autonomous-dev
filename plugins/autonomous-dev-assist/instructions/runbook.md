# autonomous-dev Operations Runbook

Comprehensive operational reference for the autonomous-dev autonomous AI development system. This document covers system architecture, file locations, CLI commands, diagnostic procedures, emergency procedures, maintenance procedures, and configuration reference.

---

## 1. System Architecture Overview

autonomous-dev is a Claude Code plugin that runs as a background daemon. It receives product requests, decomposes them through a document pipeline, reviews its own work at every gate, tests and deploys code, and monitors production for errors.

### 1.1 Core Subsystems

| Subsystem | Purpose |
|---|---|
| **Daemon (Supervisor)** | Long-running background process. Polls for work every 30s, dispatches Claude CLI sessions, manages heartbeats, circuit breaking, idle backoff, log rotation, and cost enforcement. Installed as macOS LaunchAgent or Linux systemd user service. |
| **State Machine** | Manages request lifecycle through pipeline phases with retries, timeouts, context window budgets, and checkpoint/recovery. Atomic state file operations with schema validation. |
| **Pipeline Engine** | Orchestrates the document pipeline: PRD > TDD > Plan > Spec > Code > Deploy. Manages state transitions, decomposition (parent/child requests), and template-based phase prompts. |
| **Review Gate** | Assembles reviewer panels, executes blind scoring against rubrics, aggregates scores (mean), detects disagreement (>15 points), and controls iteration loops. Enforces quality thresholds before advancing. |
| **Trust Engine** | Resolves effective trust level (L0-L3) per repository. Evaluates a 4x7 gate authority matrix. Security review is always human-controlled (immutable). |
| **Escalation Engine** | Classifies stuck situations by category (product, technical, infrastructure, security, cost, quality). Routes to the right human via routing chains with timeouts. Manages human responses. |
| **Agent Factory** | Self-improving agent system. Tracks performance metrics, detects anomalies, generates improvement proposals, runs A/B validation with blind scoring, manages canary deployments, detects domain gaps. Rate-limited: max 1 new agent and 1 modification per agent per week. |
| **Parallel Executor** | Runs independent tasks concurrently using git worktrees. DAG-based scheduling, disk resource monitoring, conflict classification, AI-assisted merge conflict resolution. |
| **Intake System** | Receives requests from Claude App, Discord, and Slack. Parses, validates, deduplicates, rate-limits, and queues. Supports clarifying conversations and priority management. |
| **Production Intelligence** | Connects to Prometheus, Grafana, OpenSearch, and Sentry via MCP. Detects errors and anomalies (z-score), analyzes trends, deduplicates observations, generates fix PRDs. Governance prevents oscillation with cooldown periods. |
| **Safety Pipeline** | Non-bypassable PII and secret scrubbing. 11 PII patterns + 15 secret patterns + entropy-based detection. Runs on all collected data before analysis. Weekly audit scan as second line of defense. |
| **Cost Governor** | Three-layer cost protection: per-request ($50), daily ($100), monthly ($2,000). Pauses new work when any cap is hit. JSONL cost ledger with rotation and archival. |
| **Audit Trail** | Records every decision, state transition, and event. Structured JSONL event logs. Optional hash chain integrity. Decision replay for debugging. Configurable retention. |
| **Notifications** | Delivers messages via CLI, Discord, Slack, or file. Batching (hourly digests), do-not-disturb mode, fatigue detection (max 20/hour), cross-request systemic failure alerts. |

### 1.2 Pipeline Flow

```
Request arrives (intake)
    |
    v
Queue --> Daemon picks up --> Pipeline dispatches phase agent
    |                              |
    |                              v
    |                         Agent produces artifact
    |                              |
    |                              v
    |                         Review gate scores it
    |                              |
    |                    score >= threshold?
    |                   /                    \
    |                 yes                     no
    |                  |                       |
    |                  v                       v
    |            Next phase              Revise (up to 3x)
    |                  |                       |
    |                  |                  still failing?
    |                  |                       |
    |                  |                       v
    |                  |               Escalate to human
    |                  |
    v                  v
(repeat)         Code complete --> Tests --> Deploy --> Observe
                                                          |
                                                     error found?
                                                          |
                                                          v
                                                Generate fix PRD
                                                (back to pipeline)
```

### 1.3 Pipeline Phases

| Phase | Agent | Review Threshold | Timeout | Max Turns |
|---|---|---|---|---|
| intake | (system) | -- | 5m | 10 |
| prd | prd-author | 85 | 30m | 50 |
| prd_review | doc-reviewer + quality-reviewer | -- | 20m | 30 |
| tdd | tdd-author | 85 | 45m | 50 |
| tdd_review | architecture-reviewer + quality-reviewer | -- | 20m | 30 |
| plan | plan-author | 80 | 30m | 50 |
| plan_review | quality-reviewer | -- | 20m | 30 |
| spec | spec-author | 80 | 45m | 50 |
| spec_review | quality-reviewer | -- | 20m | 30 |
| code | code-executor | 85 | 120m | 200 |
| code_review | security-reviewer + quality-reviewer | -- | 30m | 50 |
| integration | test-executor | -- | 60m | 100 |
| deploy | deploy-executor | -- | 30m | 30 |

### 1.4 Trust Levels

| Gate | L0 (Paranoid) | L1 | L2 | L3 |
|---|---|---|---|---|
| PRD approval | human | human | system | system |
| Code review | human | human | human | system |
| Test review | human | system | system | system |
| Deploy approval | human | human | human | system |
| Security review | human | human | human | **human** (always) |
| Cost approval | human | human | system | system |
| Quality gate | human | system | system | system |

Security review is always human-controlled. This is enforced at the type system level and cannot be overridden by configuration.

### 1.5 Registered Agents

| Agent | Role | Expertise |
|---|---|---|
| prd-author | author | product-requirements, user-stories, acceptance-criteria |
| tdd-author | author | technical-design, architecture |
| plan-author | author | implementation-planning, task-decomposition |
| spec-author | author | implementation-specs, detailed-design |
| code-executor | author | implementation, testing |
| test-executor | author | test-suites, integration-testing |
| deploy-executor | author | deployment, CI/CD |
| quality-reviewer | reviewer | quality, completeness, clarity |
| security-reviewer | reviewer | security, vulnerabilities |
| architecture-reviewer | reviewer | architecture, design-patterns |
| doc-reviewer | reviewer | documentation, requirements |
| performance-analyst | reviewer | performance, optimization |
| agent-meta-reviewer | reviewer | agent-improvements |

---

## 2. File Locations

### 2.1 Daemon Home (`~/.autonomous-dev/`)

| File | Purpose | Format |
|---|---|---|
| `daemon.lock` | PID lock file. Prevents multiple daemon instances. Contains the PID of the running daemon process. | Plain text (PID number) |
| `heartbeat.json` | Last heartbeat. Updated every 30s by the daemon. Contains timestamp and iteration count. | JSON |
| `crash-state.json` | Circuit breaker state. Tracks consecutive crash count and timestamps. | JSON |
| `kill-switch.flag` | Kill switch. Presence of this file means the kill switch is engaged. | Flag file (contents irrelevant) |
| `cost-ledger.json` | Cost tracking ledger. Append-only JSONL entries recording every cost event. | JSONL |
| `recovery.lock` | Recovery scan lock. Prevents concurrent recovery scans. Contains PID. | Plain text (PID number) |
| `notifications.log` | Notification delivery log. | Plain text |
| `logs/daemon.log` | Daemon log. Structured JSONL with timestamp, level, pid, iteration, message. Max 50 MB with rotation. | JSONL |
| `logs/intelligence/RUN-*.log` | Production intelligence run logs. One file per observation run. | Structured log |
| `alerts/` | Alert files directory. | Directory |

### 2.2 Configuration Files

| File | Layer | Priority |
|---|---|---|
| CLI flags (`--config.key=value`) | CLI | Highest |
| `<repo>/.claude/autonomous-dev.json` | Project | High |
| `~/.claude/autonomous-dev.json` | Global | Medium |
| `<plugin>/config_defaults.json` | Built-in defaults | Lowest |

### 2.3 Request State (per-repository)

| Path | Purpose | Format |
|---|---|---|
| `.autonomous-dev/requests/<request-id>/state.json` | Request state. Schema version, status, priority, cost, phase history, metadata. | JSON (schema v1) |
| `.autonomous-dev/requests/<request-id>/events.jsonl` | Event log. Append-only log of all events for this request. | JSONL |
| `.autonomous-dev/requests/<request-id>/checkpoints/` | Recovery checkpoints. | Directory |

### 2.4 Production Intelligence

| Path | Purpose |
|---|---|
| `.autonomous-dev/observations/YYYY/MM/` | Observation reports by month |
| `.autonomous-dev/observations/.lock-<service>` | Per-service lock files (prevent concurrent observation) |

### 2.5 OS Service Files

| OS | File |
|---|---|
| macOS | `~/Library/LaunchAgents/com.autonomous-dev.daemon.plist` |
| Linux | `~/.config/systemd/user/autonomous-dev.service` |

### 2.6 Plugin Source

| Path | Purpose |
|---|---|
| `<plugin>/bin/autonomous-dev.sh` | CLI dispatcher (routes all commands) |
| `<plugin>/bin/supervisor-loop.sh` | Daemon supervisor main loop |
| `<plugin>/bin/install-daemon.sh` | OS service installer |
| `<plugin>/config_defaults.json` | Full default configuration |
| `<plugin>/config/defaults.json` | Daemon-specific defaults |
| `<plugin>/config/agent-factory.yaml` | Agent factory configuration |
| `<plugin>/agents/*.md` | Agent definition files |
| `<plugin>/phase-prompts/*.md` | Phase prompt templates |

---

## 3. CLI Commands Reference

All commands are invoked as `autonomous-dev <command> [options]`.

### 3.1 Daemon Management

#### `install-daemon [--force]`

Install the daemon as an OS service (macOS LaunchAgent or Linux systemd unit). Detects OS, finds bash 4+, templates the service configuration, sets restrictive file permissions (700 directories, 600 files).

- `--force`: Overwrite an existing daemon installation.

#### `daemon start`

Start the daemon service. Bootstraps the LaunchAgent (macOS) or starts the systemd service (Linux). Errors if not installed.

#### `daemon stop`

Stop the daemon service. Unloads the LaunchAgent (macOS) or stops the systemd service (Linux). In-flight work is saved; resumes from last known state on restart.

#### `daemon status`

Show daemon status. Reports:
- Service state (running/stopped)
- Kill switch state (engaged/disengaged)
- Circuit breaker state (OK/TRIPPED with crash count)
- Last heartbeat timestamp
- Lock file state (PID and whether alive)

### 3.2 Emergency Controls

#### `kill-switch`

Engage the kill switch. Creates `~/.autonomous-dev/kill-switch.flag`. Daemon checks every poll cycle (30s). In-flight requests are paused, not cancelled.

#### `kill-switch reset`

Disengage the kill switch. Removes the flag file. Daemon resumes on next poll.

#### `circuit-breaker reset`

Clear the crash counter and un-trip the circuit breaker. Only use after investigating and fixing the root cause.

### 3.3 Configuration

#### `config init --global|--project [--force]`

Create a starter configuration file.
- `--global`: Creates `~/.claude/autonomous-dev.json`
- `--project`: Creates `<repo-root>/.claude/autonomous-dev.json` (must be in a git repo)
- `--force`: Overwrite existing

Also creates a `.commented` reference file documenting every setting.

#### `config show [--config.key=value ...]`

Display effective merged configuration with source annotations. Merges all four layers, annotates each field with its source, redacts webhook URLs.

#### `config validate [--config.key=value ...]`

Validate the effective configuration. Runs type checks, range checks, cross-field constraints, immutability enforcement. Exits 0 if valid, 1 if errors.

### 3.4 Cost Management

#### `cost`

Show today's spend and current month summary with active request count.

#### `cost --daily`

Show per-day cost table for the current month.

#### `cost --monthly`

Show per-month cost table for the current year.

#### `cost --request REQ-X`

Show per-phase cost and turn breakdown for one request.

#### `cost --repo /path/to/repo`

Show all requests and their costs for one repository.

### 3.5 Cleanup

#### `cleanup [--dry-run] [--force] [--request REQ-X] [--config.key=value]`

Remove expired artifacts, archive old requests, reclaim disk space.
- `--dry-run`: List what would be cleaned without making changes.
- `--force`: Skip confirmation prompts.
- `--request REQ-X`: Clean up a specific request only.

Actions: archive completed requests (>30 days default), remove git worktrees, delete remote branches, rotate logs, prune observation data, remove old tarballs.

### 3.6 Agent Factory

#### `agent list`

Display table of all registered agents (name, version, role, state, expertise).

#### `agent inspect <agent-name>`

Dump full configuration, metadata, and current state for one agent.

#### `agent reload`

Full registry reload from the `agents/` directory. Use after editing agent files.

#### `agent freeze <agent-name>`

Set agent to FROZEN state. Skipped during pipeline dispatch.

#### `agent unfreeze <agent-name>`

Return frozen agent to ACTIVE state.

#### `agent metrics <agent-name>`

Display aggregate performance: approval rate, quality scores, escalation rate, token usage, anomaly alerts.

#### `agent dashboard`

Summary table of all agents sorted by approval rate with trend indicators and anomaly flags.

#### `agent rollback <agent-name> [--to-version <version>]`

Roll back an agent to a previous version. Performs impact analysis first.

#### `agent analyze <agent-name>`

Trigger improvement analysis. Examines recent performance, identifies weaknesses, generates improvement proposal.

#### `agent compare <agent-name> --current <v1> --candidate <v2>`

A/B comparison between two agent versions using blind scoring on historical inputs.

#### `agent promote <agent-name> --version <version>`

Promote a validated candidate to production. Requires human confirmation. Enters 7-day canary period.

#### `agent reject <agent-name> --version <version>`

Reject a proposed agent version. Candidate is archived, current version stays.

#### `agent accept <agent-name>`

Accept a proposed new agent from the gap detector. Moves from `data/proposed-agents/` to `agents/`.

#### `agent gaps`

List detected domain gaps where no agent has sufficient expertise.

### 3.7 Observation (Slash Command)

#### `/autonomous-dev:observe [scope] [run-id]`

Run the production intelligence observation cycle. Executes four phases:

1. **Initialize**: Generate run ID, load config, bootstrap directories, validate MCP connectivity.
2. **Triage**: Process pending triage decisions from previous runs.
3. **Service Loop**: For each service: collect metrics, scrub PII, analyze anomalies/trends, deduplicate, governance checks, generate reports.
4. **Finalize**: Write run metadata and audit log.

- `scope`: Service name or `"all"` (default: `all`)
- `run-id`: Override the run ID (for testing)

---

## 4. Diagnostic Procedures

### 4.1 Pre-Diagnostic Checklist

Before diving into a specific issue, always gather baseline system state:

```bash
# 1. Daemon status (service state, kill switch, circuit breaker, heartbeat, lock)
autonomous-dev daemon status

# 2. Cost summary (budget utilization, active requests)
autonomous-dev cost

# 3. Configuration validity
autonomous-dev config validate

# 4. Recent daemon log entries (last 20)
tail -20 ~/.autonomous-dev/logs/daemon.log | jq .

# 5. Heartbeat freshness
cat ~/.autonomous-dev/heartbeat.json | jq .

# 6. Circuit breaker state
cat ~/.autonomous-dev/crash-state.json 2>/dev/null | jq . || echo "No crash state file (good)"

# 7. Kill switch check
ls -la ~/.autonomous-dev/kill-switch.flag 2>/dev/null || echo "Kill switch not engaged (good)"
```

### 4.2 Daemon Not Starting

**Symptoms:** `daemon status` shows service not running. No heartbeat updates.

**Procedure:**

1. **Check installation:**
   ```bash
   # macOS
   ls -la ~/Library/LaunchAgents/com.autonomous-dev.daemon.plist
   # Linux
   ls -la ~/.config/systemd/user/autonomous-dev.service
   ```
   If missing, run `autonomous-dev install-daemon`.

2. **Check bash version:**
   ```bash
   bash --version
   ```
   Must be 4.0+. macOS ships with bash 3.2. Fix: `brew install bash`.

3. **Check dependencies:**
   ```bash
   which claude jq git
   ```
   All three must be in PATH.

4. **Check for stale lock:**
   ```bash
   cat ~/.autonomous-dev/daemon.lock 2>/dev/null
   ```
   If a PID is shown, check if alive: `kill -0 <pid> 2>/dev/null; echo $?` (0 = alive, 1 = dead).
   If dead, the previous daemon crashed without cleanup. Remove the lock file and retry.

5. **Check logs:**
   ```bash
   tail -50 ~/.autonomous-dev/logs/daemon.log | jq .
   ```

6. **Check OS service logs:**
   ```bash
   # macOS
   log show --predicate 'subsystem == "com.autonomous-dev"' --last 5m
   # Linux
   journalctl --user -u autonomous-dev --since "5 minutes ago"
   ```

### 4.3 Daemon Running But Not Processing

**Symptoms:** Heartbeat updating but requests are not advancing.

**Procedure:**

1. **Kill switch:**
   ```bash
   ls ~/.autonomous-dev/kill-switch.flag 2>/dev/null
   ```
   If present: `autonomous-dev kill-switch reset`

2. **Circuit breaker:**
   ```bash
   cat ~/.autonomous-dev/crash-state.json | jq .
   ```
   If tripped: investigate root cause in logs, then `autonomous-dev circuit-breaker reset`

3. **Cost budget:**
   ```bash
   autonomous-dev cost
   ```
   If remaining is zero or negative, wait for reset or increase caps.

4. **Repository allowlist:**
   ```bash
   autonomous-dev config show | jq '.config.repositories.allowlist'
   ```
   Ensure the target repository is listed.

5. **Pending escalations:**
   Check events for `escalation` events that are waiting for human response.

6. **Rate limiting:**
   Check daemon.log for rate limit backoff messages.

### 4.4 Request Stuck in a Phase

**Symptoms:** A request's status has not changed for an unexpectedly long time.

**Procedure:**

1. **Read state file:**
   ```bash
   cat .autonomous-dev/requests/<request-id>/state.json | jq '{id, status, priority, cost_accrued_usd, turn_count, current_phase_metadata, error}'
   ```

2. **Check recent events:**
   ```bash
   tail -30 .autonomous-dev/requests/<request-id>/events.jsonl | jq .
   ```

3. **Look for specific event types:**
   ```bash
   # Count retries
   cat .autonomous-dev/requests/<request-id>/events.jsonl | jq -r '.event_type' | sort | uniq -c | sort -rn

   # Find errors
   cat .autonomous-dev/requests/<request-id>/events.jsonl | jq 'select(.event_type == "error" or .event_type == "timeout" or .event_type == "retry")'
   ```

4. **Check cost for this request:**
   ```bash
   autonomous-dev cost --request <request-id>
   ```

5. **Identify root cause:**

   | Event Pattern | Likely Cause | Fix |
   |---|---|---|
   | Multiple `retry` events | Review gate keeps failing | Lower threshold or check reviewer feedback |
   | `timeout` event | Phase exceeded time budget | Increase timeout in config or simplify request |
   | `context_window_warning` | Session hit 80% context | Phase may need smaller scope |
   | `escalation` event | Waiting for human input | Respond to the escalation |
   | `error` event | Runtime error | Check error details in event payload |
   | No recent events | Daemon not processing | Check daemon status |

### 4.5 Review Gate Failures

**Symptoms:** Document repeatedly fails review, stuck in `*_review` phase.

**Procedure:**

1. **Read review events:**
   ```bash
   cat .autonomous-dev/requests/<request-id>/events.jsonl | jq 'select(.event_type == "review_fail")'
   ```
   Each event includes the score, threshold, and reviewer feedback.

2. **Check configured thresholds:**
   ```bash
   autonomous-dev config show | jq '.config.review_gates'
   ```

3. **Check iteration count:**
   ```bash
   cat .autonomous-dev/requests/<request-id>/state.json | jq '.current_phase_metadata.retry_count'
   ```
   Max iterations is `review_gates.max_iterations` (default: 3).

4. **Read the reviewer feedback** in the `review_fail` event payloads to understand what is missing.

5. **Options:**
   - Lower the threshold for this document type if it is too strict.
   - Increase `max_iterations` to give more revision attempts.
   - Manually intervene if the feedback loop is not productive.

### 4.6 Cost Budget Exceeded

**Symptoms:** Daemon stops starting new phases. Notifications about budget exceeded.

**Procedure:**

1. **Check current spend:**
   ```bash
   autonomous-dev cost
   autonomous-dev cost --daily
   ```

2. **Identify high-cost requests:**
   ```bash
   autonomous-dev cost --daily
   ```
   Look for spikes. Then drill into specific requests:
   ```bash
   autonomous-dev cost --request <request-id>
   ```

3. **Check for runaway requests** (high turn count, many retries):
   ```bash
   cat .autonomous-dev/requests/*/state.json | jq '{id, status, cost_accrued_usd, turn_count}' | sort
   ```

4. **Options:**
   - Wait for daily/monthly cap reset (UTC midnight).
   - Increase caps: edit `governance.daily_cost_cap_usd` or `governance.monthly_cost_cap_usd`.
   - Cancel expensive stuck requests: `autonomous-dev cleanup --request <request-id>`

### 4.7 Configuration Validation Failures

**Symptoms:** `config validate` reports errors. Daemon may refuse to start.

**Procedure:**

1. **Run validation:**
   ```bash
   autonomous-dev config validate
   ```
   Output shows each error with field path, constraint violated, and current value.

2. **Check source of bad value:**
   ```bash
   autonomous-dev config show | jq '.sources'
   ```
   This shows which layer (default, global, project, cli) each value came from.

3. **Common errors:**

   | Error | Cause | Fix |
   |---|---|---|
   | `range_check` on cost caps | Value < 1 or > 10000 | Set to a valid positive number |
   | Empty `repositories.allowlist` | No repos configured | Add at least one repo path |
   | Invalid `trust` level | Not 0-3 | Set to 0, 1, 2, or 3 |
   | Immutability violation | Trying to override `trust.promotion.require_human_approval` | This field is always `true` |

### 4.8 Observation Failures

**Symptoms:** Production intelligence not running or producing incomplete reports.

**Procedure:**

1. **Check MCP connectivity** -- ensure environment variables are set:
   ```bash
   echo $PROMETHEUS_URL $GRAFANA_URL $OPENSEARCH_URL $SENTRY_URL
   ```

2. **Check for stale lock files:**
   ```bash
   ls -la .autonomous-dev/observations/.lock-* 2>/dev/null
   ```
   Stale locks from crashed runs can be safely deleted.

3. **Check intelligence logs:**
   ```bash
   ls -lt ~/.autonomous-dev/logs/intelligence/ | head -5
   ```

4. **Partial data is normal:** If one MCP source is unavailable, the run continues with partial data. Only when all sources are unreachable does it abort.

---

## 5. Emergency Procedures

### 5.1 Engage Kill Switch (Stop All Processing)

**When to use:** Something is going wrong and you need to stop all work immediately.

```bash
autonomous-dev kill-switch
```

**What happens:**
- Creates `~/.autonomous-dev/kill-switch.flag`
- Daemon checks this file every poll cycle (30s default)
- In-flight requests are paused, not cancelled
- No new phases are started
- Active Claude sessions complete their current turn but no further turns are dispatched

**How to resume:**

```bash
autonomous-dev kill-switch reset
```

### 5.2 Circuit Breaker Reset

**When to use:** The daemon has stopped due to consecutive crashes (default: 3).

**Procedure:**

1. **Identify crash cause:**
   ```bash
   cat ~/.autonomous-dev/crash-state.json | jq .
   tail -100 ~/.autonomous-dev/logs/daemon.log | jq 'select(.level == "ERROR")'
   ```

2. **Fix the root cause** (config error, missing dependency, disk full, etc.)

3. **Reset the breaker:**
   ```bash
   autonomous-dev circuit-breaker reset
   ```

4. **Restart the daemon:**
   ```bash
   autonomous-dev daemon start
   ```

5. **Verify recovery:**
   ```bash
   autonomous-dev daemon status
   autonomous-dev cost
   ```

### 5.3 Full Crash Recovery

**When to use:** The system crashed and you need to restore normal operation.

**Procedure:**

1. **Assess damage:**
   ```bash
   autonomous-dev daemon status
   ```

2. **Check for stale locks:**
   ```bash
   cat ~/.autonomous-dev/daemon.lock 2>/dev/null
   cat ~/.autonomous-dev/recovery.lock 2>/dev/null
   ```
   If PIDs are dead, remove the lock files.

3. **Validate configuration:**
   ```bash
   autonomous-dev config validate
   ```

4. **Check cost ledger integrity:**
   ```bash
   autonomous-dev cost
   ```

5. **Reset circuit breaker if tripped:**
   ```bash
   autonomous-dev circuit-breaker reset
   ```

6. **Restart daemon:**
   ```bash
   autonomous-dev daemon start
   ```

7. **Verify recovery:**
   ```bash
   autonomous-dev daemon status
   # Wait 60 seconds for heartbeat
   autonomous-dev daemon status
   autonomous-dev cost
   ```

8. **Check in-flight requests:**
   The daemon performs a startup recovery scan automatically. It detects:
   - Requests in active phases that were interrupted (restores from checkpoint)
   - Corrupt state files (falls back to last valid checkpoint)
   - Orphaned git worktrees (cleans up)
   - Stale heartbeats (resets)

### 5.4 Force Stop the Daemon Process

**When to use:** The daemon is hung and not responding to kill-switch or daemon stop.

```bash
# macOS
launchctl bootout gui/$(id -u)/com.autonomous-dev.daemon

# Linux
systemctl --user stop autonomous-dev.service

# If service manager commands fail, find and kill the process
cat ~/.autonomous-dev/daemon.lock
kill <pid>
# If that does not work:
kill -9 <pid>
# Clean up
rm -f ~/.autonomous-dev/daemon.lock
```

### 5.5 Emergency Cost Override

**When to use:** Critical work needs to proceed but cost budget is exhausted.

Temporarily increase caps via CLI override (does not persist to config file):

```bash
autonomous-dev config show --config.governance.daily_cost_cap_usd=500
```

Or edit `~/.claude/autonomous-dev.json` directly to increase the cap values.

---

## 6. Maintenance Procedures

### 6.1 Routine Cleanup

Run cleanup periodically to reclaim disk space and archive completed work.

**Preview what would be cleaned:**
```bash
autonomous-dev cleanup --dry-run
```

**Run cleanup:**
```bash
autonomous-dev cleanup
```

**What cleanup does:**
- Archives completed requests older than retention period (default: 30 days)
- Removes git worktrees associated with archived requests
- Deletes remote branches for archived requests
- Rotates daemon logs
- Prunes observation data (archive after 90 days, delete after 365 days)
- Removes old request tarballs

**Custom retention:**
```bash
autonomous-dev cleanup --config.retention.completed_request_days=7
```

Auto-cleanup is triggered every 100 daemon iterations (configurable via `cleanup.auto_cleanup_interval_iterations`).

### 6.2 Cost Monitoring

**Daily check:**
```bash
autonomous-dev cost
```

**Monthly review:**
```bash
autonomous-dev cost --monthly
```

**Per-repo analysis:**
```bash
autonomous-dev cost --repo /path/to/repo
```

**Cost ledger rotation:** The cost ledger is automatically rotated monthly. Archives are retained for 12 months (configurable via `retention.cost_ledger_months`).

### 6.3 Agent Health Monitoring

**Dashboard view:**
```bash
autonomous-dev agent dashboard
```

**Key metrics to watch:**
- Approval rate below 70% triggers anomaly alert
- Escalation rate above 30% triggers anomaly alert
- Minimum 10 observations before anomaly detection activates

**If an agent is underperforming:**
1. Run analysis: `autonomous-dev agent analyze <agent-name>`
2. Review the improvement proposal
3. A/B test the proposed changes: `autonomous-dev agent compare <agent-name> --current <v1> --candidate <v2>`
4. If the candidate wins, promote it: `autonomous-dev agent promote <agent-name> --version <v2>`
5. Monitor during the 7-day canary period

**If an agent is causing problems:**
```bash
autonomous-dev agent freeze <agent-name>
```
This takes it out of rotation without deleting it.

### 6.4 Log Management

**Daemon logs:**
- Location: `~/.autonomous-dev/logs/daemon.log`
- Format: JSONL (one JSON object per line)
- Max size: 50 MB (auto-rotated)
- Retention: 30 days (configurable via `retention.daemon_log_days`)

**Query logs:**
```bash
# All errors in the last 100 lines
tail -100 ~/.autonomous-dev/logs/daemon.log | jq 'select(.level == "ERROR")'

# Entries for a specific request
cat ~/.autonomous-dev/logs/daemon.log | jq 'select(.message | contains("REQ-20260408-a3f1"))'

# Entries for a specific iteration
cat ~/.autonomous-dev/logs/daemon.log | jq 'select(.iteration == 42)'
```

**Event logs (per request):**
```bash
# All events
cat .autonomous-dev/requests/<request-id>/events.jsonl | jq .

# Specific event types
cat .autonomous-dev/requests/<request-id>/events.jsonl | jq 'select(.event_type == "error")'

# Event summary
cat .autonomous-dev/requests/<request-id>/events.jsonl | jq -r '.event_type' | sort | uniq -c | sort -rn
```

### 6.5 Configuration Validation Log

Configuration validation results are logged and retained for 7 days (configurable via `retention.config_validation_log_days`).

---

## 7. Configuration Reference

Complete reference for all 20 configuration sections. All values shown are built-in defaults.

### 7.1 `daemon`

Controls the daemon supervisor behavior.

| Key | Type | Default | Description |
|---|---|---|---|
| `poll_interval_seconds` | integer | 30 | How often the daemon checks for work |
| `heartbeat_interval_seconds` | integer | 30 | How often the daemon writes a heartbeat |
| `circuit_breaker_threshold` | integer | 3 | Consecutive crashes before tripping the breaker |
| `log_retention_days` | integer | 30 | How long to keep daemon logs |
| `idle_backoff_base_seconds` | integer | 30 | Starting backoff interval when idle |
| `idle_backoff_max_seconds` | integer | 900 | Maximum backoff interval (15 minutes) |
| `max_turns_by_phase` | object | (see below) | Maximum Claude CLI turns per phase |

**`max_turns_by_phase` defaults:**

| Phase | Max Turns |
|---|---|
| intake | 10 |
| prd | 50 |
| prd_review | 30 |
| tdd | 50 |
| tdd_review | 30 |
| plan | 50 |
| plan_review | 30 |
| spec | 50 |
| spec_review | 30 |
| code | 200 |
| code_review | 50 |
| integration | 100 |
| deploy | 30 |

### 7.2 `state_machine`

Controls pipeline phase lifecycle.

| Key | Type | Default | Description |
|---|---|---|---|
| `retry_limits_by_phase` | object | (see below) | Max retries per phase before escalation |
| `timeouts_by_phase` | object | (see below) | Time budget per phase |
| `context_window_threshold_pct` | integer | 80 | Context window percentage that triggers a warning |

**`retry_limits_by_phase` defaults:** intake:1, prd:2, prd_review:3, tdd:2, tdd_review:3, plan:2, plan_review:3, spec:2, spec_review:3, code:3, code_review:3, integration:2, deploy:2

**`timeouts_by_phase` defaults:** intake:5m, prd:30m, prd_review:20m, tdd:45m, tdd_review:20m, plan:30m, plan_review:20m, spec:45m, spec_review:20m, code:120m, code_review:30m, integration:60m, deploy:30m

### 7.3 `governance`

Cost and concurrency limits.

| Key | Type | Default | Range | Description |
|---|---|---|---|---|
| `daily_cost_cap_usd` | number | 100.00 | 1-10000 | Max daily spend (UTC) |
| `monthly_cost_cap_usd` | number | 2000.00 | 1-10000 | Max monthly spend (UTC) |
| `per_request_cost_cap_usd` | number | 50.00 | 1-10000 | Max spend per request |
| `max_concurrent_requests` | integer | 3 | 1-20 | Max requests processed simultaneously |
| `disk_usage_limit_gb` | number | 10.0 | 1-100 | Max disk usage for autonomous-dev data |
| `rate_limit_backoff_base_seconds` | integer | 30 | -- | Initial backoff on API rate limit |
| `rate_limit_backoff_max_seconds` | integer | 900 | -- | Maximum backoff on API rate limit |

### 7.4 `repositories`

Repository access control.

| Key | Type | Default | Description |
|---|---|---|---|
| `allowlist` | array of strings | `[]` | Absolute paths to allowed repositories |
| `overrides` | object | `{}` | Per-repository configuration overrides |

### 7.5 `trust`

Trust level management.

| Key | Type | Default | Description |
|---|---|---|---|
| `system_default_level` | integer | 1 | Default trust level for new repositories (0-3) |
| `repositories` | object | `{}` | Per-repo trust levels, e.g., `{"/path": {"default_level": 2}}` |
| `promotion.enabled` | boolean | true | Allow automatic trust promotion |
| `promotion.min_consecutive_successes` | integer | 20 | Successes needed before promotion eligibility |
| `promotion.require_human_approval` | boolean | true | **Immutable.** Always true. Cannot be overridden. |

### 7.6 `escalation`

Human escalation routing.

| Key | Type | Default | Description |
|---|---|---|---|
| `routing.mode` | string | `"default"` | `"default"` or `"advanced"` |
| `routing.default_target` | string | `"pm-lead"` | Default escalation target |
| `routing.advanced` | object | (category map) | Per-category routing with primary, secondary, timeout |
| `timeout_behavior.default` | string | `"pause"` | Action when escalation times out |
| `retry_limits.quality_gate_max_iterations` | integer | 3 | Max quality gate retries before escalation |
| `retry_limits.technical_max_approaches` | integer | 3 | Max technical approaches before escalation |
| `verbosity.default` | string | `"standard"` | Escalation message verbosity |

**Advanced routing categories:** product, technical, infrastructure, security, cost, quality. Each has `primary`, `secondary` (optional), and `timeout_minutes`.

### 7.7 `notifications`

Notification delivery and batching.

| Key | Type | Default | Description |
|---|---|---|---|
| `delivery.default_method` | string | `"cli"` | `"cli"`, `"discord"`, `"slack"`, `"file"` |
| `delivery.overrides` | object | `{}` | Per-type method overrides |
| `delivery.channels` | array | `[{type:"file", path:"~/.autonomous-dev/notifications.log"}]` | Output channels |
| `delivery.discord.webhook_url` | string | null | Discord webhook URL |
| `delivery.discord.channel_id` | string | null | Discord channel ID |
| `delivery.slack.webhook_url` | string | null | Slack webhook URL |
| `delivery.slack.channel` | string | null | Slack channel name |
| `batching.enabled` | boolean | true | Batch non-urgent notifications |
| `batching.interval_minutes` | integer | 60 | Batch interval |
| `batching.exempt_types` | array | `["escalation", "error"]` | Types that skip batching |
| `dnd.enabled` | boolean | false | Do-not-disturb mode |
| `dnd.start` | string | `"22:00"` | DND start time |
| `dnd.end` | string | `"07:00"` | DND end time |
| `dnd.timezone` | string | `"America/New_York"` | DND timezone |
| `dnd.breakthrough_urgency` | array | `["immediate"]` | Urgency levels that break through DND |
| `fatigue.enabled` | boolean | true | Notification fatigue detection |
| `fatigue.threshold_per_hour` | integer | 20 | Max notifications per hour before digest mode |
| `fatigue.digest_cooldown_minutes` | integer | 30 | Cooldown between digest deliveries |
| `cross_request.enabled` | boolean | true | Cross-request systemic failure detection |
| `cross_request.failure_window_minutes` | integer | 60 | Window for correlating failures |
| `cross_request.failure_threshold` | integer | 3 | Failures within window to trigger alert |
| `summary_schedule` | string | `"daily"` | Summary notification frequency |
| `daily_digest_time` | string | `"09:00"` | Time to send daily digest |

### 7.8 `review_gates`

Review scoring and quality thresholds.

| Key | Type | Default | Description |
|---|---|---|---|
| `default_threshold` | integer | 85 | Default minimum score to pass review |
| `thresholds_by_type` | object | PRD:85, TDD:85, Plan:80, Spec:80, Code:85 | Per-document-type thresholds |
| `max_iterations` | integer | 3 | Max revision attempts before escalation |
| `panel_size` | object | PRD:2, TDD:2, Plan:1, Spec:1, Code:2 | Number of reviewers per type |
| `score_aggregation` | string | `"mean"` | How to aggregate panel scores |
| `disagreement_threshold` | integer | 15 | Point spread triggering human escalation |

### 7.9 `decomposition`

Request decomposition (parent/child pipeline trees).

| Key | Type | Default | Description |
|---|---|---|---|
| `max_children_per_parent` | integer | 10 | Max child requests per parent |
| `max_pipeline_depth` | integer | 4 | Max nesting depth |
| `max_total_nodes` | integer | 100 | Max total nodes in the decomposition tree |
| `explosion_alert_threshold` | integer | 75 | Node count that triggers an alert |

### 7.10 `versioning`

Document versioning controls.

| Key | Type | Default | Description |
|---|---|---|---|
| `quality_regression_margin` | integer | 5 | Maximum quality score drop allowed between versions |

### 7.11 `backward_cascade`

Backward cascade when later phases invalidate earlier documents.

| Key | Type | Default | Description |
|---|---|---|---|
| `max_depth` | integer | 2 | How many phases back a cascade can propagate |
| `require_human_confirmation` | boolean | false | Whether cascades need human approval |

### 7.12 `parallel`

Parallel execution via git worktrees.

| Key | Type | Default | Description |
|---|---|---|---|
| `max_worktrees` | integer | 5 | Max concurrent git worktrees |
| `max_tracks` | integer | 3 | Max parallel execution tracks |
| `disk_warning_threshold_gb` | number | 2.0 | Disk space warning level |
| `disk_hard_limit_gb` | number | 5.0 | Disk space hard limit (blocks new worktrees) |
| `stall_timeout_minutes` | integer | 15 | Worktree stall timeout |
| `agent_turn_budget` | object | small:30, medium:60, large:120 | Turn budgets by task size |
| `conflict_ai_confidence_threshold` | number | 0.85 | AI confidence needed to auto-resolve merge conflicts |
| `worktree_cleanup_delay_seconds` | integer | 300 | Delay before cleaning up completed worktrees |

### 7.13 `pipeline_control`

Pipeline-level settings.

| Key | Type | Default | Description |
|---|---|---|---|
| `default_priority` | string | `"normal"` | Default request priority |
| `max_concurrent_pipelines` | integer | 5 | Max pipelines running at once |

### 7.14 `agents`

Agent Factory settings.

| Key | Type | Default | Description |
|---|---|---|---|
| `anomaly_detection.approval_rate_threshold` | number | 0.70 | Approval rate below this triggers alert |
| `anomaly_detection.escalation_rate_threshold` | number | 0.30 | Escalation rate above this triggers alert |
| `anomaly_detection.observation_threshold` | integer | 10 | Min observations before anomaly detection activates |
| `modification_rate_limits.max_new_agents_per_week` | integer | 1 | Max new agents created per week |
| `modification_rate_limits.max_modifications_per_agent_per_week` | integer | 1 | Max modifications per agent per week |
| `canary_period_days` | integer | 7 | Days a promoted agent runs in canary mode |

### 7.15 `production_intelligence`

Production monitoring and observation.

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | true | Whether production intelligence is active |
| `schedule` | string | `"0 */4 * * *"` | Cron schedule for observation runs |
| `error_detection.default_error_rate_percent` | number | 5.0 | Error rate threshold |
| `error_detection.default_sustained_duration_min` | integer | 10 | Duration errors must sustain to trigger |
| `anomaly_detection.method` | string | `"z_score"` | Anomaly detection algorithm |
| `anomaly_detection.sensitivity` | number | 2.5 | Z-score sensitivity threshold |
| `anomaly_detection.baseline_window_days` | integer | 14 | Days of baseline data for comparison |
| `trend_analysis.enabled` | boolean | true | Enable trend analysis |
| `trend_analysis.windows` | array | [7, 14, 30] | Analysis window sizes in days |
| `trend_analysis.min_slope_threshold` | number | 0.05 | Minimum slope to report a trend |
| `governance.cooldown_days` | integer | 7 | Days after a fix before another fix PRD for same issue |
| `governance.oscillation_threshold` | integer | 3 | Fix-revert cycles before blocking |
| `governance.oscillation_window_days` | integer | 30 | Window for oscillation detection |
| `governance.effectiveness_comparison_days` | integer | 7 | Days to compare fix effectiveness |
| `governance.effectiveness_improvement_threshold` | number | 0.10 | Minimum improvement to consider fix effective |

### 7.16 `intake`

Request intake system.

| Key | Type | Default | Description |
|---|---|---|---|
| `max_queue_depth` | integer | 50 | Max pending requests in queue |
| `starvation_threshold_hours` | integer | 48 | Hours before low-priority request triggers starvation alert |
| `duplicate_similarity_threshold` | number | 0.85 | Similarity score for duplicate detection |
| `max_clarifying_rounds` | integer | 5 | Max back-and-forth rounds for clarification |
| `response_timeout_minutes` | integer | 240 | Timeout waiting for user response to clarification |
| `response_timeout_action` | string | `"pause"` | Action on timeout: `"pause"` or `"cancel"` |
| `rate_limits.submissions_per_hour` | integer | 10 | Max new submissions per hour |
| `rate_limits.queries_per_minute` | integer | 60 | Max status queries per minute |

### 7.17 `cleanup`

Automatic cleanup settings.

| Key | Type | Default | Description |
|---|---|---|---|
| `auto_cleanup_interval_iterations` | integer | 100 | Run cleanup every N daemon iterations |
| `delete_remote_branches` | boolean | true | Delete remote branches for archived requests |

### 7.18 `retention`

Data retention periods.

| Key | Type | Default | Description |
|---|---|---|---|
| `completed_request_days` | integer | 30 | Days to keep completed requests before archival |
| `event_log_days` | integer | 90 | Days to keep event logs |
| `cost_ledger_months` | integer | 12 | Months to keep cost ledger archives |
| `daemon_log_days` | integer | 30 | Days to keep daemon logs |
| `observation_report_days` | integer | 90 | Days to keep observation reports before archival |
| `observation_archive_days` | integer | 365 | Days to keep archived observations |
| `archive_days` | integer | 365 | Days to keep archived requests |
| `config_validation_log_days` | integer | 7 | Days to keep config validation logs |

### 7.19 `audit`

Audit trail settings.

| Key | Type | Default | Description |
|---|---|---|---|
| `integrity.hash_chain_enabled` | boolean | false | Enable hash chain integrity verification on event logs |

### 7.20 `emergency`

Emergency control settings.

| Key | Type | Default | Description |
|---|---|---|---|
| `kill_default_mode` | string | `"graceful"` | Kill switch mode: `"graceful"` (wait for current turn) or `"immediate"` |
| `restart_requires_human` | boolean | true | Whether daemon restart after emergency requires human confirmation |

---

## 8. State File Schema Reference

### 8.1 `state.json` Fields

| Field | Type | Description |
|---|---|---|
| `schema_version` | integer | Always `1` |
| `id` | string | Request ID. Format: `REQ-YYYYMMDD-XXXX` (4 hex chars) |
| `status` | string | Current phase or meta-state |
| `priority` | string | `low`, `normal`, `high`, `critical` |
| `title` | string | Human-readable request title |
| `repository` | string | Absolute path to target repository |
| `branch` | string | Git branch name for this request |
| `created_at` | string | ISO 8601 creation timestamp |
| `updated_at` | string | ISO 8601 last update timestamp |
| `cost_accrued_usd` | number | Total cost for this request |
| `turn_count` | integer | Total turns across all phases |
| `escalation_count` | integer | Number of times escalated to human |
| `blocked_by` | array | Dependency request IDs (empty if not blocked) |
| `phase_history` | array | Ordered list of phase transition records |
| `current_phase_metadata` | object | Current phase retry count, last error, session info |
| `error` | object/null | Last error details (null if no error) |
| `last_checkpoint` | object/null | Recovery checkpoint data |

### 8.2 Valid Statuses

**Pipeline order:** `intake`, `prd`, `prd_review`, `tdd`, `tdd_review`, `plan`, `plan_review`, `spec`, `spec_review`, `code`, `code_review`, `integration`, `deploy`, `monitor`

**Meta-states:** `paused`, `failed`, `cancelled`

### 8.3 Event Types (25 total)

| Event Type | Description |
|---|---|
| `request_created` | New request entered the system |
| `state_transition` | Request moved from one status to another |
| `phase_started` | A pipeline phase began execution |
| `phase_completed` | A pipeline phase finished successfully |
| `review_pass` | Document passed review gate |
| `review_fail` | Document failed review gate (includes score and feedback) |
| `retry` | Phase is being retried after failure |
| `timeout` | Phase exceeded its time budget |
| `error` | Runtime error occurred |
| `paused` | Request was paused (human action or system) |
| `resumed` | Request was resumed after pause |
| `failed` | Request failed terminally |
| `cancelled` | Request was cancelled |
| `escalation` | Issue escalated to human |
| `checkpoint_created` | Recovery checkpoint was saved |
| `checkpoint_restored` | State was restored from checkpoint |
| `cost_update` | Cost was recorded for a session |
| `context_window_warning` | Session hit 80% context window |
| `dependency_resolved` | A blocking dependency was resolved |
| `dependency_blocked` | Request is blocked by a dependency |
| `session_started` | Claude CLI session started |
| `session_ended` | Claude CLI session ended |
| `artifact_created` | Document or code artifact was produced |
| `pr_created` | Pull request was created |
| `pr_merged` | Pull request was merged |
| `cleanup_started` | Cleanup process began |
| `cleanup_completed` | Cleanup process finished |

### 8.4 Event Schema

Each event in `events.jsonl` is a JSON object with these required fields:

| Field | Type | Description |
|---|---|---|
| `timestamp` | string | ISO 8601 timestamp |
| `event_type` | string | One of the 25 valid types |
| `request_id` | string | Request ID (format: `REQ-YYYYMMDD-XXXX`) |
| `session_id` | string | Session identifier |

Additional fields vary by event type (e.g., `review_fail` includes `score`, `threshold`, and `feedback`).

---

## 9. Quick Reference Card

### Most-Used Commands

| Task | Command |
|---|---|
| Check system health | `autonomous-dev daemon status` |
| View cost summary | `autonomous-dev cost` |
| Stop everything | `autonomous-dev kill-switch` |
| Resume after stop | `autonomous-dev kill-switch reset` |
| Reset after crashes | `autonomous-dev circuit-breaker reset` |
| Validate config | `autonomous-dev config validate` |
| View effective config | `autonomous-dev config show` |
| Clean up old data | `autonomous-dev cleanup --dry-run` |
| Agent health | `autonomous-dev agent dashboard` |

### Key File Checks

| Check | Command |
|---|---|
| Heartbeat age | `cat ~/.autonomous-dev/heartbeat.json \| jq .` |
| Crash state | `cat ~/.autonomous-dev/crash-state.json \| jq .` |
| Kill switch | `ls ~/.autonomous-dev/kill-switch.flag` |
| Lock holder | `cat ~/.autonomous-dev/daemon.lock` |
| Request state | `cat .autonomous-dev/requests/<id>/state.json \| jq .` |
| Recent events | `tail -20 .autonomous-dev/requests/<id>/events.jsonl \| jq .` |
| Daemon errors | `tail -50 ~/.autonomous-dev/logs/daemon.log \| jq 'select(.level == "ERROR")'` |
| Allowlist | `autonomous-dev config show \| jq '.config.repositories.allowlist'` |
