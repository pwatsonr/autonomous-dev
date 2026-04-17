# PRD-005: Production Intelligence Loop

| Field        | Value                                      |
|--------------|--------------------------------------------|
| **Title**    | Production Intelligence Loop               |
| **Version**  | 1.0                                        |
| **Date**     | 2026-04-08                                 |
| **Author**   | PM Lead, autonomous-dev                    |
| **Status**   | Draft                                      |
| **Plugin**   | autonomous-dev                             |
| **Depends on** | PRD-001 (Pipeline Orchestration), PRD-003 (Deployment & Delivery) |

---

## 1. Problem Statement

Autonomous development pipelines today are open-loop: code is written, tested, deployed, and then forgotten. There is no systematic mechanism for production telemetry -- errors, latency regressions, adoption metrics, anomalous behavior -- to flow back into the development process. Engineers discover production issues through manual monitoring, ad-hoc alerts, or user complaints, often hours or days after a degradation begins.

**Current state**: Deployed applications generate rich telemetry (metrics, logs, traces, error reports) that sits in monitoring systems. The development pipeline has no awareness of production behavior. When production issues surface, they enter the backlog through manual triage -- disconnected from the deployment that caused them and the code that introduced them.

**Desired state**: A Production Intelligence Loop that continuously observes production systems, generates structured observation reports when it detects meaningful signals, and presents those observations to a human PM Lead for triage. Observations that warrant action are promoted to PRDs and enter the autonomous development pipeline. The loop tracks whether fixes actually resolved the underlying issue, creating a closed feedback cycle.

**Design principle**: Analytics close the loop.

**Critical architectural constraint**: The system must **observe and report**, not **observe and act**. Every observation passes through a human triage gate before entering the development pipeline. This constraint is non-negotiable for Phase 1 and Phase 2; Phase 3 introduces auto-promotion with mandatory human override capability.

**Business impact**: Reduces mean time to detection (MTTD) for production issues from hours/days to minutes. Eliminates the gap between "something broke in production" and "the development pipeline is working on a fix." Captures gradual degradations that no human would notice until they become critical. Provides empirical evidence of whether shipped changes actually improve production behavior.

---

## 2. Goals & Non-Goals

### Goals

| Goal | Metric | Baseline | Target | Timeframe | Measurement Method |
|------|--------|----------|--------|-----------|-------------------|
| Reduce mean time to detection for production issues | MTTD (minutes) | Manual detection: 120+ min average | < 30 min for P0/P1, < 240 min for P2/P3 | 30 days post-Phase 1 | Timestamp delta: issue onset (first error spike) vs. observation report creation |
| Surface gradual degradations before they become incidents | Trend-detected observations per month | 0 (no trend detection exists) | 5+ trend observations surfaced per month per monitored service | 60 days post-Phase 1 | Count of observation reports with type `trend_degradation` |
| Ensure human oversight of all production-to-pipeline transitions | Observation-to-PRD conversion without human approval | N/A | 0% (zero auto-promoted PRDs in Phase 1-2) | Continuous | Audit log: count PRDs with source `observation` that lack `triage_approved_by` field |
| Track fix effectiveness | Percentage of observation-generated fixes that resolve the underlying metric | 0% (no tracking exists) | 70%+ of shipped fixes show metric improvement within 7 days | 90 days post-Phase 2 | Effectiveness tracker: compare pre-fix and post-fix metric values for observation-linked deployments |
| Minimize noise in observation pipeline | Signal-to-noise ratio (actionable observations / total observations) | N/A | > 60% of observations result in promote or investigate triage decisions | 60 days post-Phase 1 | Triage decision distribution: (promote + investigate) / total observations |

### Non-Goals

- **Auto-remediation**: The system does not execute fixes, roll back deployments, or modify production infrastructure. It observes and reports.
- **Replacing existing alerting**: The Production Intelligence Loop complements PagerDuty, OpsGenie, and existing on-call alerting. It does not send pages or wake people up at 3 AM.
- **Real-time incident response**: This is not an incident management tool. For active incidents, use existing incident response processes. The loop operates on a scheduled cadence (default: every 4 hours), not in real-time.
- **Full observability platform**: The system reads from existing monitoring tools (Grafana, Prometheus, OpenSearch, Sentry). It does not collect, store, or index telemetry itself.
- **Multi-tenant production monitoring**: Phase 1-3 scope is single-organization, single-environment production monitoring. Multi-tenant support is out of scope.
- **Cost optimization recommendations**: While usage analytics may reveal cost-relevant patterns, generating cost optimization recommendations is out of scope.

---

## 3. User Personas

### PM Lead (Primary)

- **Role**: Product/engineering lead responsible for triaging production observations and deciding which enter the development pipeline.
- **Goals**: Receive concise, evidence-backed observation reports; make quick promote/dismiss/defer/investigate decisions; track whether previous observation-generated fixes were effective.
- **Pain points**: Alert fatigue from noisy monitoring systems; no structured way to connect production signals to development work; difficulty tracking whether shipped fixes actually resolved the issue.

### On-Call Engineer

- **Role**: Engineer currently on-call for production systems who may see observation reports as supplementary context during or after incidents.
- **Goals**: Wants observation reports to provide root-cause hypotheses and correlated evidence that complement (not duplicate) existing alerts.
- **Pain points**: Monitoring dashboards show symptoms but not causes; manually correlating logs, metrics, and traces across services is time-consuming.

### Autonomous Pipeline Operator

- **Role**: Engineer or PM who manages the autonomous-dev pipeline and wants production intelligence to feed into it.
- **Goals**: Wants observation-promoted PRDs to enter the pipeline with full production context (metrics, log excerpts, severity) so that the pipeline can generate targeted fixes.
- **Pain points**: PRDs for production issues are often written from memory after an incident, missing quantitative evidence.

### Service Owner

- **Role**: Engineer responsible for a specific service who wants visibility into that service's production behavior over time.
- **Goals**: Wants a weekly digest of observations for their services; wants to see trends (improving/degrading) and feature adoption metrics for recent deployments.
- **Pain points**: Monitoring dashboards are broad; no service-specific production intelligence summary exists.

---

## 4. User Stories

### Must Have (P0)

1. As a **PM Lead**, I want the system to connect to Grafana via MCP server so that it can read dashboard data and alert states without requiring direct database access.

2. As a **PM Lead**, I want the system to connect to Prometheus via MCP server so that it can execute PromQL queries to evaluate metric thresholds and detect anomalies.

3. As a **PM Lead**, I want the system to connect to OpenSearch/ELK via MCP server so that it can search production logs and error traces for root-cause evidence.

4. As a **PM Lead**, I want observation runs to execute on a configurable schedule (default every 4 hours) so that production signals are captured systematically without manual intervention.

5. As a **PM Lead**, I want errors classified by severity (P0 through P3) based on configurable criteria so that I can prioritize triage by impact.

6. As a **PM Lead**, I want related errors deduplicated into a single observation so that the same root cause does not generate multiple reports cluttering the triage queue.

7. As a **PM Lead**, I want observation reports stored as structured files in `.autonomous-dev/observations/` so that they are version-controlled, auditable, and machine-readable.

8. As a **PM Lead**, I want a triage interface where I can promote an observation to PRD, dismiss it, defer it, or request further investigation so that I maintain explicit control over what enters the pipeline.

9. As a **PM Lead**, I want a 7-day cooldown period after shipping an observation-generated fix so that the system does not immediately re-flag the same area before the fix has had time to stabilize.

10. As a **PM Lead**, I want all PII and secrets scrubbed from log data before it is processed by the LLM so that sensitive production data never appears in observation reports or Claude sessions.

11. As a **PM Lead**, I want false positive filtering that excludes known transient errors, maintenance windows, and load test traffic so that observations reflect genuine production issues.

12. As an **On-Call Engineer**, I want observation reports to include specific metric values, log excerpts, and timestamps so that I have quantitative evidence when investigating an issue.

13. As a **Service Owner**, I want to configure observation scope per-service or per-repo so that I only receive observations relevant to my area of responsibility.

14. As an **Autonomous Pipeline Operator**, I want promoted observations to generate PRDs with full production context (metrics, evidence, severity) so that the pipeline produces targeted, evidence-based fixes.

15. As a **PM Lead**, I want secret detection to scan all observation content for API keys, tokens, and environment variable values so that sensitive credentials are never persisted in reports.

### Should Have (P1)

16. As a **PM Lead**, I want anomaly detection that identifies statistically significant deviations from baseline (not just threshold breaches) so that subtle but meaningful shifts are caught.

17. As a **PM Lead**, I want trend analysis that detects gradual degradation over days or weeks (e.g., latency increasing 5ms/day) so that slow-burn issues are caught before they become incidents.

18. As a **PM Lead**, I want a weekly observation digest summarizing all observations, triage decisions, and recommendations so that I can review the production intelligence posture in one view.

19. As a **Service Owner**, I want feature adoption tracking that reports whether newly deployed features are being used so that I can gauge the impact of pipeline-generated changes.

20. As a **PM Lead**, I want oscillation detection that flags an area receiving 3+ observations in 30 days as a systemic issue so that recurring problems are escalated rather than patched repeatedly.

21. As a **PM Lead**, I want effectiveness tracking that links observations to their generated PRDs and resulting deployments so that I can measure whether fixes actually improved the metrics.

22. As an **On-Call Engineer**, I want the system to integrate with application health endpoints so that basic up/down status is included in observation context.

23. As a **PM Lead**, I want configurable error rate and duration thresholds (e.g., >5% error rate for >10 minutes) before an observation triggers so that transient spikes do not generate noise.

### Nice to Have (P2)

24. As a **PM Lead**, I want integration with Sentry for enriched error tracking (stack traces, affected user counts, release correlation) so that observations for exceptions include deep diagnostic data.

25. As a **Service Owner**, I want the system to detect cascading failures across microservices and group them into a single cross-service observation so that distributed root causes are identified.

26. As an **Autonomous Pipeline Operator**, I want the system to track which monitoring gaps exist (uninstrumented services, missing dashboards) so that observability coverage improves over time.

27. As a **PM Lead**, I want triage notifications delivered via Slack or Discord so that I can review and act on observations without opening the file system.

28. As a **PM Lead**, I want the system to estimate the cost of each observation run (Claude session tokens consumed) so that I can tune observation frequency against budget.

29. As a **PM Lead**, I want observation reports retained for 90 days and then archived so that historical data is available without unbounded storage growth.

30. As an **On-Call Engineer**, I want the system to complement (not duplicate) existing PagerDuty/OpsGenie alerts by cross-referencing active incidents so that observation reports add context rather than noise.

---

## 5. Functional Requirements

### 5.1 Monitoring Integration

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-001 | The system shall connect to Grafana via a configured MCP server to read dashboard panels, alert states, and annotation data. | P0 |
| FR-002 | The system shall connect to Prometheus via a configured MCP server to execute PromQL queries and retrieve time-series metric data. | P0 |
| FR-003 | The system shall connect to OpenSearch/ELK via a configured MCP server to search logs, retrieve error traces, and execute aggregation queries. | P0 |
| FR-004 | The system shall support connecting to application health endpoints (HTTP GET) to determine basic service availability (up/down/degraded). | P1 |
| FR-005 | The system shall support connecting to Sentry via a configured MCP server to retrieve error events, stack traces, affected user counts, and release correlation data. | P2 |
| FR-006 | The system shall execute observation runs on a configurable schedule with a default interval of 4 hours. The schedule shall be expressed as a cron expression or simple interval (e.g., `4h`, `30m`). | P0 |
| FR-007 | The system shall support configuring observation scope per-service, per-repo, or per-namespace so that observation runs target specific systems rather than querying all available telemetry. | P0 |
| FR-008 | The system shall validate MCP server connectivity at startup and report which monitoring integrations are available, degraded, or unreachable. | P1 |
| FR-009 | The system shall integrate with existing alerting systems (PagerDuty, OpsGenie) in read-only mode to cross-reference active incidents and avoid generating duplicate observations for known, actively-managed incidents. | P2 |

### 5.2 Error Detection & Classification

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-010 | The system shall detect the following error types: crash (process termination), exception (unhandled errors), timeout (request/response exceeding SLA), degraded performance (latency above threshold), and data inconsistency (unexpected response shapes or values). | P0 |
| FR-011 | The system shall classify detected errors by severity: P0 (service fully down or data loss), P1 (major feature broken, significant user impact), P2 (minor feature broken, limited user impact), P3 (cosmetic issue, no functional impact). | P0 |
| FR-012 | The system shall apply configurable severity classification rules that map error conditions to severity levels. Default rules shall be provided and overridable per-service. | P1 |
| FR-013 | The system shall deduplicate related errors by grouping errors that share the same root cause (matching stack trace, error code, affected endpoint, or temporal correlation within a configurable window). A group of related errors shall produce one observation, not many. | P0 |
| FR-014 | The system shall filter known false positives by maintaining an exclusion list of: known transient error patterns, scheduled maintenance windows (defined by time ranges), and load test traffic (identified by header patterns, source IP ranges, or environment tags). | P0 |
| FR-015 | The system shall support configurable thresholds for observation triggering. Default thresholds: error rate > 5% sustained for > 10 minutes. Both the rate and duration thresholds shall be configurable per-service. | P0 |
| FR-016 | The system shall not generate an observation for errors that fall below the configured threshold, even if individual errors are detected, to prevent noise from isolated transient failures. | P0 |

### 5.3 Usage Analytics

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-017 | The system shall track key usage metrics per observation run: endpoint latency (p50, p95, p99), request throughput (requests/second), error rate (percentage), and availability (uptime percentage). | P0 |
| FR-018 | The system shall perform anomaly detection using statistical methods (e.g., standard deviation from rolling baseline, z-score) to identify significant deviations, rather than relying solely on static thresholds. | P1 |
| FR-019 | The system shall perform trend analysis by comparing current metrics against historical baselines over configurable windows (7-day, 14-day, 30-day) to detect gradual degradation patterns (e.g., latency increasing steadily over days). | P1 |
| FR-020 | The system shall track feature adoption by correlating deployment events with endpoint usage metrics. For newly deployed endpoints or features, the system shall report: first observed traffic, traffic volume over time, and error rate for the new code path. | P1 |
| FR-021 | The system shall establish baselines automatically. On first observation for a new service, the system shall enter a "learning" mode for 7 days, collecting baseline metrics without generating anomaly or trend observations. Threshold-based error detection (FR-015) shall remain active during learning. | P1 |

### 5.4 Observation Reports

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-022 | The system shall generate structured observation reports in Markdown with YAML frontmatter. Each report shall include: observation ID, timestamp, service/repo, observation type (error, anomaly, trend, adoption), severity, summary, evidence (metrics and log excerpts), recommended action (fix, investigate, monitor, ignore), and triage status (pending). | P0 |
| FR-023 | The system shall store observation reports in `.autonomous-dev/observations/` within the target repository, organized by date: `.autonomous-dev/observations/YYYY/MM/OBS-YYYYMMDD-HHMMSS-<short-id>.md`. | P0 |
| FR-024 | Observation reports shall NOT be automatically fed into the autonomous development pipeline. The only path from observation to pipeline is through the human triage gate (FR-027). | P0 |
| FR-025 | Each observation report shall include a confidence score (0.0-1.0) indicating how confident the system is that the observation represents a genuine, actionable issue. The confidence score shall factor in: evidence strength, deduplication match quality, and historical false positive rate for similar patterns. | P1 |
| FR-026 | The system shall generate a weekly observation digest report summarizing: total observations generated, observations by type and severity, triage decision distribution, top recurring observation patterns, and effectiveness metrics for previously promoted observations. The digest shall be stored in `.autonomous-dev/observations/digests/`. | P1 |

### 5.5 Human Triage Gate

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-027 | The system shall present pending observations to the PM Lead for triage. The PM Lead shall be able to take one of four actions on each observation: **promote** (generate a PRD and enter the pipeline), **dismiss** (noted, no action needed, with optional reason), **defer** (revisit later, with optional reminder date), **investigate** (request additional data collection on next observation run). | P0 |
| FR-028 | The triage interface shall support file-based review: the PM Lead edits the observation report's YAML frontmatter to set `triage_decision` and `triage_reason`, then the system processes the decision on the next run. | P0 |
| FR-029 | The triage interface shall optionally support notification-based review via Slack or Discord: the system posts a summary of pending observations with inline action buttons or reply-based commands. | P2 |
| FR-030 | When an observation is promoted to PRD, the system shall generate a PRD in the autonomous-dev pipeline format, pre-populated with: the observation's evidence (metrics, log excerpts), severity, affected service, and a problem statement derived from the observation summary. The generated PRD shall be tagged with `source: production-intelligence` and `observation_id: <id>`. | P0 |
| FR-031 | The system shall maintain an audit trail of all triage decisions: who triaged, when, what decision, and reasoning. This audit trail shall be stored alongside the observation report. | P1 |

### 5.6 Feedback Loop Governance

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-032 | The system shall enforce a configurable cooldown period (default: 7 days) after a deployment that resolves an observation-generated PRD. During cooldown, new observations for the same service + error class combination shall be generated but flagged as `cooldown_active` and excluded from triage until the cooldown expires. | P0 |
| FR-033 | The system shall detect feedback oscillation: if the same service + error class combination generates 3 or more observations within a 30-day rolling window, the system shall flag the area as a **systemic issue** and recommend architectural investigation rather than incremental fixes. | P1 |
| FR-034 | The system shall track the full lifecycle of observation-generated work: observation -> triage decision -> PRD (if promoted) -> deployment (if completed) -> post-deployment metric change. This linkage shall be stored in the observation report's metadata. | P1 |
| FR-035 | The system shall compute an effectiveness metric for each resolved observation: did the target metric improve after deployment? The metric shall compare the 7-day average before the fix deployment against the 7-day average after, with a minimum improvement threshold of 10% to count as "effective." | P1 |
| FR-036 | The system shall compute an aggregate effectiveness rate: what percentage of observation-generated PRDs that were deployed resulted in measurable metric improvement? This rate shall be reported in the weekly digest. | P1 |

### 5.7 Data Safety & Privacy

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-037 | The system shall apply PII scrubbing to all log data before it is included in observation reports or processed by the LLM. PII patterns to scrub: email addresses, phone numbers, IP addresses (optionally, configurable), Social Security numbers, credit card numbers, and any pattern matching a configurable regex list. Scrubbed values shall be replaced with `[REDACTED:<type>]` tokens. | P0 |
| FR-038 | The system shall apply secret detection to all observation content before persistence. Secrets to detect: API keys (common patterns for AWS, GCP, Stripe, GitHub, etc.), Bearer tokens, Basic auth credentials, environment variable values matching `*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD` patterns, and any pattern matching a configurable regex list. Detected secrets shall be replaced with `[SECRET_REDACTED]`. | P0 |
| FR-039 | The system shall never pass raw, unscrubbed production log data to the LLM. All log data shall pass through the PII scrubbing (FR-037) and secret detection (FR-038) pipeline before any LLM processing occurs. | P0 |
| FR-040 | Observation reports shall have a configurable retention period (default: 90 days). After the retention period, reports shall be archived (moved to `.autonomous-dev/observations/archive/`) and optionally deleted after a further configurable period (default: 365 days). | P1 |
| FR-041 | The system shall support access control for observation reports. When integrated with a team environment, observation reports shall respect repository-level access controls. Observation reports containing production data shall be excluded from any public-facing output. | P1 |

---

## 6. Non-Functional Requirements

| ID | Requirement | Category | Target |
|----|-------------|----------|--------|
| NFR-001 | Observation runs shall complete within 15 minutes for a single service and within 60 minutes for a full multi-service sweep. | Performance | 15 min/service, 60 min/sweep |
| NFR-002 | The PII scrubbing and secret detection pipeline shall process log batches with less than 2 seconds of added latency per 10,000 log lines. | Performance | < 2s per 10K lines |
| NFR-003 | The system shall operate with no more than 5% false positive rate for P0/P1 severity observations after the 7-day learning period. | Accuracy | < 5% FP rate for P0/P1 |
| NFR-004 | The system shall tolerate partial monitoring system outages gracefully: if one MCP server (e.g., Grafana) is unreachable, the system shall continue observation using available sources and note the gap in the report. | Reliability | Graceful degradation |
| NFR-005 | Each observation run shall consume no more than 50,000 Claude tokens for a single-service observation and no more than 200,000 tokens for a full multi-service sweep. Token usage shall be logged per run. | Cost | 50K tokens/service, 200K tokens/sweep |
| NFR-006 | The system shall not introduce write operations to production monitoring systems. All MCP server interactions shall be read-only. | Safety | Zero write operations |
| NFR-007 | Observation reports shall be valid Markdown parseable by standard tools (e.g., GitHub, VS Code) and the YAML frontmatter shall be parseable by standard YAML parsers. | Interoperability | Standard-compliant Markdown + YAML |
| NFR-008 | The system shall support concurrent observation runs for independent services without data races or conflicting file writes. | Concurrency | Safe parallel execution |
| NFR-009 | The PII/secret scrubbing pipeline shall have a recall rate of at least 99% for known PII and secret patterns (i.e., miss fewer than 1 in 100 instances). | Security | > 99% recall |
| NFR-010 | The system shall log all MCP server queries, LLM invocations, and file writes for auditability. Logs shall be stored in `.autonomous-dev/logs/intelligence/`. | Auditability | Complete audit trail |

---

## 7. System Architecture Overview

```
Production Systems
    |
    v
+-------------------------------------------+
|        MCP Server Layer (Read-Only)        |
|  Grafana | Prometheus | OpenSearch | Sentry|
+-------------------------------------------+
    |
    v
+-------------------------------------------+
|        Data Safety Pipeline               |
|  PII Scrubbing -> Secret Detection        |
+-------------------------------------------+
    |
    v
+-------------------------------------------+
|        Intelligence Engine (Claude)        |
|  Error Detection | Anomaly Detection      |
|  Trend Analysis  | Feature Adoption       |
|  Deduplication   | Classification         |
+-------------------------------------------+
    |
    v
+-------------------------------------------+
|        Observation Reports                |
|  .autonomous-dev/observations/            |
+-------------------------------------------+
    |
    v
+-------------------------------------------+
|        Human Triage Gate                  |
|  PM Lead: promote | dismiss | defer |     |
|           investigate                     |
+-------------------------------------------+
    |  (promote only)
    v
+-------------------------------------------+
|        Autonomous Dev Pipeline            |
|  PRD -> TDD -> Implementation -> Deploy   |
+-------------------------------------------+
    |
    v
+-------------------------------------------+
|        Effectiveness Tracking             |
|  Post-deploy metric comparison            |
|  Feedback loop governance                 |
+-------------------------------------------+
    |  (feeds back to Intelligence Engine)
    v
        ... loop continues ...
```

### Key Architectural Decisions

1. **Read-only MCP interactions**: The system never writes to production monitoring systems. All connections are strictly read-only.
2. **Scrub-before-process**: The data safety pipeline sits between raw production data and the LLM. No unscrubbed data ever reaches Claude.
3. **Human gate is mandatory**: The path from observation to pipeline requires an explicit human decision. The system cannot autonomously create PRDs or trigger development work.
4. **File-based as primary interface**: Observation reports and triage decisions live in the repository filesystem. This ensures version control, auditability, and IDE-native workflows. Notification channels (Slack/Discord) are secondary, optional interfaces.
5. **Graceful degradation**: If a monitoring source is unavailable, the system proceeds with what it has and documents the gap.

---

## 8. Observation Report Format

```yaml
---
id: OBS-20260408-143022-a7f3
timestamp: 2026-04-08T14:30:22Z
service: api-gateway
repo: org/api-gateway
type: error           # error | anomaly | trend | adoption
severity: P1          # P0 | P1 | P2 | P3
confidence: 0.87      # 0.0 - 1.0
triage_status: pending # pending | promoted | dismissed | deferred | investigating
triage_decision: null
triage_by: null
triage_at: null
triage_reason: null
cooldown_active: false
linked_prd: null
linked_deployment: null
effectiveness: null    # improved | unchanged | degraded | pending
observation_run_id: RUN-20260408-1430
tokens_consumed: 12340
---

# Observation: Elevated 5xx Error Rate on /api/v2/orders

## Summary

The `/api/v2/orders` endpoint has been returning HTTP 503 responses at a rate
of 12.3% over the past 45 minutes, compared to a baseline of 0.4%. The error
correlates with a deployment of commit `abc1234` at 13:45 UTC.

## Evidence

### Metrics (Prometheus)
- Error rate: 12.3% (baseline: 0.4%, threshold: 5%)
- p99 latency: 8,200ms (baseline: 340ms)
- Affected requests: ~2,400 in the observation window

### Logs (OpenSearch)
- 1,847 occurrences of `ConnectionPoolExhausted` in `api-gateway` logs
- First occurrence: 2026-04-08T13:47:12Z
- Sample (scrubbed): `[ERROR] ConnectionPoolExhausted: pool "orders-db" max_connections=50 active=50 waiting=312 user=[REDACTED:email]`

### Alerts (Grafana)
- Alert "API Gateway 5xx Rate" firing since 13:52 UTC
- No active PagerDuty incident linked (checked via integration)

## Root Cause Hypothesis

The deployment at 13:45 UTC likely introduced a connection pool leak or
increased per-request connection hold time, exhausting the database connection
pool under normal traffic load.

## Recommended Action

**Fix**: Investigate the connection pool configuration change in commit `abc1234`.
Likely requires increasing pool size or fixing a connection leak.

## Related Observations

- None (first occurrence of this pattern)
```

---

## 9. Configuration Schema

```yaml
# .autonomous-dev/config/intelligence.yaml
production_intelligence:
  enabled: true
  schedule: "0 */4 * * *"        # Cron: every 4 hours (default)
  # schedule: "4h"               # Alternative: simple interval

  observation_scope:
    - service: api-gateway
      repo: org/api-gateway
      prometheus_job: api-gateway
      grafana_dashboard_uid: abc123
      opensearch_index: "logs-api-gateway-*"
      health_endpoint: https://api.example.com/health
    - service: order-service
      repo: org/order-service
      prometheus_job: order-service
      grafana_dashboard_uid: def456
      opensearch_index: "logs-order-service-*"
      health_endpoint: https://orders.example.com/health

  error_detection:
    default_thresholds:
      error_rate_percent: 5.0
      sustained_duration_minutes: 10
    per_service_overrides:
      api-gateway:
        error_rate_percent: 2.0     # Stricter for critical path
        sustained_duration_minutes: 5

  false_positive_filters:
    maintenance_windows:
      - cron: "0 2 * * 0"          # Sundays 2-4 AM
        duration_minutes: 120
    excluded_error_patterns:
      - "HealthCheckTimeout"        # Known transient during deploys
      - "RateLimitExceeded"         # Expected under load tests
    load_test_markers:
      headers:
        - "X-Load-Test: true"
      source_tags:
        - "environment:loadtest"

  anomaly_detection:
    method: z_score                 # z_score | std_deviation | iqr
    sensitivity: 2.5                # Z-score threshold
    baseline_window_days: 14

  trend_analysis:
    enabled: true
    windows: [7, 14, 30]            # Days
    min_slope_threshold: 0.05       # 5% change per window to flag

  governance:
    cooldown_days: 7
    oscillation_threshold: 3        # Observations in 30 days = systemic
    oscillation_window_days: 30
    effectiveness_comparison_days: 7
    effectiveness_improvement_threshold: 0.10  # 10% improvement to count

  data_safety:
    pii_patterns:
      - type: email
        regex: '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'
      - type: phone
        regex: '\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}'
      - type: ssn
        regex: '\d{3}-\d{2}-\d{4}'
      - type: credit_card
        regex: '\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b'
    scrub_ip_addresses: true
    secret_patterns:
      - 'AKIA[0-9A-Z]{16}'          # AWS access key
      - 'sk_TESTONLY_[a-zA-Z0-9]{24,}'  # Stripe secret key
      - 'ghp_[a-zA-Z0-9]{36}'       # GitHub PAT
      - 'ghs_[a-zA-Z0-9]{36}'       # GitHub App token
    custom_secret_env_patterns:
      - '*_KEY'
      - '*_SECRET'
      - '*_TOKEN'
      - '*_PASSWORD'

  retention:
    observation_days: 90
    archive_days: 365               # After archive, delete

  notifications:
    enabled: false
    channel: slack                  # slack | discord
    webhook_url: null               # Set to enable
    notify_on: [P0, P1]            # Only notify on high-severity
```

---

## 10. Success Metrics

| Metric | Definition | Target | Measurement Frequency |
|--------|-----------|--------|----------------------|
| Mean Time to Detection (MTTD) | Time from first error spike to observation report creation | < 30 min for P0/P1 | Per observation |
| Signal-to-Noise Ratio | (Promoted + Investigated observations) / Total observations | > 60% | Weekly (in digest) |
| False Positive Rate (P0/P1) | P0/P1 observations dismissed as false positives / Total P0/P1 observations | < 5% | Monthly |
| False Positive Rate (P2/P3) | P2/P3 observations dismissed as false positives / Total P2/P3 observations | < 20% | Monthly |
| Fix Effectiveness Rate | Observation-generated PRDs whose deployment measurably improved the target metric / Total deployed observation-generated PRDs | > 70% | Monthly |
| Observation-to-PRD Conversion | Promoted observations / Total observations | 15-30% (too low = noise, too high = missing filter) | Weekly |
| Trend Detection Lead Time | Days between trend observation and when metric would have breached a static threshold | > 3 days early | Per trend observation |
| PII/Secret Leak Rate | Observation reports containing unscrubbed PII or secrets (detected by audit scan) | 0 | Weekly automated audit |
| Observation Run Cost | Average Claude tokens consumed per observation run | < 50K tokens/single service | Per run |
| Triage Latency | Time from observation creation to triage decision | < 24 hours for P0/P1, < 72 hours for P2/P3 | Per observation |

---

## 11. Risks & Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | **PII/secret leakage**: Production logs contain sensitive data that could leak into observation reports or LLM context. | High | Critical | FR-037/FR-038/FR-039 enforce scrub-before-process. NFR-009 mandates 99%+ recall. Weekly automated audit scans for leaks (Success Metric: PII/Secret Leak Rate = 0). Custom regex patterns allow org-specific PII types. |
| R2 | **Feedback oscillation**: The system detects an issue, generates a fix, the fix introduces a new issue, the system detects the new issue, ad infinitum. | Medium | High | FR-032 enforces 7-day cooldown after fix deployment. FR-033 detects oscillation (3+ observations in 30 days) and flags as systemic. Human triage gate (FR-027) provides a manual circuit breaker at every iteration. |
| R3 | **Alert fatigue / noise**: Too many low-quality observations overwhelm the PM Lead, leading to triage abandonment. | High | High | FR-014/FR-015/FR-016 filter false positives and enforce thresholds. FR-025 adds confidence scores. FR-013 deduplicates. Signal-to-noise ratio tracked as success metric with > 60% target. If ratio drops, tune thresholds. |
| R4 | **Cascading failure misattribution**: In microservice architectures, a single root cause in Service A manifests as errors in Services B, C, D. The system generates separate observations for each, missing the root cause. | Medium | Medium | Phase 1: Document as a known limitation. Phase 2: Implement cross-service correlation (FR-025 user story 25) that groups temporally correlated observations across services and identifies the likely root cause service. Interim: PM Lead can manually link observations during triage. |
| R5 | **Monitoring gaps**: Not all services have full instrumentation. The system generates incomplete or misleading observations for partially monitored services. | High | Medium | FR-008 validates connectivity and reports coverage gaps. FR-022 includes data source availability in each report. NFR-004 requires graceful degradation. Phase 2 (user story 26): actively track and report monitoring coverage gaps. |
| R6 | **Cost overrun**: Observation runs consume significant Claude tokens, especially across many services at high frequency. | Medium | Medium | NFR-005 caps token usage per run. FR-006 configurable schedule. Configuration schema allows per-service scope to limit blast radius. Token usage logged and reported in weekly digest. |
| R7 | **Cold start / no baseline**: On day 1, the system has no historical baseline for anomaly detection. It may generate spurious anomaly observations. | High | Low | FR-021 implements a 7-day learning mode for new services. During learning, only threshold-based error detection is active (anomaly and trend detection are suppressed). Baselines are established progressively. |
| R8 | **LLM hallucination in root cause analysis**: The Claude session may generate plausible but incorrect root cause hypotheses in observation reports. | Medium | Medium | Observation reports label root cause sections as "hypothesis" (not "cause"). The human triage gate prevents action on incorrect hypotheses. Phase 2: include a disclaimer and confidence score on all root cause hypotheses. |
| R9 | **Monitoring system overload**: Frequent PromQL/OpenSearch queries from observation runs could impact production monitoring performance. | Low | High | NFR-006 enforces read-only access. Observation schedule defaults to 4-hour intervals. Queries should use appropriate time ranges and avoid full-table scans. Configuration supports per-source query timeouts. |
| R10 | **Duplicate alerting**: Observations overlap with existing PagerDuty/OpsGenie alerts, creating confusion about which system is authoritative. | Medium | Medium | FR-009 (P2) cross-references active incidents to suppress duplicate observations. Documentation clarifies that the Production Intelligence Loop is a development-pipeline feedback tool, not an alerting system. Existing alerting remains authoritative for incident response. |

---

## 12. Phasing

### Phase 1: Observation Only (Weeks 1-6)

**Goal**: Establish the observation pipeline and demonstrate value with minimal risk.

| Component | Scope |
|-----------|-------|
| Monitoring Integration | Grafana, Prometheus, OpenSearch MCP connections (FR-001 through FR-003). Configurable schedule (FR-006) and scope (FR-007). |
| Error Detection | All error types (FR-010), severity classification (FR-011), deduplication (FR-013), false positive filtering (FR-014), configurable thresholds (FR-015, FR-016). |
| Usage Analytics | Key metrics tracking (FR-017) only. No anomaly detection or trend analysis. |
| Observation Reports | Full report format (FR-022), file storage (FR-023), no auto-pipeline (FR-024). |
| Human Triage Gate | File-based triage only (FR-027, FR-028). No notification channel integration. |
| Governance | Cooldown enforcement (FR-032) only. No oscillation detection or effectiveness tracking. |
| Data Safety | Full PII scrubbing (FR-037), secret detection (FR-038), scrub-before-process (FR-039). |
| Baseline Bootstrap | 7-day learning mode for new services (FR-021). |

**Exit criteria**: 
- 3+ observation runs complete successfully with zero PII/secret leaks.
- PM Lead successfully triages 10+ observations via file-based interface.
- Signal-to-noise ratio > 40% (relaxed threshold for Phase 1).
- At least 1 observation promoted to PRD and successfully processed by pipeline.

### Phase 2: Automated Triage Suggestions (Weeks 7-14)

**Goal**: Reduce triage burden with AI-generated suggestions while maintaining human authority.

| Component | Scope |
|-----------|-------|
| Monitoring Integration | Add health endpoints (FR-004), connectivity validation (FR-008). |
| Error Detection | Per-service severity overrides (FR-012). |
| Usage Analytics | Add anomaly detection (FR-018), trend analysis (FR-019), feature adoption tracking (FR-020). |
| Observation Reports | Add confidence scores (FR-025), weekly digest (FR-026). |
| Human Triage Gate | System suggests a triage decision (promote/dismiss/defer/investigate) with confidence and reasoning. PM Lead still makes the final decision. Audit trail (FR-031). |
| Governance | Add oscillation detection (FR-033), lifecycle tracking (FR-034), effectiveness metrics (FR-035, FR-036). |
| Data Safety | Add retention policy (FR-040), access control (FR-041). |
| Cross-Service | Begin cross-service correlation for microservice cascade detection (addresses R4). |

**Exit criteria**:
- Triage suggestion accuracy > 70% (suggested decision matches PM Lead's actual decision).
- Signal-to-noise ratio > 60%.
- Fix effectiveness tracking operational for 3+ resolved observations.
- Weekly digest operational and reviewed by PM Lead.

### Phase 3: Auto-Promote with Human Override (Weeks 15-22)

**Goal**: Allow high-confidence observations to be auto-promoted to PRD with mandatory human override capability.

| Component | Scope |
|-----------|-------|
| Monitoring Integration | Add Sentry integration (FR-005), PagerDuty/OpsGenie cross-reference (FR-009). |
| Human Triage Gate | Observations with confidence > 0.9 and severity P0/P1 can be auto-promoted. PM Lead is notified immediately and can override (cancel the PRD) within a configurable window (default: 2 hours). All auto-promoted observations are flagged in the audit trail. Notification channel integration (FR-029) required for auto-promote. |
| Governance | Auto-promote subject to all governance rules (cooldown, oscillation detection). Auto-promote disabled during cooldown. |
| Notifications | Slack/Discord integration (FR-029) required for auto-promote to ensure PM Lead is notified. |

**Exit criteria**:
- Auto-promoted observations have > 90% approval rate from PM Lead (< 10% override rate).
- Zero auto-promoted PRDs that caused negative production impact.
- End-to-end loop demonstrated: observation -> auto-promote -> PRD -> implementation -> deployment -> metric improvement verified.

**Auto-promote safeguards**:
- Auto-promote is **opt-in** and disabled by default.
- Auto-promote is limited to P0/P1 severity with confidence > 0.9.
- Auto-promote is disabled when: cooldown is active, oscillation is detected, notification channel is unreachable (cannot notify PM Lead).
- PM Lead can disable auto-promote globally with a single configuration change.
- All auto-promoted actions are reversible within the override window.

---

## 13. Open Questions

| # | Question | Context | Impact | Proposed Owner |
|---|----------|---------|--------|---------------|
| OQ-1 | How should the system handle microservice cascade failures where the root cause service is not in the observation scope? | A database failure may only manifest as errors in upstream API services. If the database is not in scope, the system attributes the error to the wrong service. | May generate misleading observations and ineffective fix PRDs. | Staff Engineer |
| OQ-2 | What is the cost model for observation runs, and what is the acceptable monthly budget? | Each observation run is a Claude session consuming tokens. At 4-hour intervals across 10 services, that is 60 runs/day. At 50K tokens/run, that is 3M tokens/day. | Directly impacts schedule frequency and observation depth. Need to validate against actual token costs and budget. | PM Lead + Finance |
| OQ-3 | How should the system bootstrap when a service has no historical data? | FR-021 specifies a 7-day learning mode, but some services may have months of Prometheus history available. Should the system ingest historical data to accelerate baseline creation? | Faster time-to-value for new services, but adds complexity and cost to the bootstrapping process. | Staff Engineer |
| OQ-4 | Should observation reports be stored in each service's repo or in a central observations repo? | Storing in each service's repo keeps data local but fragments the digest. A central repo simplifies cross-service views but separates observations from the code they reference. | Affects file storage (FR-023), cross-service correlation, and access control. | PM Lead |
| OQ-5 | How should the system integrate with existing alerting without creating duplicate noise? | Engineers may receive a PagerDuty page AND an observation report for the same incident. FR-009 is P2 — should it be elevated to P1? | Risk R10 (duplicate alerting) directly impacts user trust. If engineers perceive observations as redundant, adoption fails. | PM Lead + On-Call Lead |
| OQ-6 | What is the right default observation schedule? | 4 hours is proposed, but this may be too frequent for stable services and too infrequent for critical ones. Should the schedule be adaptive (more frequent after recent issues, less frequent during stable periods)? | Affects cost, noise level, and detection latency. | PM Lead |
| OQ-7 | How should the PII scrubbing pipeline be validated and kept current? | PII patterns evolve (new formats, new regulations). The regex-based approach in FR-037 may have gaps. Should the system use a dedicated PII detection library rather than custom regex? | Directly impacts R1 (PII/secret leakage), which is a critical risk. | Staff Engineer + Security |
| OQ-8 | Should effectiveness tracking account for external factors? | A metric may improve after a fix due to unrelated changes (traffic drop, infrastructure upgrade). Simple before/after comparison (FR-035) may attribute improvement incorrectly. | Overstating fix effectiveness undermines trust in the metric. May need control metrics or confidence intervals. | Staff Engineer |
| OQ-9 | What happens when the PM Lead is unavailable for triage? | If no triage occurs for multiple cycles, observations accumulate. Should there be escalation to a backup triager? Should auto-suggest (Phase 2) be the fallback? | Observations stall, detection-to-action latency degrades, value of the system diminishes. | PM Lead |
| OQ-10 | How should the system handle services that are intentionally noisy (e.g., canary deployments, A/B tests with expected error rates)? | Canary deployments may intentionally route traffic to unstable code. A/B tests may have control groups with different error profiles. | Without awareness of deployment strategies, the system may generate false positives for intentional experiments. | Staff Engineer |

---

## 14. Appendix

### A. Glossary

| Term | Definition |
|------|-----------|
| **Observation** | A structured report generated by the Production Intelligence Loop documenting a detected production signal (error, anomaly, trend, or adoption metric). |
| **Observation Run** | A single scheduled execution of the intelligence engine that queries monitoring systems and generates observations. |
| **Triage** | The human decision-making process where a PM Lead evaluates an observation and decides on an action (promote, dismiss, defer, investigate). |
| **Promote** | The triage decision to convert an observation into a PRD that enters the autonomous development pipeline. |
| **Cooldown** | A configurable quiet period after a fix is deployed, during which new observations for the same area are suppressed from triage. |
| **Oscillation** | A pattern where the same area generates repeated observations, suggesting a systemic issue rather than an incremental fix opportunity. |
| **Effectiveness** | A metric measuring whether an observation-generated fix actually improved the target production metric. |
| **Learning Mode** | An initial period for new services where the system collects baseline metrics without generating anomaly or trend observations. |
| **Scrub-before-process** | The architectural principle that all production data passes through PII/secret scrubbing before reaching the LLM. |

### B. Related Documents

| Document | Relationship |
|----------|-------------|
| PRD-001: Pipeline Orchestration | The pipeline that observation-promoted PRDs feed into. |
| PRD-003: Deployment & Delivery | The deployment system that ships fixes, which the effectiveness tracker monitors. |
| Architectural Review Notes | Source of the "observe and report, not observe and act" constraint and the human triage gate requirement. |

### C. Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-04-08 | PM Lead | Initial draft |
