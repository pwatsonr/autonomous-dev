# PRD-001: System Core & Daemon Engine

| Field       | Value                                      |
|-------------|--------------------------------------------|
| **Title**   | System Core & Daemon Engine                |
| **PRD ID**  | PRD-001                                    |
| **Version** | 0.1.0                                      |
| **Date**    | 2026-04-08                                 |
| **Author**  | Paul Watson (PM Lead)                      |
| **Status**  | Draft                                      |
| **Plugin**  | `autonomous-dev` (Claude Code plugin)      |

---

## 1. Problem Statement

Building and shipping software with Claude Code today is a human-in-the-loop process: a developer formulates a task, opens a session, supervises execution, reviews output, and repeats. This works for individual tasks but does not scale. There is no mechanism to submit a product request, walk away, and have it autonomously decomposed into documents, reviewed, planned, coded, tested, deployed, and monitored --- with the system generating its own improvement PRDs from what it observes in production.

The `autonomous-dev` plugin aims to be that mechanism. But before any pipeline stage can run, the system needs a reliable **core engine** --- a daemon-like process supervisor, a durable state machine, resource governance, and a configuration system. Without this foundation, every downstream capability (PRD generation, code review, deployment) has no substrate to run on.

This PRD defines that foundation.

---

## 2. Goals

| ID   | Goal                                                                                         |
|------|----------------------------------------------------------------------------------------------|
| G-1  | Provide a continuously-running process supervisor that spawns and manages Claude Code sessions on macOS and Linux. |
| G-2  | Implement a file-based state machine that tracks each request through the full pipeline with atomic writes and crash-safe recovery. |
| G-3  | Define the complete request lifecycle from intake through deployment and monitoring, including cancellation and error recovery. |
| G-4  | Enforce global resource governance --- cost caps, rate-limit awareness, concurrency limits, and disk usage monitoring. |
| G-5  | Deliver a layered configuration system (global, project, CLI) so operators can tune every threshold without code changes. |
| G-6  | Provide a kill switch, priority system, and cleanup strategy from day one --- not as afterthoughts. |
| G-7  | Ensure the system can run unattended for days/weeks, recovering from crashes, sleeps, and API outages without human intervention. |

## 3. Non-Goals

| ID    | Non-Goal                                                                                    |
|-------|---------------------------------------------------------------------------------------------|
| NG-1  | This PRD does not cover the content of any pipeline stage (PRD generation, TDD authoring, code generation, test execution). Those are separate PRDs that consume the engine defined here. |
| NG-2  | No GUI or web dashboard. The system is CLI-first; observability is via log files, state files, and notification hooks. |
| NG-3  | No multi-machine distribution or clustering. The engine runs on a single host. |
| NG-4  | No custom LLM provider support. The engine targets Claude Code (Anthropic) exclusively. |
| NG-5  | No built-in CI/CD pipeline. The engine invokes external CI systems; it does not replace them. |

---

## 4. User Personas

### 4.1 PM Lead (Request Author)

**Role:** Product manager or tech lead who submits product requests to the system.

- Submits requests in natural language or structured markdown.
- Reviews escalations when the system cannot resolve ambiguity or quality gates autonomously.
- Approves or rejects generated PRDs and TDDs at human-review gates.
- Needs clear visibility into where each request sits in the pipeline and why it stalled (if it did).
- Does **not** need to understand the daemon internals.

### 4.2 System Operator

**Role:** Engineer or SRE responsible for deploying and operating the daemon itself.

- Installs and configures the plugin, launchd/systemd units, and global settings.
- Monitors system health: uptime, crash counts, cost burn rate, disk usage.
- Responds to circuit-breaker alerts when the system self-disables after repeated failures.
- Tunes resource caps, concurrency limits, and turn budgets based on observed behavior.
- Executes kill-switch commands when needed.
- May operate across multiple repositories / projects.

### 4.3 Code Consumer

**Role:** Developer who maintains the codebase that the system produces code for.

- Reviews and merges PRs created by the system.
- Needs confidence that generated code passed the system's own quality gates before it reached them.
- Expects conventional branch naming, commit messages, and PR descriptions.
- May request changes on a PR and expect the system to address them.

### 4.4 Stakeholder

**Role:** Engineering director, VP, or executive who needs visibility into system value.

- Cares about aggregate metrics: requests completed, cost per request, cycle time, escalation rate.
- Does not interact with the system directly.
- Consumes periodic summary reports or dashboard exports.

---

## 5. User Stories

### Happy Path

| ID    | Persona          | Story                                                                                                                     | Priority |
|-------|------------------|---------------------------------------------------------------------------------------------------------------------------|----------|
| US-01 | PM Lead          | As a PM Lead, I can submit a product request via a CLI command so that the system begins autonomous processing.            | P0       |
| US-02 | PM Lead          | As a PM Lead, I can check the status of any request by its tracking ID so I know where it is in the pipeline.              | P0       |
| US-03 | System Operator  | As a System Operator, I can install the daemon supervisor with a single command so the engine starts running on boot.       | P0       |
| US-04 | System Operator  | As a System Operator, I can view the heartbeat timestamp and crash count so I know the engine is alive.                    | P0       |
| US-05 | System Operator  | As a System Operator, I can set daily and monthly cost caps in configuration so spending never exceeds budget.              | P0       |
| US-06 | PM Lead          | As a PM Lead, I can cancel a request so that its branches, worktrees, and state files are cleaned up.                      | P0       |
| US-07 | Code Consumer    | As a Code Consumer, I can see in a PR description which tracking ID and pipeline phase produced the code so I have context. | P1       |
| US-08 | Stakeholder      | As a Stakeholder, I can query aggregate metrics (completed requests, cost, cycle time) for a date range.                   | P1       |

### Edge Cases & Error Handling

| ID    | Persona          | Story                                                                                                                          | Priority |
|-------|------------------|--------------------------------------------------------------------------------------------------------------------------------|----------|
| US-09 | System Operator  | As a System Operator, when the engine crashes 3 times consecutively, the circuit breaker trips and I receive an alert.          | P0       |
| US-10 | System Operator  | As a System Operator, I can issue a kill-switch command that immediately stops all in-progress work and prevents new work.       | P0       |
| US-11 | PM Lead          | As a PM Lead, when a review gate fails 3 times, I receive an escalation notification with context about what failed.            | P0       |
| US-12 | System Operator  | As a System Operator, when the machine sleeps and wakes, the engine detects stale heartbeats and resumes without duplicate work. | P0       |
| US-13 | System Operator  | As a System Operator, when context window exhaustion occurs mid-phase, the engine checkpoints state and spawns a fresh session.  | P0       |
| US-14 | System Operator  | As a System Operator, when API rate limits are hit, the engine backs off exponentially and resumes without losing state.         | P0       |
| US-15 | PM Lead          | As a PM Lead, I can set priority on a request so higher-priority requests are processed before lower-priority ones.              | P1       |
| US-16 | PM Lead          | As a PM Lead, I can declare a dependency between requests so request B does not start until request A reaches a specified state. | P1       |
| US-17 | System Operator  | As a System Operator, completed requests older than a configurable retention period are automatically archived and cleaned up.   | P1       |
| US-18 | System Operator  | As a System Operator, when disk usage exceeds the configured threshold, new requests are blocked until space is freed.           | P1       |
| US-19 | Code Consumer    | As a Code Consumer, when I push review comments on a system-generated PR, the system picks them up and addresses them.          | P2       |
| US-20 | System Operator  | As a System Operator, I can run the engine in dry-run mode where it logs what it would do without executing any mutations.       | P2       |

---

## 6. Functional Requirements

### 6.1 Daemon / Continuous Operation

| ID     | Requirement                                                                                                                                                           | Priority |
|--------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-100 | The engine SHALL be implemented as a bash supervisor loop that spawns fresh Claude Code CLI sessions per iteration, since Claude Code plugins cannot run as true background daemons. | P0 |
| FR-101 | The supervisor loop SHALL be managed by launchd (macOS) or systemd (Linux) to ensure it restarts on crash or reboot.                                                   | P0       |
| FR-102 | Each iteration of the supervisor loop SHALL: (a) read global state, (b) select the highest-priority actionable request, (c) spawn a Claude Code session with phase-appropriate `--max-turns`, (d) capture the exit code, (e) update state. | P0 |
| FR-103 | The supervisor loop SHALL write a heartbeat file (`~/.autonomous-dev/heartbeat.json`) containing the current timestamp, PID, iteration count, and active request ID at the start of every iteration. | P0 |
| FR-104 | The supervisor loop SHALL detect stale heartbeats (timestamp older than 2x the expected iteration interval) on startup and treat them as evidence of a prior crash or sleep event. | P0 |
| FR-105 | The supervisor loop SHALL maintain a crash counter. If 3 consecutive iterations exit with a non-zero code, the loop SHALL trip a circuit breaker: stop processing, write a circuit-breaker state file, and emit an alert via the configured notification channel. | P0 |
| FR-106 | The supervisor loop SHALL reset the crash counter to zero after any successful iteration (exit code 0).                                                                | P0 |
| FR-107 | The supervisor loop SHALL handle SIGTERM and SIGINT gracefully: allow the current Claude Code session to complete its current turn, then exit cleanly with state saved. | P0 |
| FR-108 | The supervisor loop SHALL use phase-aware `--max-turns` values: 50 turns for documentation phases (prd, tdd, plan, spec), 200 turns for execution phases (code, integration), configurable via settings. | P1 |
| FR-109 | The supervisor loop SHALL implement a startup lock file (`~/.autonomous-dev/daemon.lock`) with PID validation to prevent multiple instances from running concurrently.   | P0 |
| FR-110 | The supervisor loop SHALL log every iteration to a rotating log file (`~/.autonomous-dev/logs/daemon.log`) with ISO-8601 timestamps.                                    | P0 |
| FR-111 | The supervisor loop SHALL support a `--once` flag that executes a single iteration and exits, for debugging and testing.                                                | P1 |

### 6.2 State Machine

| ID     | Requirement                                                                                                                                                           | Priority |
|--------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-200 | Each request SHALL be tracked by a unique ID in the format `REQ-{YYYYMMDD}-{4-char-hex}` (e.g., `REQ-20260408-a3f1`).                                                 | P0       |
| FR-201 | Each request SHALL have a JSON state file at `{project}/.autonomous-dev/requests/{request-id}/state.json`.                                                             | P0       |
| FR-202 | The state file SHALL contain at minimum: `id`, `status` (current state), `priority`, `created_at`, `updated_at`, `phase_history` (array of state transitions with timestamps), `current_phase_metadata` (phase-specific data), `error` (if any), `cost_accrued`, `turn_count`, and `escalation_count`. | P0 |
| FR-203 | The state machine SHALL support the following ordered states: `intake` -> `prd` -> `prd_review` -> `tdd` -> `tdd_review` -> `plan` -> `plan_review` -> `spec` -> `spec_review` -> `code` -> `code_review` -> `integration` -> `deploy` -> `monitor`. | P0 |
| FR-204 | Each state SHALL define: entry conditions (what must be true to enter), exit conditions (what must be true to leave), timeout duration, maximum retry count, and escalation trigger (condition under which a human is notified). | P0 |
| FR-205 | All state file writes SHALL be atomic: write to a `.tmp` file in the same directory, then `mv` to the final path. This prevents corruption from crashes mid-write.      | P0 |
| FR-206 | Every state transition SHALL append a structured JSON event to `{project}/.autonomous-dev/requests/{request-id}/events.jsonl` as an append-only audit log.              | P0 |
| FR-207 | Each event in the log SHALL contain: `timestamp`, `event_type`, `from_state`, `to_state`, `metadata` (free-form object), and `session_id` (the Claude Code session that produced the transition). | P0 |
| FR-208 | The state machine SHALL support a `paused` meta-state that any state can transition to (e.g., when awaiting human input or when the kill switch is engaged).             | P0 |
| FR-209 | The state machine SHALL support a `failed` terminal state with a `failure_reason` field. Failed requests can be retried (reset to last checkpoint) or cancelled.         | P0 |
| FR-210 | The state machine SHALL support a `cancelled` terminal state. Transitioning to `cancelled` SHALL trigger cleanup (FR-305).                                              | P0 |
| FR-211 | The system SHALL support multiple concurrent requests in different states across one or more repositories.                                                               | P0 |
| FR-212 | State files SHALL include a `schema_version` field to support future migrations.                                                                                        | P1 |
| FR-213 | The system SHALL validate state file integrity on read. If a state file is corrupted or missing required fields, the request SHALL transition to `failed` with reason `state_corruption`. | P1 |
| FR-214 | The state machine SHALL support request dependencies: a request can declare `blocked_by: ["REQ-xxx"]` and will not advance past `intake` until the blocking request reaches a specified state. | P1 |

### 6.3 Request Lifecycle

| ID     | Requirement                                                                                                                                                           | Priority |
|--------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-300 | **Intake:** The system SHALL accept requests via a CLI command (`autonomous-dev submit`) that takes a markdown file or inline text, assigns a tracking ID, validates the target repository is on the allowlist, and creates the initial state file in `intake` status. | P0 |
| FR-301 | **Pipeline Flow:** After intake, the system SHALL advance the request through each pipeline state in order. At each state, a Claude Code session is spawned with a phase-specific system prompt and the request context. | P0 |
| FR-302 | **Review Gates:** Every `_review` state SHALL evaluate the output of its preceding state against defined quality criteria. If the review passes, the request advances. If it fails, the request returns to the preceding state with review feedback (up to the configured retry limit). | P0 |
| FR-303 | **Escalation:** When a review gate fails more times than the configured retry limit, the system SHALL transition the request to `paused`, record the escalation reason, and notify the PM Lead via the configured notification channel. | P0 |
| FR-304 | **Completion:** When a request reaches `deploy`, the system SHALL create a merge notification (via configured channel) and transition to `monitor`. The `monitor` state is long-lived and handled by a separate monitoring subsystem (out of scope for this PRD). | P1 |
| FR-305 | **Cancellation:** The `autonomous-dev cancel {request-id}` command SHALL: (a) transition the request to `cancelled`, (b) delete any git worktrees created for the request, (c) delete any remote branches created for the request (with confirmation), (d) archive the state directory. | P0 |
| FR-306 | **Error Recovery:** When a session exits with a non-zero code, the system SHALL: (a) record the error in the state file, (b) increment the retry counter for the current phase, (c) if retries remain, re-enter the same state on the next iteration, (d) if retries are exhausted, escalate. | P0 |
| FR-307 | **Checkpoint:** Before spawning a Claude Code session for any phase, the system SHALL snapshot the current state as a checkpoint. On failure, the system can restore to this checkpoint rather than re-running prior phases. | P0 |
| FR-308 | **Context Window Management:** The system SHALL track approximate token usage per session. When usage exceeds 80% of the model's context window, the session SHALL be instructed to checkpoint its progress and exit cleanly so a fresh session can continue. | P0 |
| FR-309 | **Request Listing:** The `autonomous-dev list` command SHALL display all active requests with their ID, status, priority, repository, age, and cost accrued.             | P0 |
| FR-310 | **Request Detail:** The `autonomous-dev status {request-id}` command SHALL display the full state file, recent events, and any active escalation.                        | P0 |

### 6.4 Process Supervision

| ID     | Requirement                                                                                                                                                           | Priority |
|--------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-400 | The system SHALL provide a `autonomous-dev install-daemon` command that generates and installs the appropriate launchd plist (macOS) or systemd unit file (Linux).       | P0       |
| FR-401 | The launchd plist SHALL configure `KeepAlive = true`, `RunAtLoad = true`, and route stdout/stderr to `~/.autonomous-dev/logs/`.                                         | P0       |
| FR-402 | The systemd unit SHALL configure `Restart=on-failure`, `RestartSec=10`, `WantedBy=multi-user.target`, and route output to the journal.                                  | P0       |
| FR-403 | The system SHALL provide `autonomous-dev daemon start`, `autonomous-dev daemon stop`, and `autonomous-dev daemon status` commands that wrap launchctl/systemctl.          | P0       |
| FR-404 | The `daemon status` command SHALL report: running/stopped, PID, uptime, iteration count, crash count, circuit-breaker state, active request count, and cost burn for current billing period. | P0 |
| FR-405 | The system SHALL provide a `autonomous-dev kill-switch` command that: (a) writes a kill-switch flag file, (b) sends SIGTERM to the running daemon, (c) all future iterations immediately exit until the flag is cleared. | P0 |
| FR-406 | The system SHALL provide a `autonomous-dev kill-switch reset` command to clear the kill-switch flag and allow the daemon to resume.                                      | P0 |
| FR-407 | The daemon SHALL sleep for a configurable interval (default: 30 seconds) between iterations when no actionable work exists, to avoid busy-waiting.                       | P1       |
| FR-408 | The daemon SHALL implement exponential backoff (base 30s, max 15m) when consecutive iterations find no actionable work, resetting to the base interval when new work arrives. | P2 |

### 6.5 Global Resource Governance

| ID     | Requirement                                                                                                                                                           | Priority |
|--------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-500 | The system SHALL track cost per request by parsing Claude Code session cost output and recording it in the request state file.                                           | P0       |
| FR-501 | The system SHALL maintain a global cost ledger at `~/.autonomous-dev/cost-ledger.json` with daily and monthly running totals.                                            | P0       |
| FR-502 | The system SHALL enforce configurable daily and monthly cost caps. When a cap is reached, all requests SHALL be paused and the operator notified. The cap is evaluated before each iteration. | P0 |
| FR-503 | The system SHALL enforce a per-request cost cap (configurable, default: $50). Requests exceeding their cap SHALL be paused and escalated.                                | P1       |
| FR-504 | The system SHALL enforce a maximum concurrent requests cap (configurable, default: 3). New requests beyond the cap SHALL queue in `intake` status until a slot opens.     | P0       |
| FR-505 | The system SHALL detect API rate-limit responses (HTTP 429 or equivalent CLI error output) and implement exponential backoff: 30s, 60s, 120s, 240s, 480s, then pause and escalate. | P0 |
| FR-506 | The system SHALL monitor disk usage of the worktree root directory. When usage exceeds the configured threshold (default: 10 GB), new requests SHALL be blocked and the operator notified. | P1 |
| FR-507 | The system SHALL maintain a repository allowlist in configuration. Requests targeting repositories not on the allowlist SHALL be rejected at intake.                      | P0       |
| FR-508 | The system SHALL record total turn count per request and per phase. If a phase exceeds its turn budget without completing, the phase SHALL fail and follow retry/escalation logic. | P0 |

### 6.6 Configuration System

| ID     | Requirement                                                                                                                                                           | Priority |
|--------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-600 | Configuration SHALL be layered with the following precedence (highest to lowest): CLI flags -> project-level (`.claude/autonomous-dev.json`) -> global (`~/.claude/autonomous-dev.json`) -> built-in defaults. | P0 |
| FR-601 | The configuration file SHALL be JSON with the following top-level sections: `daemon`, `state_machine`, `governance`, `notifications`, `repositories`, `trust`.           | P0       |
| FR-602 | The `daemon` section SHALL include: `poll_interval_seconds`, `max_turns_by_phase` (map of phase name to turn limit), `circuit_breaker_threshold`, `heartbeat_interval_seconds`, `log_retention_days`. | P0 |
| FR-603 | The `governance` section SHALL include: `daily_cost_cap_usd`, `monthly_cost_cap_usd`, `per_request_cost_cap_usd`, `max_concurrent_requests`, `disk_usage_limit_gb`, `rate_limit_backoff_base_seconds`, `rate_limit_backoff_max_seconds`. | P0 |
| FR-604 | The `state_machine` section SHALL include: `retry_limits_by_phase` (map of phase name to max retries), `timeouts_by_phase` (map of phase name to timeout duration), `cleanup_retention_days`. | P0 |
| FR-605 | The `notifications` section SHALL include: `channels` (array of notification targets, e.g., file, webhook URL, email), `escalation_channels`, `summary_schedule`.        | P1       |
| FR-606 | The `repositories` section SHALL include: `allowlist` (array of absolute paths to allowed repositories).                                                                 | P0       |
| FR-607 | The `trust` section SHALL include: `level` (L0 through L3) controlling the degree of autonomy. L0 = human approval at every gate; L1 = human approval for PRD/TDD only; L2 = full autonomy with notifications; L3 = full autonomy, silent. | P0 |
| FR-608 | The system SHALL provide a `autonomous-dev config show` command that displays the effective merged configuration with the source of each value (default, global, project, CLI). | P1 |
| FR-609 | The system SHALL validate configuration files on load and report clear errors for invalid values, missing required fields, or schema violations.                          | P0       |
| FR-610 | The system SHALL provide a `autonomous-dev config init` command that generates a commented configuration file with all defaults.                                          | P1       |

### 6.7 Cleanup & Archival

| ID     | Requirement                                                                                                                                                           | Priority |
|--------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|
| FR-700 | Completed requests (in `monitor` state for longer than `cleanup_retention_days`) SHALL have their state directories archived to `~/.autonomous-dev/archive/` and their worktrees removed. | P1 |
| FR-701 | Archived requests SHALL retain their `state.json` and `events.jsonl` in compressed form (`.tar.gz`) for audit purposes. Working artifacts (generated docs, code snapshots) SHALL be deleted. | P1 |
| FR-702 | The system SHALL provide a `autonomous-dev cleanup` command to trigger manual cleanup of completed/cancelled requests.                                                   | P1       |
| FR-703 | The system SHALL provide a `autonomous-dev cleanup --dry-run` flag that lists what would be cleaned without taking action.                                                | P1       |

---

## 7. Non-Functional Requirements

| ID      | Requirement                                                                                                              | Priority |
|---------|--------------------------------------------------------------------------------------------------------------------------|----------|
| NFR-01  | **Durability:** No request state SHALL be lost due to a crash, power loss, or unexpected process termination. Atomic writes and append-only logs ensure this. | P0 |
| NFR-02  | **Idempotency:** Re-entering a state after a crash SHALL produce the same outcome as entering it for the first time. All phase executions must be idempotent or detect prior partial work. | P0 |
| NFR-03  | **Startup Time:** The supervisor loop SHALL initialize and be ready to process the first request within 5 seconds of launch. | P1 |
| NFR-04  | **Observability:** All significant events (state transitions, errors, escalations, cost updates, circuit-breaker trips) SHALL be logged in structured JSON format. | P0 |
| NFR-05  | **Security:** The system SHALL never execute code in repositories not on the allowlist. State files SHALL not contain API keys or secrets. Configuration files with sensitive values (webhook URLs) SHALL warn if world-readable. | P0 |
| NFR-06  | **Portability:** The supervisor loop SHALL run on macOS (13+) and Linux (Ubuntu 22.04+, RHEL 9+). The only hard dependencies are `bash`, `claude` CLI, `jq`, and `git`. | P0 |
| NFR-07  | **Backward Compatibility:** State file schema changes SHALL be accompanied by a migration script. The system SHALL refuse to operate on state files with an unrecognized `schema_version` rather than silently corrupting them. | P1 |
| NFR-08  | **Resource Efficiency:** The idle daemon (no actionable work) SHALL consume less than 1 MB of RAM and negligible CPU.       | P1       |
| NFR-09  | **Testability:** All state machine logic SHALL be implemented as pure functions (state + event -> new state) testable without spawning Claude Code sessions. | P0 |
| NFR-10  | **Graceful Degradation:** If the cost ledger, heartbeat file, or configuration file is missing or corrupted, the system SHALL refuse to process new work (safe default) rather than proceeding with incorrect assumptions. | P0 |

---

## 8. Success Metrics

| Metric                             | Target (MVP)        | Target (Full)        | Measurement Method                                       |
|------------------------------------|---------------------|----------------------|----------------------------------------------------------|
| Requests completed per week        | 3                   | 10+                  | Count of requests reaching `deploy` state per 7-day window from event logs. |
| Median cycle time (intake to deploy) | 48 hours           | 24 hours             | Median delta between `intake` entry timestamp and `deploy` entry timestamp. |
| Escalation rate                    | < 40%               | < 15%                | Percentage of requests that enter `paused` due to escalation, out of total requests started. |
| Cost per completed request         | < $30               | < $15                | Total `cost_accrued` for requests reaching `deploy`, from state files.      |
| System uptime                      | 95%                 | 99.5%                | Percentage of time the daemon heartbeat is current (not stale) over a 30-day window. |
| Context window exhaustion rate     | < 20% of sessions   | < 5% of sessions     | Ratio of sessions terminated due to context exhaustion vs. total sessions spawned, from daemon logs. |
| Crash recovery time                | < 5 minutes         | < 1 minute           | Time from crash detection (stale heartbeat) to first successful iteration post-crash. |
| State corruption incidents         | 0 per month         | 0 per month          | Count of `state_corruption` failure reasons in event logs. |

---

## 9. Risks & Mitigations

| ID   | Risk                                                                                             | Likelihood | Impact | Mitigation                                                                                                              |
|------|--------------------------------------------------------------------------------------------------|------------|--------|-------------------------------------------------------------------------------------------------------------------------|
| R-1  | Claude Code CLI changes its output format or flags, breaking the supervisor loop's parsing.       | High       | High   | Pin to a known CLI version. Implement a version-check on startup. Abstract all CLI interactions behind a thin wrapper that can be updated in one place. |
| R-2  | Cost runaway --- a pathological request enters a retry loop and burns through the budget.          | Medium     | High   | Per-request cost cap (FR-503), phase turn budgets (FR-508), and global daily cap (FR-502) provide three independent circuit breakers. |
| R-3  | State file corruption from concurrent writes (two daemon instances or a race condition).           | Low        | High   | Lock file prevents dual instances (FR-109). Atomic writes prevent partial-write corruption (FR-205). State validation on read catches any residual issues (FR-213). |
| R-4  | Context window exhaustion causes loss of in-flight work.                                          | High       | Medium | Checkpoint before each phase (FR-307). Context tracking with 80% threshold triggers graceful exit (FR-308). Phase-aware turn limits cap maximum consumption (FR-108). |
| R-5  | Machine sleep/wake causes the daemon to process stale work or duplicate actions.                  | Medium     | Medium | Stale heartbeat detection (FR-104). Idempotent phase execution (NFR-02). Lock file with PID validation (FR-109). |
| R-6  | API rate limits cause cascading failures across concurrent requests.                              | Medium     | Medium | Exponential backoff with escalation (FR-505). Rate-limit state is global, so all requests pause together rather than each independently hammering the API. |
| R-7  | Disk exhaustion from accumulated worktrees and state files.                                       | Medium     | Low    | Disk monitoring (FR-506). Automated cleanup (FR-700). Manual cleanup command (FR-702). |
| R-8  | Operator fails to notice circuit-breaker trip, system sits idle for days.                         | Medium     | Medium | Multiple notification channels (FR-605). `daemon status` command gives clear visibility (FR-404). Consider adding a secondary heartbeat check via cron that alerts independently. |
| R-9  | Generated PRDs trigger new PRDs in an infinite self-improvement loop.                             | Low        | Medium | Depth limit on self-generated requests (e.g., a self-generated PRD cannot itself trigger another PRD). Enforced by a `generation` counter on each request. Out of scope for this PRD but noted as an architectural constraint. |

---

## 10. Architecture Overview

```
+----------------------------------------------+
|              launchd / systemd               |
|         (restarts loop on crash)             |
+--------------------+-------------------------+
                     |
                     v
+--------------------+-------------------------+
|          Supervisor Loop (bash)              |
|  +----------------------------------------+ |
|  | 1. Acquire lock file                   | |
|  | 2. Write heartbeat                     | |
|  | 3. Load & validate config              | |
|  | 4. Check kill-switch flag              | |
|  | 5. Check cost caps                     | |
|  | 6. Select highest-priority request     | |
|  | 7. Spawn: claude --max-turns N ...     | |
|  | 8. Capture exit code                   | |
|  | 9. Update state + event log            | |
|  | 10. Update cost ledger                 | |
|  | 11. Update crash counter               | |
|  | 12. Sleep if no work / loop            | |
|  +----------------------------------------+ |
+----------------------------------------------+
         |                    |
         v                    v
+------------------+  +-------------------+
|  State Files     |  |  Cost Ledger      |
|  (per request)   |  |  (global)         |
|  state.json      |  |  cost-ledger.json |
|  events.jsonl    |  +-------------------+
+------------------+
         |
         v
+------------------+
|  Git Worktrees   |
|  (per request)   |
+------------------+
```

---

## 11. State Machine Detail

### 11.1 State Definitions

| State           | Entry Condition                                        | Exit Condition                                             | Default Timeout | Default Max Retries | Escalation Trigger                              |
|-----------------|--------------------------------------------------------|------------------------------------------------------------|-----------------|---------------------|--------------------------------------------------|
| `intake`        | Request submitted, repo on allowlist                   | Request parsed, tracking ID assigned, state file created   | 5 min           | 1                   | Parse failure after retry                        |
| `prd`           | Intake complete                                        | PRD document generated and written to branch               | 30 min          | 2                   | Generation fails after retries                   |
| `prd_review`    | PRD document exists                                    | Review passes quality criteria                             | 20 min          | 3                   | 3 consecutive review failures                    |
| `tdd`           | PRD approved                                           | TDD document generated                                     | 45 min          | 2                   | Generation fails after retries                   |
| `tdd_review`    | TDD document exists                                    | Review passes quality criteria                             | 20 min          | 3                   | 3 consecutive review failures                    |
| `plan`          | TDD approved                                           | Implementation plan generated                              | 30 min          | 2                   | Generation fails after retries                   |
| `plan_review`   | Plan document exists                                   | Review passes quality criteria                             | 20 min          | 3                   | 3 consecutive review failures                    |
| `spec`          | Plan approved                                          | Implementation spec generated                              | 45 min          | 2                   | Generation fails after retries                   |
| `spec_review`   | Spec document exists                                   | Review passes quality criteria                             | 20 min          | 3                   | 3 consecutive review failures                    |
| `code`          | Spec approved                                          | All code written, linting passes, unit tests pass          | 120 min         | 3                   | Tests fail after retries, lint unfixable          |
| `code_review`   | Code complete, tests passing                           | Review passes quality criteria                             | 30 min          | 3                   | 3 consecutive review failures                    |
| `integration`   | Code review approved                                   | Integration tests pass, PR created                         | 60 min          | 2                   | Integration test failures after retries           |
| `deploy`        | Integration complete, PR merged (or auto-merged)       | Deployment confirmed                                       | 30 min          | 2                   | Deployment failure after retries                  |
| `monitor`       | Deployment confirmed                                   | (Long-lived) Error rate below threshold for retention period | Indefinite     | N/A                 | Error rate exceeds threshold in production        |

### 11.2 Meta-States

| Meta-State   | Meaning                                                                                  |
|--------------|------------------------------------------------------------------------------------------|
| `paused`     | Request is waiting for external input (human review, kill-switch, cost cap reached). Stores `paused_reason` and `resume_condition`. |
| `failed`     | Terminal failure. Stores `failure_reason`. Can be retried (`autonomous-dev retry {id}`) or cancelled. |
| `cancelled`  | Terminal. Cleanup has been performed. Immutable.                                          |

### 11.3 State Transition Rules

- Forward transitions follow the ordered state list strictly. No state may be skipped.
- Backward transitions are allowed only from `_review` states to their preceding generation state (e.g., `prd_review` -> `prd`).
- Any state may transition to `paused`, `failed`, or `cancelled`.
- `paused` may transition back to the state it was paused from.
- `failed` may transition to the state stored in `last_checkpoint` (via retry) or to `cancelled`.
- `cancelled` is terminal. No transitions out.

---

## 12. Phasing

### Phase 1: MVP (Weeks 1-3)

**Goal:** A working daemon that can receive a request, advance it through the state machine, and survive crashes.

| Component                  | Scope                                                                                    |
|----------------------------|------------------------------------------------------------------------------------------|
| Supervisor loop            | Bash loop with heartbeat, crash counter, circuit breaker, SIGTERM handling, lock file.    |
| State machine              | Full state set, atomic writes, event log. Single-request only (no concurrency).           |
| Request lifecycle          | `submit`, `cancel`, `list`, `status` commands. Checkpoint and recovery on crash.          |
| Process supervision        | `install-daemon` for macOS (launchd) only. `daemon start/stop/status`.                   |
| Resource governance        | Daily cost cap, per-request cost cap, turn budgets. No disk monitoring.                   |
| Configuration              | Global config file with defaults. No project-level or CLI overrides.                      |
| Kill switch                | `kill-switch` and `kill-switch reset` commands.                                           |
| Trust level                | L0 only (human approval at every gate).                                                   |

**Exit Criteria:** A request can be submitted, the daemon processes it through at least `intake -> prd -> prd_review` (with a stub reviewer), the system survives a `kill -9` of the Claude Code process and resumes correctly, and cost is tracked.

### Phase 2: Full (Weeks 4-8)

**Goal:** Production-grade system supporting concurrency, Linux, all governance features, and self-improvement loop readiness.

| Component                  | Scope                                                                                    |
|----------------------------|------------------------------------------------------------------------------------------|
| Supervisor loop            | Phase-aware turn limits, exponential idle backoff, `--once` debug mode.                   |
| State machine              | Concurrent requests, request priorities, request dependencies, schema versioning.          |
| Request lifecycle          | Context window management, PR review comment pickup, deployment notification.              |
| Process supervision        | Linux (systemd) support. Independent heartbeat monitoring via cron.                       |
| Resource governance        | Monthly cost caps, disk monitoring, rate-limit backoff, concurrent request cap enforcement. |
| Configuration              | Full layered config (global + project + CLI). `config show`, `config init` commands.      |
| Cleanup & archival         | Automated retention-based cleanup, manual cleanup command with dry-run.                   |
| Trust levels               | L0 through L3 fully implemented.                                                          |
| Dry-run mode               | `--dry-run` flag on the daemon and individual commands.                                   |

**Exit Criteria:** 3+ concurrent requests across 2 repositories processed successfully. System runs unattended for 7 days with no state corruption. Cost caps enforced correctly. Linux and macOS both validated.

---

## 13. Open Questions

| ID   | Question                                                                                                                               | Owner       | Status |
|------|----------------------------------------------------------------------------------------------------------------------------------------|-------------|--------|
| OQ-1 | How should the system handle Claude Code CLI version upgrades mid-flight? Should it pin a version or attempt graceful adaptation?        | System Operator | Open |
| OQ-2 | Should the event log (`events.jsonl`) be append-only forever, or should it rotate/compact? If so, what retention policy?                 | System Operator | Open |
| OQ-3 | What is the right default trust level for initial deployment? L0 is safest but creates the most human overhead.                          | PM Lead     | Open   |
| OQ-4 | Should the system support request templates (pre-filled fields, default priorities, target repos) to reduce intake friction?              | PM Lead     | Open   |
| OQ-5 | How should the self-improvement loop (system generates its own PRDs) be bounded to prevent infinite recursion?                           | PM Lead     | Open   |
| OQ-6 | Should the daemon support webhooks for real-time event streaming (e.g., to a Slack bot or dashboard), or is polling the state files sufficient? | System Operator | Open |
| OQ-7 | What mechanism should be used for context window token counting? Claude Code does not expose token counts directly. Should we estimate from character count, or parse usage from API response metadata? | System Operator | Open |
| OQ-8 | Should the system support "warm" handoff between sessions --- passing a summary document from the ending session to the next --- or is checkpoint-and-restart from state files sufficient? | PM Lead | Open |
| OQ-9 | How should the priority system interact with cost caps? Should high-priority requests be exempt from per-request cost caps?               | PM Lead     | Open   |
| OQ-10| What is the minimum viable notification channel for MVP? File-based alerts? macOS notifications? Webhook?                                | System Operator | Open |

---

## Appendix A: Example State File

```json
{
  "schema_version": 1,
  "id": "REQ-20260408-a3f1",
  "status": "prd_review",
  "priority": 1,
  "title": "Add dark mode support to dashboard",
  "repository": "/Users/pwatson/codebase/dashboard-app",
  "branch": "autonomous/REQ-20260408-a3f1",
  "created_at": "2026-04-08T09:15:00Z",
  "updated_at": "2026-04-08T10:42:00Z",
  "cost_accrued_usd": 2.47,
  "turn_count": 38,
  "escalation_count": 0,
  "blocked_by": [],
  "phase_history": [
    {
      "state": "intake",
      "entered_at": "2026-04-08T09:15:00Z",
      "exited_at": "2026-04-08T09:16:12Z",
      "session_id": "sess_abc123",
      "turns_used": 3,
      "cost_usd": 0.12
    },
    {
      "state": "prd",
      "entered_at": "2026-04-08T09:16:12Z",
      "exited_at": "2026-04-08T10:05:30Z",
      "session_id": "sess_def456",
      "turns_used": 28,
      "cost_usd": 1.85,
      "retry_count": 0
    },
    {
      "state": "prd_review",
      "entered_at": "2026-04-08T10:05:30Z",
      "exited_at": null,
      "session_id": "sess_ghi789",
      "turns_used": 7,
      "cost_usd": 0.50,
      "retry_count": 0
    }
  ],
  "current_phase_metadata": {
    "review_criteria": "completeness, feasibility, clarity",
    "artifacts": ["docs/prd/PRD-dark-mode.md"]
  },
  "error": null,
  "last_checkpoint": "prd"
}
```

## Appendix B: Example Event Log Entry

```json
{"timestamp":"2026-04-08T10:05:30Z","event_type":"state_transition","from_state":"prd","to_state":"prd_review","session_id":"sess_def456","metadata":{"artifact":"docs/prd/PRD-dark-mode.md","turns_used":28,"cost_usd":1.85}}
{"timestamp":"2026-04-08T10:42:00Z","event_type":"review_pass","from_state":"prd_review","to_state":"tdd","session_id":"sess_ghi789","metadata":{"score":0.87,"criteria_met":["completeness","feasibility","clarity"]}}
```

## Appendix C: Example Configuration File

```json
{
  "daemon": {
    "poll_interval_seconds": 30,
    "heartbeat_interval_seconds": 30,
    "circuit_breaker_threshold": 3,
    "log_retention_days": 30,
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
    "cleanup_retention_days": 30
  },
  "governance": {
    "daily_cost_cap_usd": 100,
    "monthly_cost_cap_usd": 2000,
    "per_request_cost_cap_usd": 50,
    "max_concurrent_requests": 3,
    "disk_usage_limit_gb": 10,
    "rate_limit_backoff_base_seconds": 30,
    "rate_limit_backoff_max_seconds": 900
  },
  "notifications": {
    "channels": [
      {"type": "file", "path": "~/.autonomous-dev/notifications.log"},
      {"type": "webhook", "url": "https://hooks.slack.com/services/T.../B.../..."}
    ],
    "escalation_channels": ["webhook"],
    "summary_schedule": "daily"
  },
  "repositories": {
    "allowlist": [
      "/Users/pwatson/codebase/dashboard-app",
      "/Users/pwatson/codebase/api-service"
    ]
  },
  "trust": {
    "level": "L2"
  }
}
```

---

*End of PRD-001: System Core & Daemon Engine*
