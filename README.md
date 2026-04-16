# autonomous-dev

**Autonomous AI development system for Claude Code.**

A continuously-running, self-improving development pipeline that receives product requests, decomposes them through PRD > TDD > Plan > Spec > Code, reviews its own work at every gate, tests everything, monitors production, and generates its own improvement PRDs.

| | |
|---|---|
| **Version** | 0.1.0 |
| **License** | MIT |
| **Platform** | Claude Code plugin |
| **Files** | 781+ source files |
| **Lines** | ~227K lines of code |
| **Language** | TypeScript + Bash |

---

## Table of Contents

1. [What Is This?](#what-is-this)
2. [Why Would I Use This?](#why-would-i-use-this)
3. [Quick Start](#quick-start)
4. [Core Concepts](#core-concepts)
5. [Commands Reference](#commands-reference)
6. [Configuration Guide](#configuration-guide)
7. [Usage Examples](#usage-examples)
8. [Architecture Overview](#architecture-overview)
9. [Security and Safety](#security-and-safety)
10. [Troubleshooting](#troubleshooting)
11. [Project Structure](#project-structure)
12. [Contributing](#contributing)

---

## What Is This?

Imagine you could describe a feature you want built -- in plain English, through Discord, Slack, or the Claude App -- and an AI system would take it from idea to deployed code without you managing each step. That is what autonomous-dev does.

It is a Claude Code plugin that runs as a background daemon on your machine (or server). You tell it what you want. It figures out the how, writes the documents, writes the code, reviews everything, runs the tests, and ships it. When something breaks in production, it detects the problem and writes a fix request for itself.

You stay in control. The system asks for your approval at key checkpoints (you choose how many), and you can hit a kill switch at any time to stop everything.

Here is the flow:

```
   You (human)
     |
     |  "Build a REST API for user profiles"
     v
 +------------------+
 |   Intake          |  <-- Claude App / Discord / Slack
 +------------------+
     |
     v
 +------------------+
 |   PRD Author      |  Writes a Product Requirements Document
 +------------------+
     |  review gate (score >= 85?)
     v
 +------------------+
 |   TDD Author      |  Writes a Technical Design Document
 +------------------+
     |  review gate (score >= 85?)
     v
 +------------------+
 |   Plan Author     |  Creates an implementation plan
 +------------------+
     |  review gate (score >= 80?)
     v
 +------------------+
 |   Spec Author     |  Writes detailed implementation specs
 +------------------+
     |  review gate (score >= 80?)
     v
 +------------------+
 |   Code Executor   |  Writes and tests the code
 +------------------+
     |  review gate (score >= 85?)
     v
 +------------------+
 |   Deploy          |  Ships to production
 +------------------+
     |
     v
 +------------------+
 |   Observe         |  Monitors Prometheus, Grafana, Sentry, OpenSearch
 +------------------+
     |
     |  error detected? --> generates a new PRD --> loop restarts
     v
   Done (until the next observation finds something)
```

The system reviews its own work at every transition. If a document scores below the threshold, it gets sent back for revision -- up to three times -- before escalating to a human.

---

## Why Would I Use This?

### Pain points it addresses

- **Context switching kills productivity.** You should not have to manage every step of a straightforward feature. Describe the outcome and let the system handle the mechanics.
- **Solo developers wear too many hats.** This acts as your document writer, code reviewer, test runner, and production monitor -- all at once.
- **Small teams move slower than they should.** Review bottlenecks, forgotten tests, and undocumented designs slow delivery. Autonomous-dev enforces a full pipeline for every change.
- **Homelab projects rot without monitoring.** The production intelligence loop watches your services and creates fix requests automatically.

### Who benefits

- **Solo developers** who want a rigorous pipeline without a team to run it.
- **Small teams** who want to scale their output without scaling their headcount.
- **Homelab operators** who want their services monitored and auto-fixed.

### What it does vs. what it does not do

| It does | It does not |
|---------|-------------|
| Write PRDs, TDDs, plans, specs, and code | Replace your product judgment |
| Review documents and code with scoring rubrics | Make business decisions for you |
| Run tests and validate before deployment | Guarantee bug-free code |
| Monitor production and detect errors | Manage your infrastructure |
| Escalate to humans when stuck | Override human decisions |

> **Important:** This is a power tool, not a replacement for thinking. It handles the mechanical work so you can focus on the decisions that matter.

---

## Quick Start

Estimated time: 5 minutes.

### Prerequisites

| Requirement | Minimum | Check |
|---|---|---|
| Claude Code | Latest | `claude --version` |
| Bash | 4.0+ | `bash --version` |
| jq | 1.6+ | `jq --version` |
| git | 2.20+ | `git --version` |

> **Tip (macOS users):** The default macOS bash is version 3. Install bash 4+ with `brew install bash`.

### Step 1: Install the plugin

Clone the homelab repository and ensure the plugin is registered with Claude Code:

```bash
cd ~/codebase
git clone https://github.com/pwatson/claude-code-homelab.git
cd claude-code-homelab/plugins/autonomous-dev
```

### Step 2: Initialize configuration

```bash
autonomous-dev config init --global
```

This creates `~/.claude/autonomous-dev.json` with sensible defaults and a companion `.commented` reference file documenting every setting.

### Step 3: Add your repository to the allowlist

Edit `~/.claude/autonomous-dev.json`:

```json
{
  "governance": {
    "daily_cost_cap_usd": 100.00,
    "monthly_cost_cap_usd": 2000.00,
    "per_request_cost_cap_usd": 50.00,
    "max_concurrent_requests": 3
  },
  "repositories": {
    "allowlist": [
      "/Users/you/projects/my-app"
    ]
  }
}
```

### Step 4: Install and start the daemon

```bash
autonomous-dev install-daemon
autonomous-dev daemon start
autonomous-dev daemon status
```

You should see:

```
=== autonomous-dev daemon status ===

Service: running (macOS/launchd)
Kill switch: disengaged
Circuit breaker: OK (no crash state)
Last heartbeat: 2026-04-08T14:30:00Z
Lock: held by PID 12345 (alive)
```

### Step 5: Submit your first request

From Claude Code (or Discord/Slack once configured), describe what you want built:

```
Build a /health endpoint for my Express app that returns
{ "status": "ok", "uptime": <seconds> }
```

The daemon picks it up and starts the pipeline: intake, PRD, review, TDD, review, plan, review, spec, review, code, review, deploy.

Watch progress:

```bash
autonomous-dev cost
```

> **Tip:** Start with trust level 0 (the default for new repos). This means every gate asks for your approval, so you can see exactly what the system is doing before granting it more autonomy.

---

## Core Concepts

### The Document Pipeline (PRD > TDD > Plan > Spec > Code)

Every request flows through five phases, each producing a concrete artifact. First, a Product Requirements Document defines what to build and why. Then a Technical Design Document defines how to build it. The Plan breaks the TDD into ordered tasks. The Spec adds implementation-level detail to each task. Finally, Code is written, tested, and committed. No phase is skipped. Each artifact is versioned and stored.

### Review Gates

Between every phase, a panel of reviewer agents scores the output against a rubric. Each document type has a minimum threshold (PRD: 85, TDD: 85, Plan: 80, Spec: 80, Code: 85 -- all configurable). If the score falls below the threshold, the document is sent back with specific feedback for revision. After three failed iterations, the system escalates to a human. Scoring uses blind evaluation to prevent anchoring bias, and a disagreement detector flags cases where reviewers diverge significantly.

### Trust Levels (L0-L3)

Trust levels control how much human approval the system needs. At L0 (paranoid), every gate -- PRD, code, test, deploy, security, cost, quality -- requires human sign-off. At L1, test review and quality gates become automated. At L2, PRD approval and cost approval also automate. At L3, nearly everything is automated except security review, which always requires a human. You can set trust per-repository and promote gradually as you build confidence.

| Gate | L0 | L1 | L2 | L3 |
|---|---|---|---|---|
| PRD approval | human | human | system | system |
| Code review | human | human | human | system |
| Test review | human | system | system | system |
| Deploy approval | human | human | human | system |
| Security review | human | human | human | human |
| Cost approval | human | human | system | system |
| Quality gate | human | system | system | system |

> **Warning:** Security review is always human-controlled. This is enforced programmatically and cannot be overridden by configuration.

### The Daemon

The daemon is a long-running background process that polls for work every 30 seconds. It is installed as a macOS LaunchAgent or Linux systemd user service, so it survives reboots and logouts. It manages the lifecycle of every request: picking up new submissions, dispatching Claude CLI sessions for each phase, tracking state, handling retries, and enforcing cost budgets. It includes a circuit breaker (trips after 3 consecutive crashes), idle backoff (scales from 30s to 15min when there is no work), and structured JSONL logging.

### Agent Factory

The system ships with 13 specialist agents (prd-author, tdd-author, plan-author, spec-author, code-executor, test-executor, deploy-executor, and six reviewers). The Agent Factory is a self-improvement subsystem that monitors each agent's performance metrics (approval rate, quality scores, escalation rate, token usage). When performance degrades, it generates improvement proposals, A/B tests the proposed changes against the current version using blind scoring, and promotes winners through a canary period. Humans always approve new agents and promotions. Rate limits prevent runaway modifications: at most 1 new agent and 1 modification per agent per week.

---

## Commands Reference

All commands are invoked as `autonomous-dev <command> [options]`.

### `install-daemon`

Install the daemon as an OS service (macOS LaunchAgent or Linux systemd unit).

```bash
autonomous-dev install-daemon [--force]
```

| Option | Description |
|---|---|
| `--force` | Overwrite an existing daemon installation |

**What it does:** Detects your OS, finds bash 4+, templates the appropriate service configuration, sets restrictive file permissions (700 on directories, 600 on files), and starts the service.

**Example:**

```bash
# First install
autonomous-dev install-daemon

# Reinstall after updating the plugin
autonomous-dev install-daemon --force
```

---

### `daemon start`

Start the daemon service.

```bash
autonomous-dev daemon start
```

**What it does:** Bootstraps the LaunchAgent (macOS) or starts the systemd service (Linux). Errors if the daemon has not been installed yet.

**Example:**

```bash
autonomous-dev daemon start
# Daemon started (macOS/launchd).
```

---

### `daemon stop`

Stop the daemon service.

```bash
autonomous-dev daemon stop
```

**What it does:** Unloads the LaunchAgent (macOS) or stops the systemd service (Linux). In-flight work is saved; the daemon resumes from the last known state when restarted.

**Example:**

```bash
autonomous-dev daemon stop
# Daemon stopped (macOS/launchd).
```

---

### `daemon status`

Show the current daemon status.

```bash
autonomous-dev daemon status
```

**What it does:** Reports service state, kill switch status, circuit breaker status, last heartbeat timestamp, and lock file state.

**Example output:**

```
=== autonomous-dev daemon status ===

Service: running (macOS/launchd)
Kill switch: disengaged
Circuit breaker: OK (0 consecutive crashes)
Last heartbeat: 2026-04-08T14:30:00Z
Lock: held by PID 12345 (alive)
```

---

### `kill-switch`

Immediately stop all daemon processing.

```bash
autonomous-dev kill-switch
```

**What it does:** Creates a kill-switch flag file that the daemon checks on every iteration. When engaged, the daemon halts all work. In-flight requests are paused, not cancelled.

**Example:**

```bash
autonomous-dev kill-switch
# Kill switch ENGAGED at 2026-04-08T14:35:00Z.
# All daemon processing will halt.
# To resume, run: autonomous-dev kill-switch reset
```

---

### `kill-switch reset`

Resume daemon processing after a kill switch.

```bash
autonomous-dev kill-switch reset
```

**What it does:** Removes the kill-switch flag file. The daemon resumes processing on its next poll iteration.

**Example:**

```bash
autonomous-dev kill-switch reset
# Kill switch disengaged. Daemon will resume processing on next iteration.
```

---

### `circuit-breaker reset`

Reset the circuit breaker after consecutive crashes.

```bash
autonomous-dev circuit-breaker reset
```

**What it does:** Clears the crash counter and un-trips the circuit breaker. The daemon resumes normal operation on its next iteration. Use this after investigating and fixing the root cause of repeated failures.

**Example:**

```bash
autonomous-dev circuit-breaker reset
# Circuit breaker reset. Was tripped; now cleared.
# Daemon will resume normal operation on next iteration.
```

---

### `config init`

Create a starter configuration file.

```bash
autonomous-dev config init --global [--force]
autonomous-dev config init --project [--force]
```

| Option | Description |
|---|---|
| `--global` | Create at `~/.claude/autonomous-dev.json` |
| `--project` | Create at `<repo-root>/.claude/autonomous-dev.json` |
| `--force` | Overwrite an existing config file |

**What it does:** Generates a minimal JSON configuration file and a companion `.commented` reference file that documents every available setting with types, ranges, and defaults.

**Example:**

```bash
# Create global config
autonomous-dev config init --global

# Create project-level override (must be in a git repo)
cd /path/to/my-project
autonomous-dev config init --project
```

---

### `config show`

Display the effective merged configuration with source annotations.

```bash
autonomous-dev config show [--config.key=value ...]
```

**What it does:** Merges all four configuration layers (built-in defaults, global, project, CLI overrides), annotates each field with its source layer, redacts webhook URLs, and outputs the result as JSON.

**Example:**

```bash
# Show effective config
autonomous-dev config show

# Show with a CLI override
autonomous-dev config show --config.governance.daily_cost_cap_usd=200
```

**Output format:**

```json
{
  "config": { "governance": { "daily_cost_cap_usd": 200.00, "..." : "..." } },
  "sources": { "governance.daily_cost_cap_usd": "cli", "..." : "default" }
}
```

---

### `config validate`

Validate the effective configuration.

```bash
autonomous-dev config validate [--config.key=value ...]
```

**What it does:** Loads and merges all config layers, then runs the full validation pipeline (type checks, range checks, cross-field constraints, immutability enforcement). Exits 0 if valid, exits 1 if any errors are found. Warnings alone do not cause a non-zero exit.

**Example:**

```bash
autonomous-dev config validate
# PASS: Configuration is valid.

autonomous-dev config validate --config.governance.daily_cost_cap_usd=-5
# FAIL: Configuration has 1 error(s) and 0 warning(s).
#
#   ERROR [range_check] governance.daily_cost_cap_usd
#     Must be between 1 and 10000 (got: -5)
#     Source: cli
```

---

### `cost`

View cost reports and spending breakdowns.

```bash
autonomous-dev cost                        # Today + current month summary
autonomous-dev cost --daily                # Daily breakdown for current month
autonomous-dev cost --monthly              # Monthly breakdown for current year
autonomous-dev cost --request REQ-X        # Per-request per-phase breakdown
autonomous-dev cost --repo /path/to/repo   # Per-repo breakdown
```

| Option | Description |
|---|---|
| `--daily` | Show per-day cost table for the current month |
| `--monthly` | Show per-month cost table for the current year |
| `--request REQ-X` | Show per-phase cost and turn breakdown for one request |
| `--repo /path` | Show all requests and their costs for one repository |

**Example (default):**

```
Cost Summary (2026-04-08)
=========================

Today:
  Spent:     $12.34
  Cap:       $100.00
  Remaining: $87.66

This Month (April 2026):
  Spent:     $156.78
  Cap:       $2,000.00
  Remaining: $1,843.22

Active Requests: 2
```

**Example (per-request):**

```bash
autonomous-dev cost --request REQ-20260408-a3f1
```

```
Request: REQ-20260408-a3f1
Repository: /Users/you/projects/my-app
Status: in_progress
Total Cost: $8.45

Phase Breakdown:
  Phase       | Sessions |   Cost  | Turns
  ------------|----------|---------|------
  intake      |        1 | $0.12   |     3
  prd         |        1 | $1.85   |    22
  prd_review  |        1 | $0.45   |     8
  tdd         |        1 | $2.34   |    31
  tdd_review  |        1 | $0.56   |     9
  plan        |        1 | $1.23   |    18
  plan_review |        1 | $0.34   |     7
  spec        |        1 | $1.56   |    24
  ------------|----------|---------|------
  Total       |        8 | $8.45   |   122
```

---

### `cleanup`

Remove expired artifacts, archive old requests, and reclaim disk space.

```bash
autonomous-dev cleanup [--dry-run] [--force] [--request REQ-X]
```

| Option | Description |
|---|---|
| `--dry-run` | List what would be cleaned up without making changes |
| `--force` | Skip confirmation prompts |
| `--request REQ-X` | Clean up a specific request only |
| `--config.key=value` | Override retention settings for this run |

**What it does:** Archives completed requests older than the retention period (default: 30 days), removes git worktrees, deletes remote branches, rotates logs, prunes observation data, and removes old tarballs.

**Example:**

```bash
# Preview what would be cleaned up
autonomous-dev cleanup --dry-run

# Run cleanup with custom retention
autonomous-dev cleanup --config.retention.completed_request_days=7
```

**Output:**

```
=== Cleanup Summary ===
Requests archived:        3
State dirs deleted:        3
Worktrees removed:         2
Remote branches deleted:   2
Observations archived:     15
Observations deleted:      5
Logs deleted:              12
Ledger archives pruned:    1
Request tarballs pruned:   2
Errors:                    0
Elapsed:                   4s
```

---

### `agent` (subcommands)

Manage the Agent Factory and all registered agents.

#### `agent list`

```bash
autonomous-dev agent list
```

Display a table of all registered agents with name, version, role, state, and expertise.

```
NAME                  VERSION  ROLE      STATE    EXPERTISE
architecture-reviewer 1.0.0    reviewer  ACTIVE   architecture, design-patterns
code-executor         1.0.0    author    ACTIVE   implementation, testing
prd-author            1.0.0    author    ACTIVE   product-requirements, user-stories
...
```

#### `agent inspect`

```bash
autonomous-dev agent inspect <agent-name>
```

Dump the full configuration, metadata, and current state for a single agent.

#### `agent reload`

```bash
autonomous-dev agent reload
```

Trigger a full registry reload from the `agents/` directory. Use after manually editing agent definition files.

#### `agent freeze`

```bash
autonomous-dev agent freeze <agent-name>
```

Set an agent's state to FROZEN. A frozen agent is skipped during pipeline dispatch. Use this to take a misbehaving agent out of rotation without deleting it.

#### `agent unfreeze`

```bash
autonomous-dev agent unfreeze <agent-name>
```

Return a frozen agent to ACTIVE state.

#### `agent metrics`

```bash
autonomous-dev agent metrics <agent-name>
```

Display aggregate performance metrics for an agent: approval rate, average quality score, escalation rate, token usage trends, and any active anomaly alerts.

#### `agent dashboard`

```bash
autonomous-dev agent dashboard
```

Show a summary table of all agents sorted by approval rate, with trend indicators and anomaly flags.

#### `agent rollback`

```bash
autonomous-dev agent rollback <agent-name> [--to-version <version>]
```

Roll back an agent to a previous version. Performs an impact analysis before executing.

#### `agent analyze`

```bash
autonomous-dev agent analyze <agent-name>
```

Trigger an improvement analysis cycle. Examines recent performance data, identifies weaknesses, and generates an improvement proposal.

#### `agent compare`

```bash
autonomous-dev agent compare <agent-name> --current <v1> --candidate <v2>
```

Run a manual A/B comparison between two agent versions using blind scoring on historical inputs.

#### `agent promote`

```bash
autonomous-dev agent promote <agent-name> --version <version>
```

Promote a validated candidate agent version to production. Requires human confirmation.

#### `agent reject`

```bash
autonomous-dev agent reject <agent-name> --version <version>
```

Reject a proposed agent version. The candidate is archived and the current version remains active.

#### `agent accept`

```bash
autonomous-dev agent accept <agent-name>
```

Accept a proposed new agent (created by the gap detector). Moves it from `data/proposed-agents/` to the active `agents/` directory.

#### `agent gaps`

```bash
autonomous-dev agent gaps
```

List all detected domain gaps -- areas where no existing agent has sufficient expertise, suggesting a new specialist agent may be needed.

---

### `/autonomous-dev:observe`

Run the Production Intelligence observation cycle. This is a Claude Code slash command (not a CLI command).

```
/autonomous-dev:observe [scope] [run-id]
```

| Argument | Description | Default |
|---|---|---|
| `scope` | Service name or `"all"` | `all` |
| `run-id` | Override the run ID (for testing) | auto-generated |

**What it does:** Executes the full 4-phase observation lifecycle:

1. **Initialize** -- Generate run ID, load config, bootstrap directories, validate MCP connectivity.
2. **Triage** -- Process pending triage decisions from previous runs.
3. **Service Loop** -- For each service: collect metrics from Prometheus/Grafana/OpenSearch/Sentry, scrub PII, analyze for anomalies and trends, deduplicate, apply governance checks, generate reports.
4. **Finalize** -- Write run metadata and audit log.

**Example:**

```
/autonomous-dev:observe
/autonomous-dev:observe scope=api-gateway
/autonomous-dev:observe run-id=RUN-20260408-143000
```

**Output locations:**

- Audit log: `.autonomous-dev/logs/intelligence/RUN-<id>.log`
- Observations: `.autonomous-dev/observations/YYYY/MM/`
- Lock files (during execution): `.autonomous-dev/observations/.lock-<service>`

---

## Configuration Guide

### Layer Precedence

Configuration is loaded in four layers. Each layer overrides the one below it:

```
CLI flags          --config.governance.daily_cost_cap_usd=200    (highest priority)
Project config     <repo>/.claude/autonomous-dev.json
Global config      ~/.claude/autonomous-dev.json
Built-in defaults  <plugin>/config_defaults.json                 (lowest priority)
```

> **Tip:** Use `autonomous-dev config show` to see the effective merged configuration with source annotations showing which layer each value came from.

### Key Configuration Sections

#### Governance (cost and concurrency limits)

```json
{
  "governance": {
    "daily_cost_cap_usd": 100.00,
    "monthly_cost_cap_usd": 2000.00,
    "per_request_cost_cap_usd": 50.00,
    "max_concurrent_requests": 3,
    "disk_usage_limit_gb": 10.0
  }
}
```

When any cap is hit, the daemon pauses new work and notifies you. Existing in-flight phases complete their current Claude session but do not start new ones.

#### Trust Levels

```json
{
  "trust": {
    "system_default_level": 1,
    "repositories": {
      "/Users/you/projects/my-app": { "default_level": 2 },
      "/Users/you/projects/critical-service": { "default_level": 0 }
    },
    "promotion": {
      "enabled": true,
      "min_consecutive_successes": 20,
      "require_human_approval": true
    }
  }
}
```

Set `system_default_level` for new repos, then override per-repo as you build confidence. The `promotion` section controls automatic trust escalation (always requires human approval).

#### Review Gates

```json
{
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
  }
}
```

Higher thresholds mean stricter quality requirements. Increase `panel_size` for more reviewer diversity. The `disagreement_threshold` triggers human escalation when reviewers disagree by more than 15 points.

#### Notifications

```json
{
  "notifications": {
    "delivery": {
      "default_method": "cli",
      "discord": {
        "webhook_url": "https://discord.com/api/webhooks/...",
        "channel_id": "123456789"
      },
      "slack": {
        "webhook_url": "https://hooks.slack.com/services/...",
        "channel": "#autonomous-dev"
      }
    },
    "batching": {
      "enabled": true,
      "interval_minutes": 60,
      "exempt_types": ["escalation", "error"]
    },
    "dnd": {
      "enabled": true,
      "start": "22:00",
      "end": "07:00",
      "timezone": "America/New_York",
      "breakthrough_urgency": ["immediate"]
    }
  }
}
```

Notifications can go to the CLI, Discord, Slack, or a log file. Batching groups non-urgent notifications into hourly digests. Do-not-disturb mode suppresses notifications during off-hours, but escalations and errors always break through.

#### Production Intelligence

```json
{
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
    }
  }
}
```

The observation cycle runs on a cron schedule (default: every 4 hours). Anomaly detection uses z-score analysis against a 14-day baseline. Governance prevents fix-revert oscillation with cooldown periods and effectiveness comparisons.

---

## Usage Examples

### Beginner: Your First Request

**Step 1:** Make sure the daemon is running.

```bash
autonomous-dev daemon status
```

Verify you see `Service: running` and `Kill switch: disengaged`.

**Step 2:** Submit a request through the Claude App or CLI.

In a Claude Code session inside your project repo, describe what you want:

```
I need a /health endpoint for my Express app that returns
JSON with the server status and uptime in seconds.
```

**Step 3:** Check that the daemon picked it up.

```bash
autonomous-dev cost
```

You should see `Active Requests: 1` and cost accumulating.

**Step 4:** Watch for approval requests.

At trust level 0, the system will ask for your approval at every gate. Read the generated document (PRD, TDD, etc.), review the score, and approve or request changes.

**Step 5:** Check the result.

When the pipeline completes, you will have a new branch with committed code, passing tests, and all the documentation stored in `.autonomous-dev/requests/<request-id>/`.

---

### Intermediate: Configure Trust Levels

**Start at L0 (maximum oversight):**

```json
{
  "trust": {
    "system_default_level": 0
  }
}
```

Every gate requires your approval. Use this for the first 5-10 requests to understand what the system produces.

**Graduate to L1 (trust tests and quality):**

```json
{
  "trust": {
    "system_default_level": 1
  }
}
```

Test review and quality gates are now automated. You still approve PRDs, code, and deployments.

**Graduate to L2 (trust documents and cost):**

```json
{
  "trust": {
    "repositories": {
      "/Users/you/projects/my-app": { "default_level": 2 }
    }
  }
}
```

PRD approval and cost approval are now automated for this repo. Code review and deployment still require you.

**Set per-repo trust levels:**

Keep a critical service locked down while giving more autonomy to a hobby project:

```json
{
  "trust": {
    "system_default_level": 1,
    "repositories": {
      "/Users/you/projects/production-api": { "default_level": 0 },
      "/Users/you/projects/hobby-project": { "default_level": 3 }
    }
  }
}
```

---

### Intermediate: Set Up Discord/Slack Intake

#### Discord Bot Setup

1. Create a Discord bot at https://discord.com/developers/applications.
2. Enable the `MESSAGE_CONTENT` intent.
3. Add the bot to your server with `Send Messages` and `Read Message History` permissions.
4. Configure the webhook in your config:

```json
{
  "notifications": {
    "delivery": {
      "default_method": "discord",
      "discord": {
        "webhook_url": "https://discord.com/api/webhooks/YOUR_WEBHOOK",
        "channel_id": "YOUR_CHANNEL_ID"
      }
    }
  }
}
```

Users can submit requests by messaging the bot. The intake adapter parses natural-language descriptions and routes them into the pipeline.

#### Slack App Setup

1. Use the included manifest to create your Slack app:

   The manifest is at `intake/adapters/slack/slack-app-manifest.yaml`. Replace `${SLACK_HOST}` with your server's hostname before deploying.

2. Available slash commands:

   | Command | Description |
   |---|---|
   | `/ad-submit` | Submit a new request |
   | `/ad-status REQ-X` | View request status |
   | `/ad-list` | List all active requests |
   | `/ad-cancel REQ-X` | Cancel a request |
   | `/ad-pause REQ-X` | Pause a request |
   | `/ad-resume REQ-X` | Resume a paused request |
   | `/ad-priority REQ-X high` | Change priority |
   | `/ad-logs REQ-X` | View activity log |
   | `/ad-feedback REQ-X msg` | Send feedback |
   | `/ad-kill` | Emergency stop (admin only) |

3. Configure the webhook in your config:

```json
{
  "notifications": {
    "delivery": {
      "default_method": "slack",
      "slack": {
        "webhook_url": "https://hooks.slack.com/services/YOUR_WEBHOOK",
        "channel": "#autonomous-dev"
      }
    }
  }
}
```

#### Multi-Channel Routing

You can route different notification types to different channels:

```json
{
  "notifications": {
    "delivery": {
      "default_method": "slack",
      "overrides": {
        "escalation": "discord",
        "error": "discord"
      }
    }
  }
}
```

---

### Advanced: Production Intelligence

#### Connect Monitoring Sources

The observation system reads from four MCP servers. Set the connection details as environment variables:

```bash
export PROMETHEUS_URL="http://prometheus.local:9090"
export PROMETHEUS_TOKEN="your-read-only-token"
export GRAFANA_URL="http://grafana.local:3000"
export GRAFANA_TOKEN="your-read-only-token"
export OPENSEARCH_URL="https://opensearch.local:9200"
export OPENSEARCH_TOKEN="your-read-only-token"
export SENTRY_URL="https://sentry.io"
export SENTRY_TOKEN="your-read-only-token"
```

> **Warning:** Use read-only tokens with minimal permissions. The plugin never writes to your monitoring systems. See [Security and Safety](#security-and-safety) for the exact permission requirements.

#### Run an Observation

```
/autonomous-dev:observe
```

This collects metrics, scrubs PII, detects anomalies, and generates observation reports. If an error is detected (e.g., 5% error rate sustained for 10 minutes), the triage system generates a fix PRD that enters the pipeline automatically.

#### Set Up Scheduled Observations

The daemon can run observations on a cron schedule:

```json
{
  "production_intelligence": {
    "enabled": true,
    "schedule": "0 */4 * * *"
  }
}
```

This runs observations every 4 hours. Governance prevents oscillation: the system waits at least 7 days after deploying a fix before generating another fix PRD for the same issue.

---

### Expert: Agent Factory

#### View Agent Performance

```bash
# Summary dashboard
autonomous-dev agent dashboard

# Detailed metrics for one agent
autonomous-dev agent metrics prd-author
```

The dashboard shows approval rate trends, quality scores, escalation rates, and anomaly flags. Anomalies are detected when approval rate drops below 70% or escalation rate exceeds 30%.

#### Trigger Improvement Analysis

```bash
autonomous-dev agent analyze prd-author
```

This examines recent performance data, identifies weakness patterns, and generates a concrete improvement proposal with specific prompt changes.

#### A/B Test Agent Modifications

```bash
autonomous-dev agent compare prd-author --current 1.0.0 --candidate 1.1.0
```

Runs both versions against the same historical inputs with blind scoring. Outputs a comparison report showing which version produces higher-quality output.

#### Promote or Reject

```bash
# If the candidate wins
autonomous-dev agent promote prd-author --version 1.1.0

# If the candidate loses
autonomous-dev agent reject prd-author --version 1.1.0
```

Promotion enters a 7-day canary period. If quality drops during canary, the system auto-rolls back.

#### Detect Domain Gaps

```bash
autonomous-dev agent gaps
```

Lists areas where escalation rates are high and no existing agent has strong expertise -- suggesting a new specialist agent should be created.

---

## Architecture Overview

```
+-----------------------------------------------------------------------+
|                        autonomous-dev Plugin                          |
+-----------------------------------------------------------------------+
|                                                                       |
|  +-----------+   +-------------+   +-----------+   +-----------+      |
|  |  Intake   |-->|  Pipeline   |-->|  Review   |-->|  Trust    |      |
|  |  System   |   |  Engine     |   |  Gate     |   |  Engine   |      |
|  +-----------+   +-------------+   +-----------+   +-----------+      |
|   Claude App      PRD > TDD >       Blind scoring   L0-L3 gate       |
|   Discord         Plan > Spec >     Panel assembly  authority         |
|   Slack           Code > Deploy     Rubric registry  matrix           |
|                                                                       |
|  +-----------+   +-------------+   +-----------+   +-----------+      |
|  |  Daemon   |   |  Escalation |   |  Agent    |   |  Parallel |      |
|  |  (supvsr) |   |  Engine     |   |  Factory  |   |  Executor |      |
|  +-----------+   +-------------+   +-----------+   +-----------+      |
|   Poll loop       Category-based    Self-improving   Git worktrees    |
|   Circuit breaker  Routing chains   A/B testing      DAG scheduling   |
|   Cost governor    Human response   Canary deploy    Conflict resolve |
|                                                                       |
|  +-----------+   +-------------+   +-----------+   +-----------+      |
|  |  Prod     |   |  Safety     |   |  Audit    |   |  Notifi-  |      |
|  |  Intel    |   |  Pipeline   |   |  Trail    |   |  cations  |      |
|  +-----------+   +-------------+   +-----------+   +-----------+      |
|   Prometheus       PII scrubber     Hash chain       Discord/Slack    |
|   Grafana          Secret detector  Event writer     Batching/DND     |
|   OpenSearch       Weekly audit     Decision replay  Fatigue detect   |
|   Sentry                            Log archival                      |
|                                                                       |
+-----------------------------------------------------------------------+
```

### Subsystem Descriptions

| Subsystem | Purpose |
|---|---|
| **Intake System** | Receives requests from Claude App, Discord, and Slack. Parses, validates, deduplicates, rate-limits, and queues them. Supports clarifying conversations and priority management. |
| **Pipeline Engine** | Orchestrates the document pipeline (PRD > TDD > Plan > Spec > Code > Deploy). Manages state transitions, retries, timeouts, and context window budgets per phase. |
| **Review Gate** | Assembles reviewer panels, executes blind scoring against rubrics, aggregates scores, detects disagreement, and controls iteration loops. Enforces quality thresholds before advancing. |
| **Trust Engine** | Resolves effective trust level per repository, evaluates the 4x7 gate matrix, manages trust change requests, and enforces the immutable security review constraint. |
| **Daemon (Supervisor)** | The long-running background process. Polls for work, dispatches Claude CLI sessions, manages heartbeats, handles circuit breaking, idle backoff, log rotation, and cost enforcement. |
| **Escalation Engine** | Classifies stuck situations by category (product, technical, infrastructure, security, cost, quality), routes to the right human, manages timeout chains, and handles human responses. |
| **Agent Factory** | Tracks agent performance metrics, detects anomalies, generates improvement proposals, runs A/B validation with blind scoring, manages canary deployments, and detects domain gaps. |
| **Parallel Executor** | Runs independent tasks concurrently using git worktrees. Manages DAG-based scheduling, disk resource monitoring, conflict classification, and AI-assisted merge conflict resolution. |
| **Production Intelligence** | Connects to Prometheus, Grafana, OpenSearch, and Sentry via MCP. Detects errors and anomalies, analyzes trends, deduplicates observations, and generates fix PRDs. Includes governance to prevent oscillation. |
| **Safety Pipeline** | Non-bypassable PII and secret scrubbing. 11 PII patterns + 15 secret patterns + entropy-based detection. Runs on all collected data before analysis. Weekly audit scan as a second line of defense. |
| **Audit Trail** | Records every decision, state transition, and significant event. Supports optional hash chain integrity, decision replay for debugging, and configurable log archival with retention policies. |
| **Notifications** | Delivers messages via CLI, Discord, Slack, or file drop. Includes batching (hourly digests), do-not-disturb mode, fatigue detection (max 20/hour), and cross-request systemic failure alerts. |

### Data Flow

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
(repeat)         Code complete
                       |
                       v
                 Tests pass --> Deploy --> Observe production
                                               |
                                          error found?
                                               |
                                               v
                                     Generate fix PRD --> back to pipeline
```

---

## Security and Safety

### Trust Ladder

The trust system is your primary safety control. Start at L0 (approve everything) and promote gradually. Trust promotion always requires human approval -- this is immutable and enforced at the type system level (`require_human_approval: true` cannot be set to false).

### Kill Switch

```bash
autonomous-dev kill-switch        # Stop everything immediately
autonomous-dev kill-switch reset  # Resume when ready
```

The kill switch is a file-based flag checked on every daemon iteration. It takes effect within one poll cycle (default: 30 seconds). In-flight requests are paused, not cancelled.

### Circuit Breaker

After 3 consecutive crashes (configurable), the daemon trips its circuit breaker and stops automatically. This prevents runaway failures. Investigate the root cause in the logs, then reset:

```bash
autonomous-dev circuit-breaker reset
```

### Cost Budgets

Three layers of cost protection:

| Budget | Default | Scope |
|---|---|---|
| Per-request | $50 | Single pipeline run |
| Daily | $100 | All requests in one day (UTC) |
| Monthly | $2,000 | All requests in one month (UTC) |

When any budget is exceeded, the daemon pauses new work and sends a notification. In-flight Claude sessions complete but new phases do not start.

### Repository Allowlist

The daemon only operates on repositories explicitly listed in the `repositories.allowlist` configuration. It will not touch any repository not on this list.

```json
{
  "repositories": {
    "allowlist": [
      "/Users/you/projects/my-app",
      "/Users/you/projects/another-app"
    ]
  }
}
```

### PII Scrubbing

All data collected from production monitoring is scrubbed before analysis:

- **Stage 1 (PII):** 11 patterns covering emails, phone numbers, SSNs, credit card numbers, IP addresses, JWTs, and user-context UUIDs.
- **Stage 2 (Secrets):** 15 patterns covering AWS keys, Stripe keys, GitHub/GitLab tokens, GCP keys, Slack tokens, bearer tokens, basic auth, private keys, and high-entropy strings.

There is no `skip_scrubbing` configuration flag. If scrubbing fails, the raw data is replaced with `[SCRUB_FAILED:...]` and never passed to the LLM or any persisted file. A weekly audit scan re-checks all observation reports as a last line of defense.

### Audit Trail

Every decision, state transition, review score, escalation, and configuration change is logged. The audit system supports:

- Structured JSONL event logs
- Optional hash chain integrity verification
- Decision replay for debugging
- Configurable retention (default: 90 days for events, 365 days for archives)

### MCP Read-Only Access

All four MCP server connections (Prometheus, Grafana, OpenSearch, Sentry) use read-only tokens with least-privilege permissions. The plugin never writes to your monitoring systems and never attempts to escalate privileges.

---

## Troubleshooting

### The daemon is not starting

**Check 1:** Is it installed?

```bash
# macOS
ls ~/Library/LaunchAgents/com.autonomous-dev.daemon.plist

# Linux
ls ~/.config/systemd/user/autonomous-dev.service
```

If the file does not exist, run `autonomous-dev install-daemon`.

**Check 2:** Is bash 4+ available?

```bash
bash --version
# Must be 4.0 or later
```

On macOS, install with `brew install bash`.

**Check 3:** Are dependencies available?

```bash
which claude jq git
```

All three must be in your PATH.

### The daemon is running but not processing requests

**Check 1:** Is the kill switch engaged?

```bash
autonomous-dev daemon status
```

Look for `Kill switch: ENGAGED`. Reset with `autonomous-dev kill-switch reset`.

**Check 2:** Is the circuit breaker tripped?

```bash
autonomous-dev daemon status
```

Look for `Circuit breaker: TRIPPED`. Check the logs for the root cause, then reset with `autonomous-dev circuit-breaker reset`.

**Check 3:** Is the cost budget exceeded?

```bash
autonomous-dev cost
```

If remaining budget is zero or negative, wait for the daily/monthly reset or increase your caps in the configuration.

**Check 4:** Is your repository in the allowlist?

```bash
autonomous-dev config show | jq '.config.repositories.allowlist'
```

### A request is stuck in a phase

**Check the request cost breakdown:**

```bash
autonomous-dev cost --request REQ-20260408-a3f1
```

If a phase shows many sessions with zero progress, the request may have hit the retry limit.

**Check the daemon logs:**

```bash
# macOS
cat ~/.autonomous-dev/logs/daemon.log | jq 'select(.message | contains("REQ-20260408-a3f1"))'

# Linux
journalctl --user -u autonomous-dev -g "REQ-20260408-a3f1"
```

**Force a cleanup and retry:**

```bash
autonomous-dev cleanup --request REQ-20260408-a3f1
```

### Recovering after a crash

1. Check the daemon status:

   ```bash
   autonomous-dev daemon status
   ```

2. If the circuit breaker is tripped, review the logs for the root cause.

3. Reset the circuit breaker:

   ```bash
   autonomous-dev circuit-breaker reset
   ```

4. Restart the daemon:

   ```bash
   autonomous-dev daemon start
   ```

5. Validate your configuration:

   ```bash
   autonomous-dev config validate
   ```

### Observation runs are failing

**Check MCP connectivity:** Ensure the environment variables for Prometheus, Grafana, OpenSearch, and Sentry are set and the tokens are valid.

**Partial data is OK:** If one MCP source is unavailable, the run continues with partial data. Only when all sources are unreachable does the run abort.

**Check lock conflicts:** Lock files at `.autonomous-dev/observations/.lock-<service>` prevent concurrent processing. Stale locks from crashed runs can be safely deleted.

---

## Project Structure

```
autonomous-dev/
|
|-- .claude-plugin/
|   +-- plugin.json              # Plugin metadata (name, version, description)
|
|-- agents/                      # Agent definition files (Markdown frontmatter)
|   |-- prd-author.md            #   Writes Product Requirements Documents
|   |-- tdd-author.md            #   Writes Technical Design Documents
|   |-- plan-author.md           #   Writes implementation plans
|   |-- spec-author.md           #   Writes implementation specs
|   |-- code-executor.md         #   Writes and tests code
|   |-- test-executor.md         #   Runs test suites
|   |-- deploy-executor.md       #   Handles deployment
|   |-- quality-reviewer.md      #   Reviews quality
|   |-- security-reviewer.md     #   Reviews security
|   |-- architecture-reviewer.md #   Reviews architecture
|   |-- doc-reviewer.md          #   Reviews documents
|   |-- performance-analyst.md   #   Reviews performance
|   +-- agent-meta-reviewer.md   #   Reviews agent improvements
|
|-- bin/
|   |-- autonomous-dev.sh        # CLI dispatcher (routes all commands)
|   |-- supervisor-loop.sh       # Daemon supervisor main loop
|   +-- install-daemon.sh        # OS service installer
|
|-- commands/
|   |-- config_init.sh           # config init implementation
|   |-- config_show.sh           # config show implementation
|   |-- config_validate.sh       # config validate implementation
|   |-- cost.sh                  # cost reporting implementation
|   |-- cleanup.sh               # cleanup implementation
|   +-- observe.md               # observe slash command definition
|
|-- config/
|   |-- defaults.json            # Built-in daemon defaults
|   +-- agent-factory.yaml       # Agent factory configuration
|
|-- docs/
|   |-- prd/                     # Generated PRDs
|   |-- tdd/                     # Generated TDDs
|   |-- plans/                   # Generated plans
|   |-- specs/                   # Generated specs
|   +-- SECURITY.md              # Security controls documentation
|
|-- intake/
|   |-- adapters/
|   |   |-- claude_adapter.ts    # Claude App intake
|   |   |-- discord/             # Discord bot (7 files)
|   |   +-- slack/               # Slack bot (11 files, includes manifest)
|   |-- core/                    # Request parsing, routing, dedup, sanitization
|   |-- queue/                   # Priority queue, starvation monitor
|   |-- handlers/                # Submit, status, cancel, pause, resume, etc.
|   |-- conversation/            # Clarifying question flow
|   |-- authz/                   # Authorization engine
|   |-- db/                      # SQLite schema, migrations, repository
|   |-- notifications/           # Intake-specific notifications
|   |-- events/                  # Event bus
|   +-- rate_limit/              # Rate limiter
|
|-- lib/
|   |-- config_loader.sh         # Four-layer config merge
|   |-- config_validator.sh      # Validation rules engine
|   |-- cost_ledger.sh           # Cost tracking JSONL ledger
|   |-- cost_governor.sh         # Budget enforcement
|   |-- cost_extractor.sh        # Cost data extraction
|   |-- cost_request_tracker.sh  # Per-request cost tracking
|   |-- cleanup_engine.sh        # Retention, archival, cleanup orchestrator
|   |-- cleanup_trigger.sh       # Automatic cleanup trigger
|   |-- ledger_rotation.sh       # Cost ledger archival/rotation
|   |-- repo_allowlist.sh        # Repository allowlist enforcement
|   |-- resource_monitor.sh      # Disk usage monitoring
|   +-- rate_limit_handler.sh    # API rate limit backoff
|
|-- phase-prompts/               # Prompt templates per pipeline phase
|
|-- src/
|   |-- pipeline/                # Pipeline state machine
|   |-- review-gate/             # Review scoring, panels, rubrics (20 files)
|   |-- trust/                   # Trust levels, gate matrix (7 files)
|   |-- escalation/              # Escalation routing, human response (16 files)
|   |-- agent-factory/           # Self-improving agent system (40+ files)
|   |   |-- improvement/         #   Weakness analysis, proposals
|   |   |-- metrics/             #   Performance tracking
|   |   |-- validation/          #   A/B testing, blind scoring
|   |   |-- promotion/           #   Canary, promote, reject, rollback
|   |   |-- canary/              #   Shadow runner, exit evaluator
|   |   +-- gaps/                #   Domain gap detection
|   |-- parallel/                # Parallel execution (18 files)
|   |-- engine/                  # Production intelligence analysis (16 files)
|   |-- runner/                  # Observation runner lifecycle (6 files)
|   |-- triage/                  # Observation triage, PRD generation (8 files)
|   |-- governance/              # Cooldowns, oscillation, effectiveness (8 files)
|   |-- safety/                  # PII scrubber, secret detector (7 files)
|   |-- adapters/                # MCP server adapters (10 files)
|   |-- audit/                   # Audit trail, hash chain (9 files)
|   |-- notifications/           # Notification delivery framework (9 files)
|   |-- emergency/               # Kill switch, pause/resume, state (9 files)
|   |-- reports/                 # Report generation, weekly digest (8 files)
|   +-- config/                  # Intelligence config schema (2 files)
|
|-- templates/
|   |-- com.autonomous-dev.daemon.plist.template   # macOS LaunchAgent
|   +-- autonomous-dev.service.template            # Linux systemd unit
|
|-- tests/                       # Test suites (bats, jest, integration, e2e)
|
|-- .mcp.json                    # MCP server connection config
|-- config_defaults.json         # Full default configuration (all settings)
|-- package.json                 # Node dependencies
+-- .gitignore                   # Excludes observation data from version control
```

### Key Files to Know

| File | Why it matters |
|---|---|
| `config_defaults.json` | Every configurable setting with its default value |
| `bin/autonomous-dev.sh` | Entry point for all CLI commands |
| `bin/supervisor-loop.sh` | The daemon's main loop -- start here to understand runtime behavior |
| `src/trust/gate-matrix.ts` | The 4x7 trust level matrix that controls human vs. system authority |
| `src/review-gate/review-gate-service.ts` | Core review orchestration logic |
| `src/agent-factory/cli.ts` | All agent subcommand implementations |
| `commands/observe.md` | The observe slash command definition and lifecycle |
| `config/agent-factory.yaml` | Agent factory rate limits, anomaly thresholds, and paths |
| `intake/adapters/slack/slack-app-manifest.yaml` | Complete Slack bot configuration |

---

## Contributing

### How to Add New Agents

1. Create a new Markdown file in `agents/`:

   ```
   agents/my-new-agent.md
   ```

2. Define the agent using YAML frontmatter with `name`, `version`, `role`, `expertise`, and the system prompt in the body.

3. Reload the registry:

   ```bash
   autonomous-dev agent reload
   ```

4. The Agent Factory will automatically begin tracking metrics for the new agent.

### How to Add New Phase Prompts

1. Create a Markdown file in `phase-prompts/` matching the phase name:

   ```
   phase-prompts/my-phase.md
   ```

2. Use the supported variables in your template:

   | Variable | Expands to |
   |---|---|
   | `{{REQUEST_ID}}` | The request ID (e.g., `REQ-20260408-abcd`) |
   | `{{PROJECT}}` | Absolute path to the project repository |
   | `{{STATE_FILE}}` | Absolute path to the request's `state.json` |
   | `{{PHASE}}` | The current phase name |

3. If no prompt file exists for a phase, a minimal fallback prompt is generated automatically.

### How to Extend the Pipeline

The pipeline phases are defined by the state machine configuration in `config_defaults.json`. To add a new phase:

1. Add the phase name to `daemon.max_turns_by_phase` in `config_defaults.json`.
2. Add retry limits in `state_machine.retry_limits_by_phase`.
3. Add a timeout in `state_machine.timeouts_by_phase`.
4. Create a phase prompt in `phase-prompts/<phase-name>.md`.
5. If the phase needs review, add a threshold in `review_gates.thresholds_by_type`.
6. Update the pipeline state machine in `src/pipeline/` to include transitions to and from your new phase.
7. Write tests in `tests/pipeline/` covering the new transitions.

### How to Add New Intake Adapters

1. Implement the adapter interface defined in `intake/adapters/adapter_interface.ts`.
2. Place your adapter in `intake/adapters/<name>/`.
3. Register it with the intake router in `intake/core/intake_router.ts`.
4. Add tests in `intake/__tests__/`.

---

*Built for the [claude-code-homelab](https://github.com/pwatson/claude-code-homelab) project.*
