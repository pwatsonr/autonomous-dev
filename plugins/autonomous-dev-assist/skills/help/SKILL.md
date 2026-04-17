---
name: autonomous-dev-help
description: Get help with autonomous-dev — commands, concepts, configuration, pipeline phases, trust levels, and capabilities. Triggered by questions about the plugin.
user-invocable: true
model: claude-sonnet-4-6
---

You are the help assistant for the **autonomous-dev** Claude Code plugin. When users ask questions (how do I, what is, explain, help, etc.), answer clearly and concisely using the reference material below. Always include the exact command syntax when relevant.

---

# autonomous-dev Help Reference

## What Is autonomous-dev?

autonomous-dev is a Claude Code plugin that provides an **autonomous AI development pipeline**. It runs as a background daemon on your machine and takes product requests from idea to deployed code without you managing each step.

You describe what you want -- in plain English, through the Claude App, Discord, or Slack -- and the system writes the documents, writes the code, reviews everything, runs the tests, and ships it. When something breaks in production, it detects the problem and writes a fix request for itself.

You stay in control. The system asks for your approval at key checkpoints (you choose how many via trust levels), and you can hit a kill switch at any time to stop everything.

---

## The Document Pipeline (PRD > TDD > Plan > Spec > Code)

Every request flows through five phases, each producing a concrete artifact:

| Phase | Artifact | Review Threshold |
|---|---|---|
| **PRD** | Product Requirements Document -- defines what to build and why | 85 |
| **TDD** | Technical Design Document -- defines how to build it | 85 |
| **Plan** | Implementation Plan -- breaks the TDD into ordered tasks | 80 |
| **Spec** | Implementation Specification -- adds implementation-level detail to each task | 80 |
| **Code** | Working code -- written, tested, and committed | 85 |

No phase is skipped. Each artifact is versioned and stored. After code passes review, the system runs integration tests, then deploys, then monitors production.

Between every phase, a panel of reviewer agents scores the output against a rubric. If the score falls below the threshold, the document is sent back with specific feedback for revision. After three failed iterations, the system escalates to a human.

```
Request --> PRD --> review --> TDD --> review --> Plan --> review --> Spec --> review --> Code --> review --> Deploy --> Observe
                                                                                                                       |
                                                                                                              error? --> new PRD
```

---

## Trust Levels (L0-L3)

Trust levels control how much human approval the system needs. Set per-repository; promote gradually as you build confidence.

### L0 -- Paranoid (maximum oversight)
Every gate requires human sign-off: PRD approval, code review, test review, deploy approval, security review, cost approval, and quality gate. Use this for your first 5-10 requests to understand what the system produces.

### L1 -- Cautious
Test review and quality gates become automated. You still approve PRDs, code, deployments, security, and cost. This is the system default for new repos.

### L2 -- Confident
PRD approval and cost approval also automate. You still approve code review, deployments, and security. Use this for repos where you trust the pipeline output.

### L3 -- Autonomous
Nearly everything is automated except security review and deploy approval for critical services. Use this for well-understood repos with good test coverage.

| Gate | L0 | L1 | L2 | L3 |
|---|---|---|---|---|
| PRD approval | human | human | system | system |
| Code review | human | human | human | system |
| Test review | human | system | system | system |
| Deploy approval | human | human | human | system |
| Security review | human | human | human | human |
| Cost approval | human | human | system | system |
| Quality gate | human | system | system | system |

**Important:** Security review is always human-controlled. This is enforced programmatically and cannot be overridden by configuration.

Trust promotion (automatic level increases) is available but always requires human approval. Configure via the `trust.promotion` config section.

---

## The Daemon

The daemon is a long-running background process that powers autonomous-dev. It:

- **Polls for work** every 30 seconds (configurable, scales to 15 min when idle)
- **Installs as an OS service** -- macOS LaunchAgent or Linux systemd user service, survives reboots and logouts
- **Manages request lifecycle** -- picks up submissions, dispatches Claude CLI sessions for each phase, tracks state, handles retries, enforces cost budgets
- **Includes a circuit breaker** -- trips after 3 consecutive crashes (configurable) to prevent runaway failures
- **Logs everything** -- structured JSONL logging with configurable retention

The daemon only operates on repositories listed in the `repositories.allowlist` configuration.

---

## Agent Factory

The system ships with 13 specialist agents:

| Agent | Role |
|---|---|
| prd-author | Writes Product Requirements Documents |
| tdd-author | Writes Technical Design Documents |
| plan-author | Creates implementation plans |
| spec-author | Writes implementation specs |
| code-executor | Writes and tests code |
| test-executor | Runs test suites |
| deploy-executor | Handles deployment |
| quality-reviewer | Reviews quality |
| security-reviewer | Reviews security |
| architecture-reviewer | Reviews architecture |
| doc-reviewer | Reviews documents |
| performance-analyst | Reviews performance |
| agent-meta-reviewer | Reviews agent improvements |

The Agent Factory is a self-improvement subsystem that:

1. **Monitors performance** -- tracks approval rate, quality scores, escalation rate, token usage for every agent
2. **Detects anomalies** -- alerts when approval rate drops below 70% or escalation rate exceeds 30%
3. **Generates improvements** -- when performance degrades, it creates concrete improvement proposals with specific prompt changes
4. **A/B tests changes** -- tests proposed changes against the current version using blind scoring
5. **Promotes winners** -- through a 7-day canary period with auto-rollback if quality drops
6. **Detects domain gaps** -- identifies areas where no existing agent has sufficient expertise

Rate limits prevent runaway modifications: at most 1 new agent and 1 modification per agent per week. Humans always approve new agents and promotions.

---

## Review Gates

Review gates enforce quality at every phase transition:

- **Panel assembly** -- a configurable number of reviewer agents score each artifact (default: 2 reviewers for PRD/TDD/Code, 1 for Plan/Spec)
- **Blind scoring** -- reviewers evaluate against rubrics without seeing each other's scores to prevent anchoring bias
- **Score aggregation** -- scores are aggregated (default: mean) and compared against the phase threshold
- **Disagreement detection** -- when reviewers diverge by more than 15 points (configurable), the system escalates to a human
- **Iteration loop** -- if a document fails, it is sent back with specific feedback for revision, up to 3 times (configurable)
- **Escalation** -- after max iterations, the system escalates to a human with the document, scores, and feedback history

---

## Production Intelligence

The production intelligence loop monitors your deployed services and auto-generates fix requests:

1. **Data collection** -- connects to Prometheus, Grafana, OpenSearch, and Sentry via MCP servers using read-only tokens
2. **PII scrubbing** -- all collected data is scrubbed (11 PII patterns + 15 secret patterns + entropy detection) before analysis
3. **Error detection** -- identifies sustained error rates above threshold (default: 5% for 10+ minutes)
4. **Anomaly detection** -- z-score analysis against a 14-day baseline (sensitivity: 2.5 standard deviations)
5. **Trend analysis** -- detects degrading trends over 7/14/30-day windows
6. **Triage** -- generates fix PRDs that enter the pipeline automatically
7. **Governance** -- prevents fix-revert oscillation with cooldown periods (default: 7 days) and effectiveness comparisons

Observations run on a cron schedule (default: every 4 hours). Reports are stored in `.autonomous-dev/observations/`.

---

## Intake Channels

Users can submit requests through three channels:

### Claude App (default)
Describe what you want in a Claude Code session inside your project repo. The daemon picks it up from the intake queue.

### Discord
Set up a Discord bot and configure the webhook URL. Users submit requests by messaging the bot. The intake adapter parses natural-language descriptions and routes them into the pipeline.

### Slack
Use the included manifest (`intake/adapters/slack/slack-app-manifest.yaml`) to create a Slack app. Available slash commands:

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

---

## Cost Tracking and Budgets

Three layers of cost protection prevent runaway spending:

| Budget | Default | Scope |
|---|---|---|
| Per-request | $50 | Single pipeline run |
| Daily | $100 | All requests in one day (UTC) |
| Monthly | $2,000 | All requests in one month (UTC) |

When any budget is exceeded, the daemon pauses new work and sends a notification. In-flight Claude sessions complete but new phases do not start.

Cost data is tracked in a JSONL ledger with per-request per-phase breakdowns. Use `autonomous-dev cost` to view reports.

---

## Kill Switch and Emergency Controls

### Kill Switch
Immediately stop all daemon processing. Creates a file-based flag checked every poll cycle (default: 30 seconds). In-flight requests are paused, not cancelled.

```bash
autonomous-dev kill-switch          # Stop everything
autonomous-dev kill-switch reset    # Resume processing
```

### Circuit Breaker
After 3 consecutive crashes (configurable), the daemon trips its circuit breaker and stops automatically. Investigate the root cause in the logs, then reset.

```bash
autonomous-dev circuit-breaker reset
```

### Emergency Modes
- **Graceful** (default) -- completes the current Claude session, then halts
- **Restart requires human** (default: true) -- after emergency stop, daemon will not auto-restart without human intervention

---

## Commands Reference

### `autonomous-dev install-daemon [--force]`
Install the daemon as an OS service (macOS LaunchAgent or Linux systemd unit). Detects your OS, finds bash 4+, templates the service configuration, sets restrictive file permissions (700 on directories, 600 on files), and starts the service. Use `--force` to overwrite an existing installation.

```bash
autonomous-dev install-daemon
autonomous-dev install-daemon --force
```

### `autonomous-dev daemon start|stop|status`
Control the daemon service.

```bash
autonomous-dev daemon start     # Start the daemon
autonomous-dev daemon stop      # Stop the daemon (in-flight work is saved)
autonomous-dev daemon status    # Show service state, kill switch, circuit breaker, heartbeat, lock
```

### `autonomous-dev kill-switch` / `kill-switch reset`
Engage or disengage the kill switch.

```bash
autonomous-dev kill-switch          # Halt all processing immediately
autonomous-dev kill-switch reset    # Resume processing on next poll cycle
```

### `autonomous-dev circuit-breaker reset`
Clear the crash counter and un-trip the circuit breaker after investigating and fixing the root cause of repeated failures.

```bash
autonomous-dev circuit-breaker reset
```

### `autonomous-dev config init|show|validate`
Manage configuration.

```bash
autonomous-dev config init --global [--force]     # Create ~/.claude/autonomous-dev.json
autonomous-dev config init --project [--force]    # Create <repo>/.claude/autonomous-dev.json
autonomous-dev config show [--config.key=value]   # Show effective merged config with source annotations
autonomous-dev config validate [--config.key=value]  # Validate config (exits 0 if valid, 1 if errors)
```

### `autonomous-dev cost [--daily|--monthly|--request REQ-X|--repo /path]`
View cost reports and spending breakdowns.

```bash
autonomous-dev cost                          # Today + current month summary
autonomous-dev cost --daily                  # Daily breakdown for current month
autonomous-dev cost --monthly                # Monthly breakdown for current year
autonomous-dev cost --request REQ-X          # Per-request per-phase breakdown
autonomous-dev cost --repo /path/to/repo     # Per-repo breakdown
```

### `autonomous-dev cleanup [--dry-run|--force|--request REQ-X]`
Remove expired artifacts, archive old requests, and reclaim disk space.

```bash
autonomous-dev cleanup                       # Interactive cleanup with defaults
autonomous-dev cleanup --dry-run             # Preview what would be cleaned up
autonomous-dev cleanup --force               # Skip confirmation prompts
autonomous-dev cleanup --request REQ-X       # Clean up a specific request only
autonomous-dev cleanup --config.retention.completed_request_days=7  # Override retention
```

Archives completed requests older than the retention period (default: 30 days), removes git worktrees, deletes remote branches, rotates logs, prunes observation data, and removes old tarballs.

### `autonomous-dev agent list|inspect|reload|freeze|unfreeze|metrics|dashboard|rollback|analyze|compare|promote|reject|accept|gaps`
Manage the Agent Factory and all registered agents.

```bash
autonomous-dev agent list                                          # Table of all agents
autonomous-dev agent inspect <agent-name>                          # Full config/state for one agent
autonomous-dev agent reload                                        # Reload registry from agents/ dir
autonomous-dev agent freeze <agent-name>                           # Take agent out of rotation
autonomous-dev agent unfreeze <agent-name>                         # Return agent to ACTIVE state
autonomous-dev agent metrics <agent-name>                          # Performance metrics for one agent
autonomous-dev agent dashboard                                     # Summary table of all agents
autonomous-dev agent rollback <agent-name> [--to-version <ver>]    # Roll back to previous version
autonomous-dev agent analyze <agent-name>                          # Trigger improvement analysis
autonomous-dev agent compare <name> --current <v1> --candidate <v2>  # A/B test two versions
autonomous-dev agent promote <agent-name> --version <ver>          # Promote candidate to production
autonomous-dev agent reject <agent-name> --version <ver>           # Reject proposed version
autonomous-dev agent accept <agent-name>                           # Accept proposed new agent
autonomous-dev agent gaps                                          # List detected domain gaps
```

### `/autonomous-dev:observe [scope] [run-id]`
Run the Production Intelligence observation cycle (Claude Code slash command).

```
/autonomous-dev:observe                              # Process all configured services
/autonomous-dev:observe scope=api-gateway            # Process a single service
/autonomous-dev:observe run-id=RUN-20260408-143000   # Override run ID (testing)
```

Executes the full 4-phase observation lifecycle: Initialize, Triage, Service Loop (collect, scrub, analyze, deduplicate, govern, report), Finalize.
