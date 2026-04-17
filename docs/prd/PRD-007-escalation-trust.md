# PRD-007: Escalation & Trust Framework

| Field       | Value                                      |
|-------------|--------------------------------------------|
| **Title**   | Escalation & Trust Framework               |
| **PRD ID**  | PRD-007                                    |
| **Version** | 1.0                                        |
| **Date**    | 2026-04-08                                 |
| **Author**  | PM Lead (autonomous-dev)                   |
| **Status**  | Draft                                      |
| **Plugin**  | autonomous-dev                             |

---

## 1. Problem Statement

Autonomous AI development systems face a fundamental tension: too much autonomy risks producing incorrect, insecure, or misaligned outputs; too little autonomy turns the system into a glorified command-line wrapper that demands constant human babysitting. Neither extreme delivers value.

Today, teams using AI-assisted development tools are stuck choosing between two bad options:

1. **Full manual approval at every step.** The human becomes the bottleneck. The system cannot work overnight, cannot parallelize across repositories, and delivers marginal productivity improvement over doing the work by hand.
2. **Uncontrolled autonomy.** The AI runs freely, but the human has no confidence in the outputs. They end up re-reviewing everything anyway, negating the time savings, or worse, they trust blindly and ship defects.

The missing piece is a **calibrated trust model** --- a framework that lets the human dial autonomy up or down based on context, track record, and risk tolerance, combined with a structured escalation system that pulls the human in only when the system genuinely cannot proceed on its own.

This trust model is the **core value proposition** of the autonomous-dev plugin. It is what separates the system from simple automation. Without it, the plugin is a pipeline. With it, the plugin is a *collaborator* that earns its autonomy.

---

## 2. Goals

| ID   | Goal                                                                                       |
|------|--------------------------------------------------------------------------------------------|
| G-1  | Establish a 4-level trust ladder (L0--L3) that governs how much autonomy the system has per request and per repository. |
| G-2  | Define a complete escalation taxonomy so every failure mode has a named type, a routing target, and a resolution protocol. |
| G-3  | Ensure escalations are communicated in structured, business-friendly language with all relevant context attached. |
| G-4  | Provide kill switches and emergency controls that allow humans to halt execution instantly at any granularity (all, per-repo, per-request). |
| G-5  | Create an append-only audit trail that records every decision, escalation, and human override for full replay and forensic analysis. |
| G-6  | Build a notification framework that keeps humans informed without causing notification fatigue. |
| G-7  | Enable the system to suggest trust-level promotions based on measured track record, while keeping the human as the final decision-maker. |

## 3. Non-Goals

| ID    | Non-Goal                                                                                  |
|-------|-------------------------------------------------------------------------------------------|
| NG-1  | Automatic trust-level promotion without human approval. The system suggests; the human decides. |
| NG-2  | Replacing human judgment for security-critical decisions. Security escalations always route to a human, regardless of trust level. |
| NG-3  | Building a general-purpose workflow engine. The escalation framework is specific to the autonomous-dev pipeline phases. |
| NG-4  | Implementing notification delivery infrastructure (e.g., running a Discord bot). The framework produces structured payloads; delivery adapters are provided by the platform layer. |
| NG-5  | Multi-tenant trust isolation. This version assumes a single team/org context. |

---

## 4. User Stories

### Trust Ladder

| ID    | Story                                                                                     | Trust Level |
|-------|-------------------------------------------------------------------------------------------|-------------|
| US-01 | As a PM Lead onboarding the system for the first time, I want to set the default trust level to L0 so I can observe every gate decision the system makes before granting more autonomy. | L0 |
| US-02 | As a PM Lead who has used the system for two weeks, I want to promote a mature repository from L0 to L1 so the system handles middle pipeline phases (design, implementation planning) autonomously while I still approve the PRD and final code. | L1 |
| US-03 | As a PM Lead who trusts the system's code-review agents, I want to set a specific repository to L2 so I only need to approve the PRD and the system handles everything else, including code review. | L2 |
| US-04 | As a PM Lead running a batch of low-risk documentation updates, I want to submit them at L3 (fully autonomous) so the system processes them overnight and I review the results in the morning via a digest notification. | L3 |
| US-05 | As a PM Lead, I want to override the trust level on a specific request mid-pipeline (e.g., downgrade from L2 to L0) because I just discovered unexpected complexity and want to review every remaining gate. | L0--L3 |
| US-06 | As a PM Lead, I want the system to suggest promoting a repository from L1 to L2 after 20 consecutive successful deliveries, so I can make an informed decision about granting more autonomy. | All |

### Escalation Handling

| ID    | Story                                                                                     | Escalation Type |
|-------|-------------------------------------------------------------------------------------------|-----------------|
| US-07 | As a PM Lead, when the system encounters ambiguous requirements in a PRD, I want it to escalate to me with a clear description of the ambiguity, the options it considered, and its recommendation, so I can make a quick decision. | Product |
| US-08 | As a tech lead, when the system cannot figure out how to implement a feature after exhausting its retry budget, I want it to escalate to me with the spec, the approaches it tried, and the specific failure points, so I can provide targeted guidance. | Technical |
| US-09 | As a system operator, when the build or test environment is broken (e.g., CI timeouts, dependency resolution failures), I want the system to escalate to me immediately with diagnostic information so I can fix the infrastructure. | Infrastructure |
| US-10 | As a security lead, when the system detects a potential security issue in the codebase during implementation or review, I want it to halt and escalate to me with the finding details, even if this blocks the pipeline. | Security |
| US-11 | As a PM Lead, when the system estimates that a request will exceed the configured cost budget, I want it to escalate before incurring the cost, showing me the projected spend and asking whether to proceed. | Cost |
| US-12 | As a PM Lead, when a review gate fails after the maximum number of retry iterations, I want the system to escalate with the original artifact, all review feedback received, and the iterations attempted, so I can decide how to proceed. | Quality |

### Emergency Controls

| ID    | Story                                                                                     |
|-------|-------------------------------------------------------------------------------------------|
| US-13 | As a PM Lead, I want to issue a `/kill` command that immediately stops all active requests across all repositories, because I discovered a systemic issue and need everything to halt. |
| US-14 | As a PM Lead, I want to cancel a single request via `/cancel {request-id}` without affecting other in-flight requests. |
| US-15 | As a PM Lead, after issuing a kill command, I want all pipeline state preserved so I can investigate what happened and decide whether to restart individual requests. |

### Notifications & Audit

| ID    | Story                                                                                     |
|-------|-------------------------------------------------------------------------------------------|
| US-16 | As a PM Lead, I want to receive a daily digest summarizing all completed requests, active escalations, and gate decisions from the last 24 hours, so I stay informed without being spammed. |
| US-17 | As a PM Lead reviewing a shipped feature, I want to replay the full decision log for a request to understand why specific design choices were made, including what alternatives the system considered and rejected. |
| US-18 | As a PM Lead, I want to configure "do not disturb" hours (e.g., 10 PM -- 7 AM) where only P0 security or infrastructure escalations break through, while everything else is batched for the morning digest. |
| US-19 | As a PM Lead, I want the system to detect cross-request patterns (e.g., 3 requests failed in the same repo in the last hour) and escalate a systemic issue alert rather than sending individual escalation notices. |

### Edge Cases

| ID    | Story                                                                                     |
|-------|-------------------------------------------------------------------------------------------|
| US-20 | As a PM Lead, when I provide guidance in response to an escalation that makes things worse (e.g., the system tries my suggestion and it fails), I want the system to re-escalate with a clear explanation that my previous guidance did not resolve the issue, rather than silently looping. |
| US-21 | As a PM Lead, I want each team or repository to be able to use a different escalation communication style (e.g., terse for experienced teams, verbose for new repos), configurable per-context. |

---

## 5. Functional Requirements

### 5.1 Trust Ladder

| ID     | Priority | Requirement                                                                              |
|--------|----------|------------------------------------------------------------------------------------------|
| FR-01  | P0       | The system SHALL support four trust levels: L0 (human approves every gate), L1 (human approves PRD and code, system handles middle phases), L2 (human approves PRD only, system handles everything else including code review), and L3 (fully autonomous with async notifications). |
| FR-02  | P0       | Each request SHALL have an explicit trust level, either inherited from the repository default or specified at submission time. |
| FR-03  | P0       | Each repository SHALL have a configurable default trust level. |
| FR-04  | P0       | The default trust level for newly registered repositories SHALL be configurable at the system level (recommended default: L1). |
| FR-05  | P0       | A human SHALL be able to change the trust level of an active request at any point during pipeline execution. The change takes effect at the next gate boundary. |
| FR-06  | P1       | The system SHALL track per-repository delivery history (success/failure, gate pass rates, escalation frequency) and use this data to compute a trust score. |
| FR-07  | P1       | When a repository's trust score exceeds the promotion threshold, the system SHALL suggest a trust-level promotion to the PM Lead, including the evidence supporting the suggestion. |
| FR-08  | P0       | Trust-level promotions SHALL only take effect after explicit human approval. |
| FR-09  | P1       | The system SHALL support trust-level demotion, both manual (human-initiated) and automatic (triggered by consecutive gate failures exceeding a configurable threshold). |
| FR-10  | P0       | At each pipeline gate, the system SHALL check the active trust level and either proceed autonomously or pause for human approval, according to the gate's trust-level matrix. |

### 5.2 Escalation Taxonomy

| ID     | Priority | Requirement                                                                              |
|--------|----------|------------------------------------------------------------------------------------------|
| FR-11  | P0       | The system SHALL classify escalations into the following types: `product`, `technical`, `infrastructure`, `security`, `cost`, and `quality`. |
| FR-12  | P0       | Each escalation type SHALL have a default routing target (e.g., product -> PM Lead, technical -> tech lead, infrastructure -> system operator, security -> security lead, cost -> PM Lead, quality -> appropriate reviewer). |
| FR-13  | P1       | The system SHALL support configurable routing overrides so that escalation types can be routed to different people or channels per repository or per team. |
| FR-14  | P0       | Security escalations SHALL always pause the pipeline immediately, regardless of trust level. |
| FR-15  | P1       | Cost escalations SHALL include a projected cost estimate and the configured budget threshold. |
| FR-16  | P0       | Quality escalations SHALL be triggered after a configurable maximum number of review-retry iterations (default: 3). |

### 5.3 Escalation Communication

| ID     | Priority | Requirement                                                                              |
|--------|----------|------------------------------------------------------------------------------------------|
| FR-17  | P0       | Every escalation message SHALL follow a structured format containing: (a) escalation type, (b) summary in business-friendly language, (c) what was attempted, (d) what failed and why, (e) options available, (f) the system's recommendation, (g) urgency level, (h) response instructions. |
| FR-18  | P0       | Escalation urgency levels SHALL be: `immediate` (blocking current work), `soon` (will block within hours), and `informational` (not blocking, awareness only). |
| FR-19  | P1       | Escalation messages SHALL include references to relevant artifacts: the document under review, review feedback, the spec that could not be implemented, error logs, or cost projections. |
| FR-20  | P1       | Escalation messages SHALL never include raw stack traces or internal error codes as the primary message. Technical details MAY be included in a collapsible "Details" section. |
| FR-21  | P1       | The system SHALL support configurable escalation verbosity per repository or per team: `terse` (summary + recommendation only), `standard` (full structured format), `verbose` (full format + detailed technical appendix). |

### 5.4 Escalation Routing

| ID     | Priority | Requirement                                                                              |
|--------|----------|------------------------------------------------------------------------------------------|
| FR-22  | P0       | The system SHALL support a default routing mode where all escalations go to the PM Lead. |
| FR-23  | P1       | The system SHALL support an advanced routing mode where each escalation type routes to a configurable target (person, channel, or both). |
| FR-24  | P1       | The system SHALL support escalation chains: if the primary routing target does not respond within a configurable timeout, the escalation routes to a secondary target. |
| FR-25  | P1       | Timeout behavior SHALL be configurable per escalation type, with the following options: (a) pause and wait indefinitely (default), (b) retry with a different approach after timeout, (c) skip and continue (for non-blocking escalations only), (d) cancel the request after extended timeout. |
| FR-26  | P2       | The system SHALL support "office hours" routing: route to Slack during business hours, route to PagerDuty for P0 escalations outside business hours. |

### 5.5 Human Response Handling

| ID     | Priority | Requirement                                                                              |
|--------|----------|------------------------------------------------------------------------------------------|
| FR-27  | P0       | When a human responds to an escalation, the system SHALL parse the response, incorporate the guidance into the appropriate pipeline phase, and resume execution from the escalation point. |
| FR-28  | P0       | The system SHALL record the human's response in the audit trail, linked to the escalation event. |
| FR-29  | P1       | For common escalation scenarios, the system SHALL present structured response options (e.g., "Approve as-is", "Retry with changes", "Cancel request", "Override and proceed") alongside a free-text input for complex guidance. |
| FR-30  | P1       | If a human's response leads to a subsequent failure in the same pipeline phase, the system SHALL re-escalate with a clear explanation that the previous guidance did not resolve the issue, including what happened when the guidance was applied. |
| FR-31  | P1       | The re-escalation message SHALL reference the previous escalation and response, so the human has full context without needing to search for it. |
| FR-32  | P2       | The system SHALL support a "delegate" response where a human can reassign an escalation to a different person (e.g., "I don't know, ask the tech lead"). |

### 5.6 Kill Switch & Emergency Controls

| ID     | Priority | Requirement                                                                              |
|--------|----------|------------------------------------------------------------------------------------------|
| FR-33  | P0       | The system SHALL support a `/kill` command that stops ALL active requests across ALL repositories. |
| FR-34  | P0       | The `/kill` command SHALL support two modes: `graceful` (finish the current atomic operation such as a commit, then stop) and `hard` (interrupt immediately, accepting potential dirty state). Default: `graceful`. |
| FR-35  | P0       | After a kill, ALL pipeline state SHALL be preserved for forensic analysis. No cleanup or rollback occurs automatically. |
| FR-36  | P0       | After a kill, the system SHALL remain in a halted state until a human explicitly re-enables it. |
| FR-37  | P0       | The system SHALL support `/cancel {request-id}` to terminate a single request without affecting other in-flight requests. |
| FR-38  | P1       | The system SHALL support `/pause` and `/resume` commands for temporarily suspending and resuming individual requests or all requests. |
| FR-39  | P1       | When a kill or cancel is issued, the system SHALL log the event with a timestamp, the issuing user, the affected requests, and the state of each request at termination. |

### 5.7 Audit Trail & Decision Log

| ID     | Priority | Requirement                                                                              |
|--------|----------|------------------------------------------------------------------------------------------|
| FR-40  | P0       | The system SHALL maintain an append-only event log (`events.jsonl`) recording every significant event: escalation raised, escalation resolved, gate decision, human override, trust-level change, kill/cancel, request start, request completion. |
| FR-41  | P0       | Each event SHALL include: event type, timestamp (ISO 8601), request ID, repository, pipeline phase, agent (if applicable), payload (type-specific structured data). |
| FR-42  | P0       | The event log SHALL be append-only. Events are never modified or deleted during the active retention period. |
| FR-43  | P1       | Every gate decision SHALL be logged with: reviewing agent, score, verdict (pass/fail), human override (if any), and the artifact version reviewed. |
| FR-44  | P1       | Every autonomous decision SHALL be logged with: what was decided, alternatives considered, confidence level, and the rationale. |
| FR-45  | P1       | The system SHALL support decision replay: given a request ID, reconstruct the full chronological sequence of decisions, escalations, and human interactions. |
| FR-46  | P2       | The event log SHALL support integrity verification (e.g., hash chaining or HMAC) to detect tampering. |
| FR-47  | P1       | Retention policy: events are kept in the active log for 90 days, then archived to cold storage. Archived events remain queryable but may have higher access latency. |

### 5.8 Notification Framework

| ID     | Priority | Requirement                                                                              |
|--------|----------|------------------------------------------------------------------------------------------|
| FR-48  | P0       | The system SHALL emit structured notification payloads for the following event types: `phase_transition`, `gate_approved`, `gate_rejected`, `escalation`, `error`, `completion`, `daily_digest`. |
| FR-49  | P0       | Notification delivery methods SHALL include: Discord embed, Slack block kit, CLI output, and file drop (JSON file to a configured directory). |
| FR-50  | P1       | Each notification type SHALL be independently configurable for delivery method and channel (e.g., escalations to Slack DM, completions to a Discord channel, digests to email). |
| FR-51  | P1       | The system SHALL support notification batching: non-urgent notifications (e.g., `phase_transition`, `gate_approved`) are batched into periodic digests (configurable interval, default: 1 hour). |
| FR-52  | P1       | The system SHALL support "Do Not Disturb" (DND) hours: during configured quiet hours, only `immediate`-urgency escalations and errors break through. All other notifications are queued for the next active period. |
| FR-53  | P1       | The system SHALL generate a daily digest summarizing: requests completed, requests in progress, escalations raised and resolved, gate pass/fail rates, and trust-level changes. |
| FR-54  | P2       | The system SHALL detect notification fatigue patterns (e.g., >20 notifications in 1 hour to the same recipient) and automatically switch to digest mode with a meta-notification: "Batching notifications due to high volume. Next digest in N minutes." |
| FR-55  | P1       | The system SHALL detect cross-request failure patterns (e.g., N failures across different requests in the same repository within a configurable time window) and emit a `systemic_issue` alert that supersedes individual escalation notifications. |

---

## 6. Non-Functional Requirements

| ID     | Priority | Requirement                                                                              |
|--------|----------|------------------------------------------------------------------------------------------|
| NFR-01 | P0       | The `/kill` command SHALL take effect within 5 seconds of being issued. |
| NFR-02 | P0       | Escalation messages SHALL be dispatched within 30 seconds of the triggering condition. |
| NFR-03 | P0       | The event log SHALL sustain a write throughput of at least 100 events per second without data loss. |
| NFR-04 | P1       | Decision replay for a single request SHALL complete within 10 seconds for requests with up to 500 events. |
| NFR-05 | P1       | The trust-level change API SHALL take effect within 1 pipeline gate boundary (no stale reads of the previous level). |
| NFR-06 | P0       | The audit trail SHALL survive process crashes: events that have been acknowledged as written must be durable. |
| NFR-07 | P1       | Notification payloads SHALL conform to a published JSON schema, versioned independently, to allow third-party delivery adapters. |
| NFR-08 | P2       | The system SHALL function correctly with up to 50 concurrent active requests across up to 20 repositories. |
| NFR-09 | P1       | All escalation and notification configurations SHALL be hot-reloadable without restarting the system or interrupting active pipelines. |
| NFR-10 | P0       | The trust framework SHALL degrade gracefully: if the notification delivery system is unavailable, escalations fall back to CLI output and file drop, and the pipeline pauses rather than proceeding without notification. |

---

## 7. Trust Level Gate Matrix

This matrix defines which pipeline gates require human approval at each trust level.

| Pipeline Gate            | L0 (Full Oversight) | L1 (Guided)       | L2 (PRD-Only)     | L3 (Autonomous)   |
|--------------------------|---------------------|--------------------|--------------------|--------------------|
| PRD Approval             | Human               | Human              | Human              | System             |
| Design Review            | Human               | System             | System             | System             |
| Implementation Plan      | Human               | System             | System             | System             |
| Code Review              | Human               | Human              | System             | System             |
| Test Validation          | Human               | System             | System             | System             |
| Deployment Approval      | Human               | Human              | System             | System             |
| Security Review          | Human               | Human              | Human              | Human*             |

\* Security reviews always require human approval at all trust levels. If a security concern is detected at L3, the system escalates and pauses.

---

## 8. Escalation Message Schema

```json
{
  "escalation_id": "esc-20260408-001",
  "type": "product | technical | infrastructure | security | cost | quality",
  "urgency": "immediate | soon | informational",
  "request_id": "req-abc-123",
  "repository": "my-org/my-repo",
  "pipeline_phase": "design_review",
  "timestamp": "2026-04-08T14:32:00Z",
  "summary": "Business-friendly 1-2 sentence summary of the issue.",
  "what_was_attempted": [
    "Description of approach 1 and its outcome.",
    "Description of approach 2 and its outcome."
  ],
  "failure_reason": "Clear explanation of why the system cannot proceed.",
  "options": [
    {
      "id": "opt-1",
      "label": "Approve the current version with noted caveats",
      "risk": "low",
      "description": "Proceed with the artifact as-is. The ambiguity is documented but unresolved."
    },
    {
      "id": "opt-2",
      "label": "Provide clarification and retry",
      "risk": "none",
      "description": "Human provides additional context; system retries the phase."
    },
    {
      "id": "opt-3",
      "label": "Cancel the request",
      "risk": "none",
      "description": "Abandon this request entirely."
    }
  ],
  "recommendation": {
    "option_id": "opt-2",
    "rationale": "The ambiguity is in a core requirement and is likely to cause downstream issues if left unresolved."
  },
  "artifacts": [
    {
      "type": "document",
      "label": "PRD v2 (under review)",
      "path": "docs/prd/PRD-042-feature-x.md",
      "version": "v2"
    },
    {
      "type": "review_feedback",
      "label": "Review feedback from design agent",
      "path": ".autonomous-dev/reviews/PRD-042-review-2.json"
    }
  ],
  "response_instructions": "Reply with the option ID (e.g., 'opt-2') or provide free-text guidance. If choosing opt-2, include the clarification for the ambiguous requirement.",
  "routing": {
    "primary": "pm-lead",
    "secondary": "tech-lead",
    "timeout_minutes": 60
  },
  "previous_escalation_id": null
}
```

---

## 9. Success Metrics

| Metric                                        | Target                     | Measurement Method                                    |
|------------------------------------------------|----------------------------|-------------------------------------------------------|
| Escalation resolution time (median)           | < 30 minutes               | Time from escalation raised to human response recorded |
| Escalation rate at L1                         | < 15% of requests          | Escalations / total requests at L1                     |
| Escalation rate at L2                         | < 10% of requests          | Escalations / total requests at L2                     |
| Escalation rate at L3                         | < 5% of requests           | Escalations / total requests at L3                     |
| False escalation rate (unnecessary escalations) | < 5% of all escalations   | Escalations where human response was "proceed as-is"   |
| Kill-to-halt latency                          | < 5 seconds                | Time from `/kill` command to all pipelines stopped     |
| Notification fatigue score                    | < 10 non-digest notifications per day per human | Count of individual (non-batched) notifications |
| Trust promotion accuracy                      | > 90% of promotions sustained for 30+ days | Promotions not reverted within 30 days |
| Audit trail completeness                      | 100% of gate decisions logged | Spot-check audits comparing pipeline events to log    |
| Event log write durability                    | 0 events lost              | Reconciliation checks between pipeline state and log   |
| Human re-escalation rate (guidance made things worse) | < 10% of responded escalations | Re-escalations linked to a previous human response |
| Daily digest delivery reliability             | > 99.5%                    | Digests sent / digests expected                        |

---

## 10. Risks & Mitigations

| #  | Risk                                                                 | Impact | Probability | Mitigation                                                                                                     |
|----|----------------------------------------------------------------------|--------|-------------|----------------------------------------------------------------------------------------------------------------|
| R1 | **Human's escalation response makes things worse.** The human provides bad guidance that causes a downstream failure. | High   | Medium      | The system re-escalates with full context of the failed guidance attempt. The re-escalation explicitly states "Your previous guidance was applied and resulted in X." The audit trail preserves the full interaction for learning. |
| R2 | **Trust level is too high for a repository.** The system operates at L2 but the repo is not mature enough, leading to quality issues. | High   | Medium      | Automatic trust demotion after N consecutive failures (configurable, default: 3). Trust promotion suggestions are backed by quantitative evidence. Regular trust-level review reminders to the PM Lead. |
| R3 | **Notification fatigue.** Too many notifications cause the human to ignore them, including important escalations. | High   | High        | Aggressive batching of non-urgent notifications. DND hours. Automatic fatigue detection with meta-notification. Separate high-priority channel for `immediate`-urgency escalations. Daily digest as the default consumption mode. |
| R4 | **Escalation routing target is unavailable.** The primary contact is on vacation or unresponsive. | Medium | Medium      | Escalation chains with configurable timeouts. Secondary routing targets. Fallback to PM Lead for all unrouted escalations. System pauses rather than proceeding without acknowledgment. |
| R5 | **Event log grows unbounded or becomes corrupted.** Storage pressure or write failures degrade the audit trail. | Medium | Low         | 90-day active retention with automated archival. Log rotation. Write-ahead buffering to survive transient failures. Integrity verification via hash chaining. Monitoring alerts on log write failures. |
| R6 | **Kill switch doesn't work when needed.** A bug in the kill path or a hung process prevents halting. | Critical | Low        | Kill-switch code path is minimal and tested independently. Hard-kill mode bypasses graceful shutdown. Process-level watchdog as a last resort. Quarterly kill-switch drills. |
| R7 | **Cross-request systemic failures not detected.** Individual escalations are handled, but the systemic pattern (e.g., broken shared dependency) goes unnoticed. | Medium | Medium      | Cross-request correlation engine that monitors failure patterns across repositories and time windows. Systemic-issue alerts that supersede individual escalations. |
| R8 | **Different teams want different escalation cultures.** One team prefers terse Slack messages; another prefers detailed emails. | Low    | High        | Escalation verbosity is configurable per repository/team. Notification channel and format are independently configurable. Templates are customizable. |

---

## 11. Phasing

### Phase 1: Foundation (L0/L1 with Basic Escalation)

**Scope:**
- Trust levels L0 and L1 fully implemented
- Trust level configurable per repository and per request
- Mid-pipeline trust-level change (downgrade only in Phase 1)
- Escalation taxonomy: all 6 types defined and classified
- Escalation communication: full structured format (FR-17)
- Default routing: all escalations to PM Lead
- Human response handling: parse response, resume pipeline, record in audit trail
- Structured response options for common scenarios
- `/kill` (graceful mode) and `/cancel {request-id}`
- Append-only event log (`events.jsonl`) with all required fields
- Notification: CLI output and file drop delivery methods
- Basic daily digest (completion summary only)

**Exit Criteria:**
- A request at L0 pauses for human approval at every gate
- A request at L1 pauses at PRD and code gates, proceeds autonomously through middle phases
- An escalation is raised, routed to PM Lead, resolved with human response, pipeline resumes
- `/kill` halts all active requests within 5 seconds
- Event log captures all gate decisions and escalations

### Phase 2: Advanced Autonomy (L2/L3 with Full Routing)

**Scope:**
- Trust levels L2 and L3 fully implemented
- Advanced escalation routing: per-type routing targets
- Escalation chains with timeout and secondary routing
- Timeout behaviors: all four options (wait, retry, skip, cancel)
- Mid-pipeline trust-level upgrade
- Discord embed and Slack block kit notification delivery
- Notification batching and DND hours
- Notification fatigue detection
- Cross-request systemic failure detection
- `/kill` hard mode
- `/pause` and `/resume` commands
- Decision replay (given a request ID, reconstruct the decision history)
- Configurable escalation verbosity per repository/team
- Re-escalation with linked context when human guidance fails

**Exit Criteria:**
- A request at L3 completes end-to-end without human intervention (unless escalated)
- Escalations route to configured targets per type; secondary targets receive after timeout
- Notifications are batched during DND hours; only P0 escalations break through
- Systemic failure across 3 requests triggers a single systemic-issue alert
- Decision replay for a request produces a complete, chronological, human-readable trace

### Phase 3: Trust Intelligence

**Scope:**
- Per-repository trust scoring based on delivery history
- Trust promotion suggestions with quantitative evidence
- Automatic trust demotion on consecutive failures
- Trust-level effectiveness measurement: "Is L2 actually safe for this repo?"
- Trust dashboard: current levels, trend, promotion suggestions, demotion events
- Event log integrity verification (hash chaining)
- Event log archival (active to cold storage after 90 days)
- Office-hours routing
- Delegate response ("route this escalation to someone else")

**Exit Criteria:**
- After 20 consecutive successful L1 deliveries, system suggests promotion to L2 with supporting data
- After 3 consecutive gate failures at L2, system auto-demotes to L1 and notifies PM Lead
- Trust dashboard shows per-repo trust history, promotion/demotion events, and effectiveness metrics
- Archived events are queryable with < 30 second latency
- Hash-chain integrity check passes on 90 days of event log data

---

## 12. Configuration Schema

The following configuration governs the trust and escalation framework. All values are stored in the plugin's configuration file and are hot-reloadable.

```yaml
trust:
  system_default_level: 1  # Default trust level for new repositories (0-3)
  repositories:
    my-org/my-repo:
      default_level: 2
      auto_demotion:
        enabled: true
        consecutive_failures: 3
        demote_to: 1
  promotion:
    enabled: true
    min_consecutive_successes: 20
    require_human_approval: true  # Always true; cannot be set to false

escalation:
  routing:
    mode: "default"  # "default" (all to PM Lead) or "advanced"
    default_target: "pm-lead"
    advanced:
      product: { primary: "pm-lead", secondary: "tech-lead", timeout_minutes: 60 }
      technical: { primary: "tech-lead", secondary: "pm-lead", timeout_minutes: 120 }
      infrastructure: { primary: "sys-operator", secondary: "tech-lead", timeout_minutes: 30 }
      security: { primary: "security-lead", secondary: "pm-lead", timeout_minutes: 15 }
      cost: { primary: "pm-lead", timeout_minutes: 60 }
      quality: { primary: "tech-lead", secondary: "pm-lead", timeout_minutes: 120 }
  timeout_behavior:
    default: "pause"  # "pause" | "retry" | "skip" | "cancel"
    overrides:
      infrastructure: "pause"
      security: "pause"
      quality: "retry"
  retry_limits:
    quality_gate_max_iterations: 3
    technical_max_approaches: 3
  verbosity:
    default: "standard"  # "terse" | "standard" | "verbose"
    overrides: {}

notifications:
  delivery:
    default_method: "cli"  # "cli" | "discord" | "slack" | "file_drop"
    overrides:
      escalation: "slack"
      completion: "discord"
      daily_digest: "slack"
  batching:
    enabled: true
    interval_minutes: 60
    exempt_types: ["escalation", "error"]  # These always send immediately
  dnd:
    enabled: false
    start: "22:00"
    end: "07:00"
    timezone: "America/New_York"
    breakthrough_urgency: ["immediate"]
  fatigue:
    enabled: true
    threshold_per_hour: 20
    digest_cooldown_minutes: 30
  cross_request:
    enabled: true
    failure_window_minutes: 60
    failure_threshold: 3

audit:
  retention:
    active_days: 90
    archive_enabled: true
  integrity:
    hash_chain_enabled: false  # Enabled in Phase 3
  log_path: ".autonomous-dev/events.jsonl"

emergency:
  kill_default_mode: "graceful"  # "graceful" | "hard"
  restart_requires_human: true  # Always true; cannot be set to false
```

---

## 13. Open Questions

| #  | Question                                                                                       | Owner    | Status |
|----|------------------------------------------------------------------------------------------------|----------|--------|
| Q1 | What is the right threshold for trust promotion? 20 consecutive successes may be too high for fast-moving repos or too low for critical infrastructure repos. Should the threshold be configurable per repository? | PM Lead  | Open   |
| Q2 | How should the system handle conflicting guidance from different humans? (e.g., PM Lead says "proceed" but tech lead says "stop" on the same escalation.) | PM Lead  | Open   |
| Q3 | Should there be a trust level between L2 and L3 for "autonomous but human reviews code async" (system doesn't block on code review but human can flag issues after merge)? | PM Lead  | Open   |
| Q4 | What is the right retention period for archived events? 90 days active is clear, but how long should archives be kept? Indefinitely? 1 year? Tied to compliance requirements? | PM Lead  | Open   |
| Q5 | Should the kill switch require authentication (e.g., a confirmation code) to prevent accidental invocation, or is speed more important than confirmation? | PM Lead  | Open   |
| Q6 | How should the system handle escalation routing when the target is a channel (e.g., #security-alerts) rather than a person? Who "owns" the response? | PM Lead  | Open   |
| Q7 | For L3 autonomous mode, should there be a maximum cost ceiling that auto-triggers an escalation regardless of trust level? | PM Lead  | Open   |
| Q8 | How should trust scores interact across related repositories (e.g., a monorepo with multiple services)? Should trust be per-repo or per-service? | PM Lead  | Open   |
| Q9 | What is the escalation protocol when the *system itself* is malfunctioning (e.g., the escalation routing is broken)? Is there a "meta-escalation" path? | PM Lead  | Open   |
| Q10 | Should the daily digest include comparative metrics (e.g., "escalation rate is 20% higher than last week") or just raw data? | PM Lead  | Open   |

---

## Appendix A: Glossary

| Term                  | Definition                                                                                     |
|-----------------------|------------------------------------------------------------------------------------------------|
| **Trust Level**       | A numeric level (0--3) governing how much autonomous decision-making authority the system has for a given request or repository. |
| **Gate**              | A checkpoint in the pipeline where an artifact is reviewed and a pass/fail decision is made. Gates are the control points where trust levels determine human vs. system authority. |
| **Escalation**        | A structured request for human intervention, raised when the system cannot proceed autonomously. |
| **Escalation Chain**  | An ordered list of routing targets for an escalation, with timeouts between each level. |
| **Kill Switch**       | An emergency control that immediately halts all system activity. |
| **Trust Score**       | A computed metric reflecting a repository's delivery track record, used to inform trust-level promotion suggestions. |
| **Decision Replay**   | The ability to reconstruct the complete sequence of decisions made for a given request, using the audit trail. |
| **DND Hours**         | A configured quiet period during which non-critical notifications are suppressed and batched. |
| **Systemic Issue**    | A failure pattern detected across multiple requests, suggesting a root cause beyond any individual request. |
| **Atomic Operation**  | The smallest unit of work that should not be interrupted (e.g., a git commit). Graceful kill waits for the current atomic operation to complete. |

---

## Appendix B: Trust Level Decision Flowchart

```
Request received
    |
    v
[Determine trust level]
    |-- Explicit level on request? --> Use it
    |-- No? --> Use repository default
    |           |-- Repo has default? --> Use it
    |           |-- No? --> Use system default (L1)
    |
    v
[Pipeline phase gate reached]
    |
    v
[Check trust level matrix for this gate]
    |-- Human approval required?
    |       |-- Yes --> Pause pipeline, notify human, wait for response
    |       |           |-- Human responds --> Incorporate, resume, log
    |       |           |-- Timeout --> Follow escalation chain
    |       |
    |-- System handles?
    |       |-- Yes --> Agent reviews artifact
    |               |-- Pass --> Log decision, proceed to next phase
    |               |-- Fail (retries remaining) --> Retry with feedback
    |               |-- Fail (retries exhausted) --> Raise quality escalation
    |
    v
[Check for trust-level change mid-pipeline]
    |-- Changed? --> Apply at next gate boundary
    |-- Unchanged? --> Continue
    |
    v
[Pipeline complete or escalated]
```

---

*End of PRD-007.*
