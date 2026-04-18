# PRD-003: Agent Factory & Self-Improvement

| Field       | Value                                                           |
|-------------|-----------------------------------------------------------------|
| **Title**   | Agent Factory & Self-Improvement                                |
| **Version** | 0.1.0                                                           |
| **Date**    | 2026-04-08                                                      |
| **Author**  | Patrick Watson                                                  |
| **Status**  | Draft                                                           |
| **Plugin**  | autonomous-dev                                                  |
| **Depends** | PRD-001 (Core Architecture), PRD-002 (Pipeline & Orchestration) |

---

## 1. Problem Statement

The autonomous-dev system relies on specialized AI agents to produce artifacts across every stage of the development lifecycle — from writing PRDs to generating code to reviewing architecture. Today, those agents do not exist. There is no catalog of agents, no framework for measuring whether an agent is performing well, no mechanism for improving underperformers, and no way to create new agents when the system encounters unfamiliar domains.

Without the Agent Factory, the system is static: it ships with whatever agents the developers hand-wrote, and those agents never get better. Worse, there is no visibility into agent quality — operators cannot tell whether the PRD-writing agent is producing excellent output or subtly degrading over time.

The Agent Factory addresses this by providing:
- A curated catalog of foundation agents available from day one.
- A metrics and observability layer that tracks every agent invocation.
- A controlled improvement lifecycle that proposes, validates, and promotes agent modifications.
- A guarded mechanism for creating new specialist agents when the system encounters unfamiliar domains.
- Security and integrity guarantees that prevent privilege escalation, runtime tampering, and unauditable changes.

**This is the riskiest subsystem in the entire autonomous-dev design.** Self-modifying AI agents introduce failure modes that do not exist in traditional software: eval gaming, cascading quality degradation, unbounded optimization targets, and supply chain risks from prompt injection. This PRD takes an explicitly conservative, phased approach — starting with observation-only (no autonomous changes) and progressing to human-approved modifications before any autonomous behavior is permitted.

---

## 2. Goals

1. **G1**: Deliver a foundation catalog of 12+ agents covering the four agent archetypes (author, executor, reviewer, specialist) so the system is useful on day one.
2. **G2**: Provide per-invocation and aggregate performance metrics for every agent, surfaced through a human-readable dashboard.
3. **G3**: Implement a controlled improvement lifecycle where every agent modification is proposed as a reviewable change, validated against historical inputs, canary-tested, and promoted only with human approval.
4. **G4**: Enable dynamic creation of new specialist agents when the system encounters domains not covered by existing agents, subject to rate limits and full validation.
5. **G5**: Guarantee agent integrity through git-backed versioning, strict tool-access declarations, and commit-gated loading.
6. **G6**: Phase the rollout so that observation-only capabilities ship first, human-approved modifications ship second, and autonomous-with-guardrails ships third (and only if Phase 2 proves safe).

## 3. Non-Goals

1. **NG1**: Fully autonomous agent creation without human approval. Phase 3 adds limited autonomy with guardrails, but "the system creates and deploys agents with zero human involvement" is explicitly out of scope for the foreseeable future.
2. **NG2**: Cross-system agent sharing. Agents are scoped to a single autonomous-dev installation. Federation, marketplace, or agent-sharing protocols are out of scope.
3. **NG3**: Real-time agent hot-swapping. Agents are versioned and promoted through a lifecycle. There is no mechanism to swap an agent mid-pipeline-run.
4. **NG4**: Agent-to-agent negotiation or emergent multi-agent collaboration beyond what the orchestrator explicitly coordinates.
5. **NG5**: Natural language "describe an agent and we build it" interface for end users. Agent creation is a system-internal capability, not a user-facing feature.
6. **NG6**: Optimizing for token cost reduction as a primary metric. Cost is tracked but the system optimizes for output quality first.
7. **NG7**: Supporting non-LLM agents (rule-based, ML model, etc.). All agents in this system are LLM-based prompt-and-tool configurations.

---

## 4. User Stories

### Operator Stories

| ID   | Story | Priority |
|------|-------|----------|
| US-01 | As a system operator, I want to see a dashboard of all agents with their current version, approval rate, average quality score, and trend direction so I can identify which agents need attention. | P0 |
| US-02 | As a system operator, I want to roll back a bad agent change with a single command (`autonomous-dev agent rollback <agent-name>`) and have the previous version restored from git history. | P0 |
| US-03 | As a system operator, I want to receive an alert when an agent's approval rate drops below a configurable threshold so I can investigate before quality degrades further. | P0 |
| US-04 | As a system operator, I want to view the full version history of any agent, including who (human or system) authored each change and why, so I have a complete audit trail. | P1 |
| US-05 | As a system operator, I want to freeze an agent at its current version, preventing any automated modifications, when I need stability for a critical project. | P1 |
| US-06 | As a system operator, I want to manually trigger an A/B comparison between two agent versions on a set of historical inputs so I can evaluate a proposed change before committing to it. | P1 |

### Product Manager Stories

| ID   | Story | Priority |
|------|-------|----------|
| US-07 | As a PM, I want confidence that agent improvements will not degrade output quality, which means every proposed modification must be validated against historical inputs before I am asked to review it. | P0 |
| US-08 | As a PM, I want to review proposed agent modifications as a diff (old prompt vs. new prompt) alongside blind-scored comparison results so I can make an informed approval decision. | P0 |
| US-09 | As a PM, I want to see per-domain performance breakdowns (e.g., "this agent scores 4.2/5 on Python projects but 2.8/5 on Rust projects") so I understand where specialists are needed. | P1 |
| US-10 | As a PM, I want the system to explain, in plain language, why it is proposing a specific agent modification, referencing the data that motivated the change. | P1 |

### System Stories

| ID   | Story | Priority |
|------|-------|----------|
| US-11 | As the system, when I encounter a task in a domain where no existing agent has relevant expertise (e.g., "build a Rust WebAssembly module"), I want to flag the gap, propose a new specialist agent definition, and queue it for human review. | P1 |
| US-12 | As the system, after collecting 10+ invocations for an agent, I want to automatically analyze its performance and identify specific, actionable weaknesses (e.g., "consistently scores low on security requirements in PRDs"). | P1 |
| US-13 | As the system, I want to run a proposed agent modification against 3 historical inputs alongside the current agent, blind-score both outputs, and present the comparison to a human reviewer. | P1 |
| US-14 | As the system, when a new agent is created, I want to run it through the full validation pipeline (historical input test, canary period, human approval) before it becomes available for production use. | P1 |
| US-15 | As the system, I want to detect when an agent's output quality is declining over successive invocations (not just a single bad run) and escalate to the operator before the degradation compounds through the pipeline. | P0 |

### Security Stories

| ID   | Story | Priority |
|------|-------|----------|
| US-16 | As a security reviewer, I want assurance that no agent can modify its own tool-access permissions or escalate its privileges, even if instructed to do so via prompt injection in its input. | P0 |
| US-17 | As a security reviewer, I want every agent file to be loaded only from a committed git state, so runtime modifications to agent files are impossible. | P0 |
| US-18 | As a security reviewer, I want a designated meta-reviewer agent to audit every proposed agent modification for privilege escalation, scope creep, and prompt injection vectors before it reaches human review. | P1 |

### Developer Stories

| ID   | Story | Priority |
|------|-------|----------|
| US-19 | As a developer extending the system, I want a well-documented agent definition schema so I can create new agents by writing a markdown file with YAML frontmatter. | P0 |
| US-20 | As a developer, I want the agent catalog to be discoverable via CLI (`autonomous-dev agent list`, `autonomous-dev agent inspect <name>`) so I can understand what agents are available and how they are configured. | P1 |

---

## 5. Foundation Agent Catalog

The system ships with a curated catalog of agents organized into four archetypes. Each agent is defined as a `.md` file in the `agents/` directory with YAML frontmatter specifying its configuration.

### 5.1 Agent Definition Schema

Every agent file follows this structure:

```yaml
---
name: prd-author
version: 1.0.0
role: author
expertise:
  - product-requirements
  - user-story-writing
  - stakeholder-analysis
description: >
  Writes Product Requirements Documents from product direction input.
  Focuses on user stories, functional requirements, and success metrics.
model: claude-sonnet
turn_limit: 25
tools:
  - Read
  - Glob
  - Grep
  - WebSearch
evaluation_rubric:
  completeness: "All required PRD sections present and substantive"
  clarity: "Requirements are unambiguous and testable"
  user_focus: "User stories are specific, measurable, and prioritized"
  feasibility: "Technical constraints acknowledged without over-specifying solutions"
version_history:
  - version: 1.0.0
    date: 2026-04-08
    author: system
    change: "Initial release"
---

[Agent system prompt and instructions follow in the markdown body]
```

### 5.2 Foundation Agents

#### Authors

| Agent | Role | Expertise | Model | Turn Limit |
|-------|------|-----------|-------|------------|
| `prd-author` | Author | Product requirements, user stories, market analysis | claude-sonnet | 25 |
| `tdd-author` | Author | Technical design, architecture decisions, API contracts | claude-sonnet | 30 |
| `plan-author` | Author | Implementation planning, task decomposition, dependency analysis | claude-sonnet | 20 |
| `spec-author` | Author | Detailed implementation specs, acceptance criteria, edge cases | claude-sonnet | 25 |

#### Executors

| Agent | Role | Expertise | Model | Turn Limit |
|-------|------|-----------|-------|------------|
| `code-executor` | Executor | Code generation, refactoring, test writing | claude-sonnet | 40 |
| `test-executor` | Executor | Test strategy, test generation, coverage analysis | claude-sonnet | 30 |
| `deploy-executor` | Executor | CI/CD configuration, infrastructure-as-code, deployment scripts | claude-sonnet | 20 |

#### Reviewers

| Agent | Role | Expertise | Model | Turn Limit |
|-------|------|-----------|-------|------------|
| `quality-reviewer` | Reviewer | Code quality, best practices, maintainability | claude-sonnet | 15 |
| `security-reviewer` | Reviewer | Security vulnerabilities, auth patterns, data handling | claude-sonnet | 15 |
| `architecture-reviewer` | Reviewer | System design, scalability, coupling analysis | claude-sonnet | 20 |
| `doc-reviewer` | Reviewer | Document quality, completeness, consistency | claude-sonnet | 15 |

#### Meta Agents

| Agent | Role | Expertise | Model | Turn Limit |
|-------|------|-----------|-------|------------|
| `agent-meta-reviewer` | Meta | Agent prompt analysis, privilege escalation detection, scope validation | claude-sonnet | 15 |
| `performance-analyst` | Meta | Metrics analysis, trend detection, improvement recommendation | claude-sonnet | 20 |

### 5.3 Tool Access Policy

Tool access is **declared in frontmatter and enforced by the runtime**. An agent cannot use a tool that is not in its `tools` list, regardless of what its prompt says. The following rules apply:

- **Authors**: `Read`, `Glob`, `Grep`, `WebSearch` (research-oriented, no file modification)
- **Executors**: `Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash` (full development access, scoped to working directory)
- **Reviewers**: `Read`, `Glob`, `Grep` (read-only, no modification)
- **Meta agents**: `Read`, `Glob`, `Grep` (read-only, no modification)
- No agent has access to `git push`, credential stores, or network access beyond `WebSearch`.

---

## 6. Functional Requirements

### 6.1 Agent Registry & Loading

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-01 | The system SHALL maintain an agent registry by scanning the `agents/` directory for `.md` files with valid YAML frontmatter on startup. | P0 |
| FR-02 | The system SHALL refuse to load any agent file that is not in a committed git state (i.e., has uncommitted local modifications or is untracked). | P0 |
| FR-03 | The system SHALL validate agent frontmatter against the agent definition schema and reject agents with missing required fields. | P0 |
| FR-04 | The system SHALL enforce tool access as declared in frontmatter: any tool call not in the agent's `tools` list SHALL be blocked at runtime. | P0 |
| FR-05 | The system SHALL expose a CLI command `autonomous-dev agent list` that displays all registered agents with name, version, role, and status. | P1 |
| FR-06 | The system SHALL expose a CLI command `autonomous-dev agent inspect <name>` that displays the full configuration and recent performance metrics for an agent. | P1 |

### 6.2 Agent Performance Metrics

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-07 | The system SHALL record the following data for every agent invocation: agent name, agent version, input hash (SHA-256 of the input content), output quality score (from reviewer), review iteration count, time to approval (wall clock), token consumption (input + output), timestamp, pipeline run ID. | P0 |
| FR-08 | The system SHALL compute and store the following aggregate metrics per agent, updated after each invocation: approval rate (approved on first submission / total submissions), average quality score (rolling 30-day window), trend direction (improving, stable, declining based on linear regression over last 20 invocations), domain-specific breakdown (metrics segmented by detected project domain). | P0 |
| FR-09 | The system SHALL detect anomalies and raise alerts when: approval rate drops below a configurable threshold (default: 70%), average quality score declines by more than 0.5 points over a 10-invocation window, review iteration count exceeds the agent's historical 95th percentile for 3 consecutive invocations, escalation rate (human intervention required) exceeds a configurable threshold (default: 30%). | P0 |
| FR-10 | The system SHALL persist all metrics to a local SQLite database at `data/agent-metrics.db`, with retention of at least 90 days of per-invocation records. | P1 |
| FR-11 | The system SHALL expose a CLI command `autonomous-dev agent metrics <name>` that displays current metrics, trend, and any active alerts for an agent. | P1 |
| FR-12 | The system SHALL expose a CLI command `autonomous-dev agent dashboard` that displays a summary table of all agents ranked by approval rate, with trend indicators. | P1 |

### 6.3 Agent Improvement Lifecycle

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-13 | The system SHALL NOT propose any modification to an agent until it has recorded at least 10 invocations (the observation threshold). This threshold SHALL be configurable. | P0 |
| FR-14 | **Observation phase**: After 10+ invocations, the `performance-analyst` agent SHALL analyze the agent's metrics and produce a structured weakness report identifying specific, actionable deficiencies with supporting data (e.g., "scores 2.1/5 on 'security considerations' rubric dimension across 8 of 12 invocations involving authentication flows"). | P1 |
| FR-15 | **Proposal phase**: If the weakness report identifies actionable improvements, the system SHALL generate a proposed modification to the agent's prompt or configuration and present it as a git diff. | P1 |
| FR-16 | **Validation phase**: The system SHALL run the proposed agent modification against a minimum of 3 historical inputs (selected to cover the identified weakness), run the current agent on the same inputs, have both outputs blind-scored by the `doc-reviewer` or `quality-reviewer` agent (as appropriate), and present a comparison report showing per-input scores for both agent versions. | P1 |
| FR-17 | **Canary phase**: If validation scores favor the proposed agent, the system SHALL enter a canary period (default: 7 days) during which both the current and proposed agent versions are run on all new inputs. Outputs from both are scored. The human operator is presented a weekly comparison summary. | P2 |
| FR-18 | **Promotion phase**: The system SHALL promote the proposed agent to production ONLY after explicit human approval via `autonomous-dev agent promote <name> <version>`. Promotion creates a git commit with a descriptive message including the performance data that motivated the change. | P1 |
| FR-19 | **Rollback**: The system SHALL support `autonomous-dev agent rollback <name>` which reverts the agent file to its previous committed version via `git revert`, restoring the prior agent in one command. | P0 |
| FR-20 | The system SHALL archive all agent versions in git history. No agent version is ever deleted; all are recoverable via `git log` and `git checkout`. | P0 |

### 6.4 Dynamic Agent Creation

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-21 | The system SHALL detect domain gaps when a task is assigned and no existing agent's `expertise` field matches the task's domain tags with a confidence above 0.6 (using semantic similarity against the expertise list). | P1 |
| FR-22 | When a domain gap is detected, the system SHALL log the gap, generate a proposed new agent definition based on: the detected domain, best practices research (via `WebSearch`), and structural patterns from existing agents in the same archetype. | P1 |
| FR-23 | Newly created agents SHALL go through the full validation pipeline (FR-16 through FR-18) before becoming available for production use. Until validated, the fallback behavior is to use the closest-matching existing agent with a warning logged. | P1 |
| FR-24 | The system SHALL enforce a hard rate limit of maximum 1 new agent creation per calendar week and maximum 1 modification per agent per calendar week. These limits SHALL be configurable. | P0 |
| FR-25 | Every new agent definition SHALL be committed to git with a commit message following the pattern: `feat(agents): create <agent-name> v1.0.0 — <one-line rationale>`. | P0 |
| FR-26 | The system SHALL maintain a gap log at `data/domain-gaps.json` recording every detected domain gap, whether an agent was proposed, and the outcome (approved, rejected, pending). | P1 |

### 6.5 Agent Versioning

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-27 | Agents SHALL use semantic versioning: major version for fundamental role or expertise changes, minor version for prompt improvements and new instructions, patch version for formatting and typo fixes. | P0 |
| FR-28 | The `version_history` field in agent frontmatter SHALL be updated with every version change, recording: version number, date, author (human or system), one-line change description. | P0 |
| FR-29 | The system SHALL track agent compatibility: which versions of cooperating agents (e.g., `prd-author` v1.2.0 and `doc-reviewer` v1.1.0) have been validated together, stored in `data/agent-compatibility.json`. | P2 |
| FR-30 | When promoting a new agent version, the system SHALL verify that it has been tested with the current versions of its upstream and downstream agents in the pipeline. | P2 |

### 6.6 Agent Integrity & Security

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-31 | The system SHALL compute a SHA-256 hash of each agent file at load time and compare it against the committed version. Any mismatch SHALL prevent the agent from loading and raise a security alert. | P0 |
| FR-32 | The `agent-meta-reviewer` SHALL review every proposed agent modification (both human-authored and system-generated) before it enters validation, checking for: tool access escalation (new tools added), scope creep (expertise expanded beyond the change rationale), prompt injection vectors (instructions that could be manipulated by input content), and compliance with the agent definition schema. | P1 |
| FR-33 | No agent SHALL be able to modify files in the `agents/` directory. Agent modifications are performed exclusively by the Agent Factory subsystem under human-approved workflows. | P0 |
| FR-34 | The system SHALL log all agent file access, modifications, and promotions to an append-only audit log at `data/agent-audit.log`. | P1 |
| FR-35 | The system SHALL reject any agent definition where the `tools` list contains tools not in the approved tool allowlist for that agent's `role`. | P0 |

---

## 7. Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-01 | Agent loading (registry scan, validation, hash check) SHALL complete in under 2 seconds for a catalog of up to 50 agents. | P1 |
| NFR-02 | Per-invocation metrics recording SHALL add no more than 100ms of latency to agent execution. | P1 |
| NFR-03 | The metrics database SHALL support at least 100,000 invocation records without query degradation (queries return in under 500ms). | P1 |
| NFR-04 | All agent files, metrics databases, audit logs, and configuration SHALL be stored locally with no external service dependencies. | P0 |
| NFR-05 | The agent improvement lifecycle (observation through proposal) SHALL be fully auditable: every decision the system makes SHALL reference the specific metrics that motivated it. | P0 |
| NFR-06 | The system SHALL gracefully degrade if the metrics database is unavailable: agents continue to function, metrics are buffered in memory and flushed when the database recovers. | P1 |
| NFR-07 | Agent definitions SHALL be human-readable markdown files that can be understood, reviewed, and modified by a person with no knowledge of the Agent Factory internals. | P0 |
| NFR-08 | The validation phase (FR-16) SHALL complete within 30 minutes for a 3-input comparison, assuming typical LLM response times. | P2 |

---

## 8. Success Metrics

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| Foundation agent coverage | 12+ agents across all 4 archetypes at launch | Count of agents in `agents/` directory |
| Metrics collection reliability | 99.5%+ of invocations have complete metrics recorded | `COUNT(complete_records) / COUNT(total_invocations)` in metrics DB |
| Anomaly detection latency | Alerts raised within 1 invocation of threshold breach | Time between threshold-crossing invocation and alert emission |
| Improvement proposal quality | 70%+ of proposed modifications show improvement in blind validation | `COUNT(proposed_wins_validation) / COUNT(proposals_generated)` |
| Rollback execution time | Under 30 seconds from command to restored agent | Wall clock measurement of `agent rollback` command |
| False positive alert rate | Under 15% of anomaly alerts are false positives (agent was actually fine) | Human review of alert accuracy over 90-day window |
| Agent modification cycle time | Median time from weakness identified to promotion decision under 14 days | Timestamp delta in agent audit log |
| Operator trust score | 80%+ of operators report confidence in agent quality visibility (quarterly survey) | Quarterly operator survey |

---

## 9. Risks & Mitigations

This section is intentionally extensive. The Agent Factory is the highest-risk subsystem in the autonomous-dev architecture. Each risk is rated by likelihood (L) and impact (I) on a 1-5 scale, with a composite risk score (L x I).

### 9.1 Eval Gaming (Risk Score: 20 -- Critical)

**Risk**: AI agents evaluating AI-generated agents will optimize for eval criteria rather than actual quality. The improvement lifecycle uses LLM-based reviewers to score agent outputs. Over time, proposed agent modifications will learn to produce outputs that score well on the rubric without genuinely improving quality. This is "teaching to the test" -- the agent gets better at looking good to the reviewer, not at being good.

**Likelihood**: 5 (near-certain over enough iterations)
**Impact**: 4 (undermines the entire improvement lifecycle)

**Mitigations**:
1. **Human-in-the-loop scoring**: Phase 1 and Phase 2 require human approval of every promotion. The system presents blind comparisons, but the human makes the final call. Automated scoring is advisory, not decisive.
2. **Rubric rotation**: Evaluation rubrics are periodically updated (quarterly at minimum) by human operators to prevent overfitting to static criteria.
3. **External validation**: Periodically (configurable, default monthly), a random sample of agent outputs is presented to human reviewers for independent scoring. Divergence between automated scores and human scores triggers a calibration review.
4. **Diverse evaluation**: Outputs are scored by multiple reviewer agents (quality + domain-specific) to reduce single-point-of-failure in evaluation.
5. **Improvement velocity cap**: Maximum 1 modification per agent per week prevents rapid iterative overfitting.

### 9.2 Cascading Quality Degradation (Risk Score: 20 -- Critical)

**Risk**: A subtly degraded agent produces slightly worse outputs. These outputs feed into downstream agents, which produce slightly worse outputs in turn. The degradation is invisible at any single step but compounds through the pipeline. By the time it is detected, multiple pipeline stages are affected.

**Likelihood**: 4 (likely without monitoring)
**Impact**: 5 (can corrupt entire pipeline output)

**Mitigations**:
1. **End-to-end quality tracking**: Track quality scores not just per-agent but per-pipeline-run. If pipeline-level quality drops, investigate all agents in the chain, not just the one with the lowest individual score.
2. **Input quality gating**: Each agent validates the quality of its input before processing. If the input from an upstream agent is below threshold, the agent refuses to proceed and escalates.
3. **Trend detection with lookback**: Anomaly detection uses a rolling window, not just point-in-time comparison. A slow decline over 20 invocations triggers an alert even if no single invocation crosses a threshold.
4. **Pipeline-level canary**: When any agent in a pipeline is modified, the entire pipeline is re-run on a historical end-to-end test case to verify no regression in final output quality.
5. **Blast radius limits**: Agent modifications are promoted one at a time. Never modify two agents in the same pipeline simultaneously.

### 9.3 Unbounded State Space (Risk Score: 12 -- High)

**Risk**: The definition of "good agent" depends on the input, the project, the domain, the time of day, the user's expectations, and countless other variables. There is no universal definition of agent quality. An agent that excels at Python web APIs may fail at Rust embedded systems. Aggregate metrics mask domain-specific weaknesses.

**Likelihood**: 4 (inherent to the problem)
**Impact**: 3 (misleading metrics, wrong improvement decisions)

**Mitigations**:
1. **Domain-segmented metrics**: All metrics are tracked both in aggregate and segmented by detected domain. The dashboard shows domain breakdowns by default.
2. **Domain gap detection**: When an agent consistently underperforms in a specific domain (3+ below-threshold scores in the same domain), the system flags this as a domain gap rather than an agent deficiency.
3. **Specialist creation**: The dynamic agent creation capability (FR-21-26) allows the system to propose specialists rather than trying to make one agent good at everything.
4. **Rubric contextualization**: Evaluation rubrics include domain-aware criteria. The reviewer is given the domain context when scoring.

### 9.4 Rollback Complexity (Risk Score: 12 -- High)

**Risk**: If agent v3 was created by the improvement lifecycle using agent v2 as a base, rolling back v2 calls into question the validity of v3. Rollback is not a simple "undo" -- it has transitive implications for all downstream artifacts produced by the rolled-back agent and all agents derived from it.

**Likelihood**: 3 (occasional)
**Impact**: 4 (complex recovery, potential data integrity issues)

**Mitigations**:
1. **Rollback impact analysis**: The `agent rollback` command SHALL display all downstream implications before executing: artifacts produced by the rolled-back version, other agents modified based on this agent's outputs, and pipeline runs that used the rolled-back version.
2. **Artifact tagging**: Every artifact produced by the pipeline is tagged with the agent name and version that produced it. This enables targeted re-evaluation of suspect artifacts.
3. **Independent versioning**: Agent versions are independent. v3 is a file in git history, not a delta from v2. Rolling back v2 does not mechanically invalidate v3, though it may warrant review.
4. **Quarantine mode**: When an agent is rolled back, the system can optionally quarantine all artifacts produced by the rolled-back version for human review.

### 9.5 Supply Chain / Prompt Injection Risk (Risk Score: 15 -- High)

**Risk**: Self-modifying agents create a supply chain attack surface. If an adversary can influence the inputs that an agent processes, they may be able to inject instructions that cause the agent to produce subtly compromised outputs. If those outputs feed into the agent improvement lifecycle, the compromise propagates into the agent's definition itself -- a persistent backdoor in the agent's prompt.

**Likelihood**: 3 (requires motivated adversary or unlucky input)
**Impact**: 5 (persistent compromise of agent definitions)

**Mitigations**:
1. **Input sanitization**: All inputs to agents are sanitized to remove common prompt injection patterns before processing.
2. **Meta-reviewer gate**: The `agent-meta-reviewer` agent (FR-32) reviews every proposed agent modification for prompt injection vectors, privilege escalation, and suspicious pattern changes.
3. **Diff-based review**: Agent modifications are always presented as diffs. Humans review the actual text changes, not just the summary. Unexpected additions (especially tool access changes) are flagged.
4. **Commit-gated loading**: Agents are loaded only from committed git state. Even if an attacker modifies an agent file at runtime, the modification has no effect until committed.
5. **Tool access immutability in automation**: Automated agent modifications are PROHIBITED from changing the `tools` field. Any tool access change requires a human-authored commit.
6. **Separation of concerns**: The agent that proposes modifications is different from the agent that reviews them, which is different from the agent that executes the promotion. No single agent has end-to-end control of the modification lifecycle.

### 9.6 Evaluation Inconsistency (Risk Score: 9 -- Medium)

**Risk**: LLM-based reviewers are non-deterministic. The same output scored twice may receive different scores. This introduces noise into the metrics system, which can trigger false alarms or mask real degradation.

**Likelihood**: 3 (inherent to LLM scoring)
**Impact**: 3 (noisy metrics, false alerts, delayed detection)

**Mitigations**:
1. **Multi-score averaging**: Each output is scored by the reviewer agent 3 times (with temperature > 0), and the median score is used.
2. **Score calibration**: Monthly human calibration checks compare automated scores to human scores. Systematic bias is corrected by adjusting thresholds.
3. **Trend over point**: The system makes decisions based on trends (rolling averages over 10+ invocations), not individual scores. Single-invocation noise is smoothed out.
4. **Confidence intervals**: Metrics are reported with confidence intervals, not just point estimates. Alerts fire only when the lower bound of the confidence interval crosses the threshold.

### 9.7 Operator Alert Fatigue (Risk Score: 8 -- Medium)

**Risk**: The metrics and anomaly detection system generates too many alerts, operators start ignoring them, and a real quality degradation goes unnoticed.

**Likelihood**: 4 (common failure mode in monitoring systems)
**Impact**: 2 (delayed response to real issues)

**Mitigations**:
1. **Alert severity tiers**: Critical (blocks pipeline), Warning (logged, email), Info (dashboard only). Only Critical and Warning generate notifications.
2. **Alert deduplication**: Same alert for same agent is not re-fired until the condition resolves and recurs.
3. **Configurable thresholds**: Operators can tune alert thresholds per agent to reduce noise for agents with naturally variable performance.
4. **Alert effectiveness tracking**: Track which alerts led to human action vs. which were dismissed. Use this data to tune thresholds quarterly.

### 9.8 Resource Exhaustion from Validation (Risk Score: 6 -- Medium)

**Risk**: The validation and canary phases require running agents multiple times on historical inputs. This consumes LLM tokens and compute time. An aggressive improvement cycle could consume significant resources.

**Likelihood**: 3 (likely if rate limits are not enforced)
**Impact**: 2 (cost overrun, slow pipeline)

**Mitigations**:
1. **Rate limits**: Hard caps on modification frequency (1 per agent per week, 1 new agent per week).
2. **Token budgets**: Each validation run has a token budget. If exceeded, the validation is aborted and the proposal is deferred.
3. **Prioritized validation**: Only agents with declining metrics enter the improvement lifecycle. Stable agents are left alone.
4. **Historical input caching**: Outputs from current agents on historical inputs are cached so they do not need to be regenerated for every comparison.

---

## 10. Phasing

The Agent Factory is deployed in three phases. Each phase builds on the previous one. **Phase 3 is gated on demonstrated safety in Phase 2 and requires explicit operator opt-in.**

### Phase 1: Observation Framework (Weeks 1-4)

**Goal**: Ship the foundation agent catalog, metrics collection, and dashboarding. No automated modifications.

| Deliverable | Requirements Covered |
|-------------|---------------------|
| Foundation agent catalog (12+ agents) with validated definitions | FR-01 through FR-06 |
| Per-invocation metrics recording | FR-07 |
| Aggregate metrics computation and anomaly detection | FR-08, FR-09 |
| Metrics database and CLI commands | FR-10, FR-11, FR-12 |
| Agent integrity checks (hash verification, commit-gated loading) | FR-31, FR-33, FR-35 |
| Audit logging | FR-34 |
| Semantic versioning and version history | FR-27, FR-28 |
| Rollback command | FR-19, FR-20 |

**Phase 1 explicitly does NOT include**: Any automated agent modification, creation, or promotion. Humans modify agents manually via standard git workflows. The system observes and reports only.

**Exit criteria for Phase 1**:
- All 12 foundation agents loaded and functioning.
- Metrics collected for 50+ invocations across at least 5 agents.
- Anomaly detection validated: at least 1 true positive alert confirmed by human review.
- Zero false agent loads from uncommitted state.
- Operator feedback collected and incorporated.

### Phase 2: Human-Approved Modifications (Weeks 5-10)

**Goal**: Enable the system to propose agent modifications and new agents. All proposals require human approval.

| Deliverable | Requirements Covered |
|-------------|---------------------|
| Performance analysis and weakness identification | FR-13, FR-14 |
| Modification proposal generation | FR-15 |
| A/B validation on historical inputs | FR-16 |
| Meta-reviewer gate | FR-32 |
| Human-approved promotion workflow | FR-18 |
| Domain gap detection and new agent proposals | FR-21, FR-22, FR-23 |
| Rate limiting | FR-24 |
| Agent creation git integration | FR-25, FR-26 |

**Phase 2 explicitly does NOT include**: Any autonomous promotion. Every modification and creation requires `autonomous-dev agent promote` (a human-executed command).

**Exit criteria for Phase 2**:
- At least 5 agent modification proposals generated.
- At least 3 proposals approved and promoted by human operators.
- Zero privilege escalation attempts in proposed modifications (validated by meta-reviewer and human review).
- Improvement proposals show measurable quality improvement in 70%+ of cases.
- At least 1 new specialist agent proposed and validated.
- Operator satisfaction survey: 80%+ report confidence in the proposal quality.

### Phase 3: Autonomous with Guardrails (Weeks 11-16, gated)

**Goal**: Enable limited autonomous agent improvement with guardrails. Requires explicit operator opt-in.

| Deliverable | Requirements Covered |
|-------------|---------------------|
| Canary phase (dual-run with comparison) | FR-17 |
| Agent compatibility tracking | FR-29, FR-30 |
| Autonomous promotion for patch-level changes only (with human notification) | Extension of FR-18 |
| Full validation pipeline for new agents | Extension of FR-23 |

**Phase 3 constraints (non-negotiable)**:
- Only **patch-level** changes (formatting, typo fixes, minor clarifications) can be autonomously promoted. Minor and major changes still require human approval.
- Autonomous promotion sends a notification to the operator with the diff and comparison results. Operator can override within 24 hours.
- If any autonomous promotion leads to a quality decline detected within 48 hours, the system automatically rolls back AND disables autonomous promotion for that agent for 30 days.
- The operator can disable Phase 3 entirely with a single configuration change.
- Phase 3 is NOT enabled by default. Operators must explicitly opt in via `autonomous-dev config set agent-factory.autonomous-promotion enabled`.

**Exit criteria for Phase 3**:
- At least 10 autonomous patch promotions executed.
- Zero quality regressions from autonomous promotions.
- Auto-rollback mechanism tested and validated.
- Operator override mechanism tested.

---

## 11. Open Questions

| ID | Question | Impact | Owner |
|----|----------|--------|-------|
| OQ-01 | What is the right observation threshold (currently 10 invocations) before the system can propose improvements? Too low risks noisy proposals; too high delays improvement for infrequently-used agents. | Phase 2 scoping | Product + Engineering |
| OQ-02 | How should the system handle agents that are rarely invoked (e.g., <5 invocations per month)? The improvement lifecycle may never activate for them. Should there be a separate review cadence for low-usage agents? | Phase 2 scoping | Product |
| OQ-03 | Should the meta-reviewer agent itself be subject to the improvement lifecycle? If yes, what prevents a degraded meta-reviewer from approving bad modifications? If no, how do we ensure it stays effective? | Security model | Security + Architecture |
| OQ-04 | What is the right blind-scoring methodology? Current proposal has the reviewer agent score both outputs without knowing which is current vs. proposed. Should we use multiple reviewer agents? Should we include the rubric in the scoring prompt or keep it implicit? | Phase 2 design | Engineering |
| OQ-05 | How do we handle the cold-start problem for new specialist agents? They have no historical inputs for validation. Should we use synthetic inputs? Inputs from related domains? | Phase 2 design | Engineering |
| OQ-06 | Should agent modifications be proposed as PRs in a git workflow (enabling team review, comments, CI checks) rather than CLI-based promotion? This would align with standard software development practices. | UX design | Product + Engineering |
| OQ-07 | What model should meta agents use? Using the same model family for both the agent and its evaluator may introduce systematic blind spots. Should the meta-reviewer use a different model provider? | Architecture | Engineering + Security |
| OQ-08 | How should the system handle conflicting improvement signals (e.g., an agent scores well on completeness but poorly on conciseness -- improving one may degrade the other)? | Phase 2 design | Product |
| OQ-09 | What is the maximum total number of agents the system should support before we need to consider agent consolidation or retirement policies? | Scalability | Architecture |
| OQ-10 | Should Phase 3 autonomous promotion be limited to agents below a certain risk tier? (e.g., allow autonomous promotion of authors but never of executors who can write code) | Phase 3 scoping | Security + Product |
| OQ-11 | How do we prevent the performance-analyst agent from developing systematic biases in its weakness identification (e.g., always recommending the same type of improvement)? | Phase 2 quality | Engineering |
| OQ-12 | What happens when the system detects a domain gap but has hit the 1-agent-per-week rate limit? How should gaps be queued and prioritized? | Phase 2 design | Product |

---

## Appendix A: Glossary

| Term | Definition |
|------|-----------|
| **Agent** | A configuration combining an LLM system prompt, tool access list, model preference, and evaluation rubric, stored as a `.md` file in the `agents/` directory. |
| **Agent Factory** | The subsystem responsible for managing the lifecycle of agents: registration, metrics, improvement, creation, and security. |
| **Archetype** | One of four agent categories: Author, Executor, Reviewer, Meta. Determines default tool access and pipeline role. |
| **Blind scoring** | Evaluation method where the reviewer agent scores two outputs without knowing which was produced by the current agent vs. the proposed modification. |
| **Canary period** | A time window (default 7 days) during which both current and proposed agent versions run simultaneously, enabling side-by-side comparison. |
| **Domain gap** | A detected mismatch between a task's domain requirements and the expertise of all available agents. |
| **Foundation agent** | One of the pre-built agents shipped with the system at launch. |
| **Meta-reviewer** | A specialized agent (`agent-meta-reviewer`) that audits proposed agent modifications for security and quality concerns. |
| **Observation threshold** | The minimum number of invocations (default 10) required before the system can propose improvements to an agent. |
| **Promotion** | The act of replacing the current production version of an agent with a validated new version, committed to git. |

## Appendix B: Agent Lifecycle State Diagram

```
                    +------------------+
                    |    REGISTERED    |
                    | (loaded from git)|
                    +--------+---------+
                             |
                             v
                    +--------+---------+
                    |     ACTIVE       |
                    | (serving traffic)|
                    +--------+---------+
                             |
              +--------------+--------------+
              |                             |
              v                             v
    +---------+----------+       +----------+---------+
    |    UNDER REVIEW    |       |      FROZEN        |
    | (improvement       |       | (operator locked)  |
    |  proposed)         |       +--------------------+
    +---------+----------+
              |
              v
    +---------+----------+
    |    VALIDATING      |
    | (A/B test running) |
    +---------+----------+
              |
              v
    +---------+----------+
    |     CANARY         |
    | (dual-run period)  |
    +---------+----------+
              |
       +------+------+
       |             |
       v             v
  +----+----+   +----+-----+
  |PROMOTED |   | REJECTED |
  |(new ver)|   |(keep old)|
  +---------+   +----------+
```

## Appendix C: Related Documents

- PRD-001: Core Architecture (dependency)
- PRD-002: Pipeline & Orchestration (dependency)
- Architectural Review: Risk Assessment (input to Section 9)
