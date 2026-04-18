# TDD-007: Production Intelligence Loop

| Field          | Value                                                                  |
|----------------|------------------------------------------------------------------------|
| **Title**      | Production Intelligence Loop -- Technical Design                       |
| **Version**    | 1.0                                                                    |
| **Date**       | 2026-04-08                                                             |
| **Author**     | Patrick Watson                                                         |
| **Status**     | Draft                                                                  |
| **Parent PRD** | PRD-005: Production Intelligence Loop                                  |
| **Depends on** | TDD-001 (Pipeline Orchestration Core), TDD-003 (Deployment & Delivery) |

---

## 1. Overview

This document describes the technical design for the Production Intelligence Loop: a closed-loop system that observes production telemetry through MCP server integrations, generates structured observation reports, routes them through a human triage gate, and tracks whether resulting fixes are effective.

The system follows three invariants:

1. **Read-only production access.** Every MCP call is a query, never a mutation. The system cannot modify dashboards, silence alerts, or write to log indices.
2. **Scrub-before-process.** Raw production data passes through a PII/secret scrubbing pipeline before it reaches the LLM context window or is persisted to disk.
3. **Human gate is mandatory.** No observation enters the autonomous development pipeline without an explicit human triage decision (Phases 1-2). Phase 3 introduces auto-promotion with mandatory human override.

### Scope

This TDD covers the full Production Intelligence Loop:

- MCP server integration architecture (Grafana, Prometheus, OpenSearch, Sentry)
- Scheduled observation runner
- Data collection pipeline (query, scrub, analyze, report)
- PII/secret scrubbing layer
- Error detection and classification engine
- Severity scoring algorithm
- Deduplication strategy
- Usage analytics engine
- Observation report format and storage
- Human triage interface
- Feedback loop governance
- Observation-to-PRD promotion pipeline

---

## 2. Architecture

### 2.1 High-Level Data Flow

```
                        +-------------------+
                        |   Cron / Timer    |
                        |  (schedule runner)|
                        +--------+----------+
                                 |
                                 v
                   +-------------+-------------+
                   |   Observation Runner       |
                   |   (Claude Code session)    |
                   +-------------+-------------+
                                 |
              +------------------+------------------+
              |                  |                   |
              v                  v                   v
     +--------+------+  +-------+-------+  +--------+------+
     | Grafana MCP   |  | Prometheus MCP|  | OpenSearch MCP|
     | (dashboards,  |  | (PromQL       |  | (log search,  |
     |  alerts)      |  |  time-series) |  |  aggregations)|
     +--------+------+  +-------+-------+  +--------+------+
              |                  |                   |
              +------------------+------------------+
                                 |
                                 v
                   +-------------+-------------+
                   |   Data Safety Pipeline    |
                   |  PII Scrub -> Secret Det  |
                   +-------------+-------------+
                                 |
                                 v
                   +-------------+-------------+
                   |   Intelligence Engine     |
                   | +-------+ +-------------+ |
                   | | Error | | Anomaly     | |
                   | | Detect| | Detection   | |
                   | +-------+ +-------------+ |
                   | +-------+ +-------------+ |
                   | | Trend | | Feature     | |
                   | | Anal. | | Adoption    | |
                   | +-------+ +-------------+ |
                   | +-------------------------+|
                   | | Dedup + Classification  ||
                   | +-------------------------+|
                   +-------------+-------------+
                                 |
                                 v
                   +-------------+-------------+
                   |   Report Generator        |
                   |  YAML frontmatter + MD    |
                   +-------------+-------------+
                                 |
                                 v
              .autonomous-dev/observations/YYYY/MM/
                                 |
                                 v
                   +-------------+-------------+
                   |   Human Triage Gate       |
                   |  file-based | notification|
                   +-------------+-------------+
                        |               |
                  (promote)        (dismiss/defer/
                        |          investigate)
                        v
                   +----+----+
                   | PRD Gen |
                   +---------+
                        |
                        v
               Autonomous Dev Pipeline
                        |
                        v
                   +---------+
                   | Deploy  |
                   +---------+
                        |
                        v
              +-------------------+
              | Effectiveness     |
              | Tracker           |
              | (post-deploy      |
              |  metric compare)  |
              +--------+----------+
                       |
                       v
              Feeds back into next observation run
```

### 2.2 Component Inventory

| Component | Type | Trigger | Outputs |
|-----------|------|---------|---------|
| Schedule Runner | Shell script / Claude Code `schedule` skill | Cron expression or interval timer | Launches Claude Code session |
| MCP Adapters | MCP server connections (4 adapters) | Called by observation runner | Raw query results |
| Data Safety Pipeline | TypeScript library | Receives raw data, returns scrubbed data | Scrubbed strings, redaction audit log |
| Intelligence Engine | Claude Code session logic (prompt-driven) | Receives scrubbed data | Candidate observations |
| Deduplication Engine | Fingerprint comparison (deterministic) | Candidate observations | Deduplicated observation set |
| Report Generator | File writer (YAML + Markdown) | Deduplicated observations | `.md` files in observations directory |
| Triage Processor | YAML frontmatter reader | Runs at start of each observation run | Triage decisions applied |
| PRD Generator | Template + Claude session | Promoted observation | PRD file in pipeline format |
| Effectiveness Tracker | PromQL comparison | Post-cooldown check | Effectiveness field update |
| Governance Engine | State machine (cooldown, oscillation) | Each observation run | Governance flags on observations |

### 2.3 Directory Layout

```
.autonomous-dev/
  config/
    intelligence.yaml          # Primary configuration
  observations/
    YYYY/
      MM/
        OBS-YYYYMMDD-HHMMSS-<short-id>.md   # Individual observations
    digests/
      DIGEST-YYYYWNN.md       # Weekly digests (e.g., DIGEST-2026W15.md)
    archive/                   # Observations past retention period
  baselines/
    <service-name>.json        # Rolling baseline metrics per service
  fingerprints/
    <service-name>.json        # Known fingerprints for dedup
  logs/
    intelligence/
      RUN-YYYYMMDD-HHMMSS.log # Per-run audit log
```

---

## 3. Detailed Design

### 3.1 MCP Server Integration Architecture

Each monitoring backend is accessed through an MCP server configured in the plugin's `.mcp.json`. The observation runner calls MCP tools by name; it never makes direct HTTP calls to monitoring APIs.

#### 3.1.1 MCP Server Definitions

```jsonc
// .mcp.json (plugin-level)
{
  "mcpServers": {
    "grafana": {
      "type": "sse",
      "url": "${GRAFANA_MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${GRAFANA_MCP_TOKEN}"
      }
    },
    "prometheus": {
      "type": "sse",
      "url": "${PROMETHEUS_MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${PROMETHEUS_MCP_TOKEN}"
      }
    },
    "opensearch": {
      "type": "sse",
      "url": "${OPENSEARCH_MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${OPENSEARCH_MCP_TOKEN}"
      }
    },
    "sentry": {
      "type": "sse",
      "url": "${SENTRY_MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${SENTRY_MCP_TOKEN}"
      }
    }
  }
}
```

#### 3.1.2 MCP Tool Catalog

Each MCP server exposes a set of tools. The observation runner calls only the subset it needs:

| MCP Server | Tool | Purpose | Phase |
|------------|------|---------|-------|
| `prometheus` | `prometheus_query` | Execute instant PromQL query | 1 |
| `prometheus` | `prometheus_query_range` | Execute range PromQL query over time window | 1 |
| `grafana` | `grafana_get_dashboard` | Retrieve dashboard panel data by UID | 1 |
| `grafana` | `grafana_list_alerts` | List current alert states | 1 |
| `grafana` | `grafana_get_annotations` | Get annotation events (deploy markers, etc.) | 1 |
| `opensearch` | `opensearch_search` | Execute a search query against a log index | 1 |
| `opensearch` | `opensearch_aggregate` | Run aggregation queries (error counts, top-N) | 1 |
| `sentry` | `sentry_list_issues` | List error issues for a project | 3 |
| `sentry` | `sentry_get_issue_events` | Get events/stack traces for a specific issue | 3 |
| `sentry` | `sentry_get_release_health` | Get crash-free rate and adoption for a release | 3 |

#### 3.1.3 Connectivity Validation

At the start of each observation run, the runner executes a connectivity check:

```
for each configured MCP server:
  1. Call a lightweight probe tool (e.g., prometheus_query with `up`)
  2. Record result: available | degraded (slow response >5s) | unreachable
  3. If unreachable, log warning and exclude from this run
  4. Include availability status in the observation run metadata
```

If Prometheus is unreachable, error-rate-based detection is skipped but log-based detection via OpenSearch continues. The observation report notes which data sources were unavailable.

#### 3.1.4 Query Budget

To prevent monitoring system overload (Risk R9), each observation run enforces a per-source query budget:

| Source | Max Queries Per Service Per Run | Query Timeout |
|--------|-------------------------------|---------------|
| Prometheus | 20 | 30s |
| Grafana | 10 | 30s |
| OpenSearch | 15 | 60s |
| Sentry | 10 | 30s |

If the budget is exhausted, the runner logs a warning and proceeds with collected data.

### 3.2 Scheduled Observation Runner

#### 3.2.1 Scheduling Mechanism

The observation runner is a Claude Code session launched by the `schedule` skill (remote agent trigger). Configuration supports two formats:

- **Cron expression**: `"0 */4 * * *"` (every 4 hours at minute 0)
- **Simple interval**: `"4h"` (converted to cron internally)

The schedule trigger invokes a dedicated command:

```
/autonomous-dev:observe --scope <service|all> --run-id <generated>
```

#### 3.2.2 Runner Lifecycle

```
1. INITIALIZE
   a. Load configuration from .autonomous-dev/config/intelligence.yaml
   b. Generate run ID: RUN-YYYYMMDD-HHMMSS
   c. Open audit log: .autonomous-dev/logs/intelligence/RUN-<id>.log
   d. Validate MCP connectivity (section 3.1.3)

2. PROCESS PENDING TRIAGE
   a. Scan .autonomous-dev/observations/ for files with triage_status != pending
      that have not been processed
   b. Execute triage decisions (section 3.10)

3. FOR EACH SERVICE IN SCOPE
   a. DATA COLLECTION
      i.   Query Prometheus for error rates, latency percentiles, throughput
      ii.  Query Grafana for alert states and recent annotations
      iii. Query OpenSearch for error log samples and aggregations
      iv.  Query health endpoint (Phase 2+)
      v.   Query Sentry for error issues (Phase 3)
   b. DATA SAFETY
      i.   Run PII scrubbing on all collected log text
      ii.  Run secret detection on all collected data
      iii. Log redaction counts to audit log
   c. ANALYSIS
      i.   Error detection (threshold + classification)
      ii.  Anomaly detection (Phase 2+: statistical deviation from baseline)
      iii. Trend analysis (Phase 2+: slope over rolling windows)
      iv.  Feature adoption check (Phase 2+: new endpoint traffic)
   d. DEDUPLICATION
      i.   Generate fingerprint for each candidate observation
      ii.  Compare against known fingerprints and recent observations
      iii. Merge duplicates, update occurrence count
   e. GOVERNANCE CHECK
      i.   Check cooldown status for this service + error class
      ii.  Check oscillation history
      iii. Flag observations accordingly
   f. REPORT GENERATION
      i.   Generate observation report (YAML frontmatter + markdown body)
      ii.  Write to .autonomous-dev/observations/YYYY/MM/

4. FINALIZE
   a. Log token consumption for this run
   b. Update baseline files if in learning mode
   c. Close audit log
```

#### 3.2.3 Concurrency Model

Independent services run sequentially within a single Claude session to stay within the token budget (NFR-005: 200K tokens for a full sweep). Parallel execution across sessions is supported for organizations with many services, using a lock file to prevent conflicting writes:

```
.autonomous-dev/observations/.lock-<service-name>
```

Lock files are advisory and expire after 60 minutes (stale lock cleanup).

### 3.3 Data Collection Pipeline

The pipeline follows a strict **query -> scrub -> analyze -> report** sequence. No raw production data bypasses the scrub step.

#### 3.3.1 Query Phase

For each service, the runner executes a fixed set of queries. The queries are parameterized by values from `intelligence.yaml`.

**Prometheus Queries** (see section 6 for full PromQL examples):

| Query Purpose | PromQL Template |
|--------------|-----------------|
| Error rate (5xx) | `sum(rate(http_requests_total{job="<job>", status=~"5.."}[<window>])) / sum(rate(http_requests_total{job="<job>"}[<window>])) * 100` |
| p50 latency | `histogram_quantile(0.50, sum(rate(http_request_duration_seconds_bucket{job="<job>"}[<window>])) by (le))` |
| p95 latency | `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{job="<job>"}[<window>])) by (le))` |
| p99 latency | `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{job="<job>"}[<window>])) by (le))` |
| Throughput (rps) | `sum(rate(http_requests_total{job="<job>"}[<window>]))` |
| Availability | `avg_over_time(up{job="<job>"}[<window>])` |
| Error rate by endpoint | `sum by (handler) (rate(http_requests_total{job="<job>", status=~"5.."}[<window>])) / sum by (handler) (rate(http_requests_total{job="<job>"}[<window>])) * 100` |

Default `<window>` is `30m` for the current snapshot, `1h` for the sustained check, and `7d`/`14d`/`30d` for trend analysis.

**OpenSearch Queries:**

```json
// Error log aggregation (top error messages, last 4 hours)
{
  "query": {
    "bool": {
      "must": [
        { "match": { "level": "ERROR" } },
        { "range": { "@timestamp": { "gte": "now-4h" } } }
      ],
      "filter": [
        { "term": { "service.name": "<service>" } }
      ]
    }
  },
  "aggs": {
    "error_messages": {
      "terms": { "field": "message.keyword", "size": 20 }
    }
  },
  "size": 50,
  "_source": ["@timestamp", "message", "level", "stack_trace", "trace_id"]
}
```

```json
// Error sample retrieval (latest 10 unique errors)
{
  "query": {
    "bool": {
      "must": [
        { "match": { "level": "ERROR" } },
        { "range": { "@timestamp": { "gte": "now-4h" } } }
      ],
      "filter": [
        { "term": { "service.name": "<service>" } }
      ]
    }
  },
  "collapse": { "field": "message.keyword" },
  "sort": [{ "@timestamp": "desc" }],
  "size": 10,
  "_source": ["@timestamp", "message", "stack_trace", "trace_id", "user_id", "request_path"]
}
```

**Grafana Queries:**

```
grafana_list_alerts(dashboard_uid="<uid>", state="alerting|pending")
grafana_get_annotations(dashboard_uid="<uid>", from=now-4h, to=now, tags=["deploy"])
```

#### 3.3.2 Scrub Phase

All text returned from OpenSearch (log messages, stack traces) and any string fields from other sources pass through the Data Safety Pipeline (section 3.4) before entering the LLM context or being written to disk.

#### 3.3.3 Analyze Phase

Scrubbed data is passed to the Intelligence Engine (sections 3.5 through 3.8) within the Claude session. The LLM receives a structured prompt containing:

- Scrubbed metric values (numbers, not raw logs)
- Scrubbed log excerpts
- Alert states
- Baseline values (from `.autonomous-dev/baselines/<service>.json`)
- Configuration thresholds

The LLM performs classification, root-cause hypothesis generation, and recommended-action determination. Deterministic checks (threshold comparison, deduplication fingerprinting) are performed outside the LLM in pre/post processing.

#### 3.3.4 Report Phase

The analysis output is formatted into the observation report schema (section 4.1) and written to disk.

### 3.4 PII/Secret Scrubbing Layer

#### 3.4.1 Architecture

The scrubbing pipeline is a two-stage filter applied to every string that originated from production data:

```
Raw Text -> Stage 1: PII Scrubber -> Stage 2: Secret Detector -> Clean Text
```

Both stages are **deterministic regex-based** (no LLM in the scrubbing path). This ensures:
- Predictable performance (NFR-002: <2s per 10K lines)
- Auditable behavior (each regex is explicit and testable)
- No risk of LLM hallucinating that something is or is not PII

#### 3.4.2 PII Patterns

| Type | Regex Pattern | Replacement | Notes |
|------|--------------|-------------|-------|
| Email | `[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}` | `[REDACTED:email]` | RFC 5322 simplified |
| Phone (US) | `\+?1?[\-.\s]?\(?\d{3}\)?[\-.\s]?\d{3}[\-.\s]?\d{4}` | `[REDACTED:phone]` | Matches +1-555-123-4567, (555) 123-4567, 5551234567 |
| Phone (Intl) | `\+\d{1,3}[\-.\s]?\d{4,14}` | `[REDACTED:phone]` | Catch-all for international formats |
| SSN | `\b\d{3}-\d{2}-\d{4}\b` | `[REDACTED:ssn]` | US Social Security Number |
| Credit Card | `\b\d{4}[\-\s]?\d{4}[\-\s]?\d{4}[\-\s]?\d{4}\b` | `[REDACTED:credit_card]` | Visa, MC, Discover; 16-digit |
| Credit Card (Amex) | `\b3[47]\d{2}[\-\s]?\d{6}[\-\s]?\d{5}\b` | `[REDACTED:credit_card]` | American Express; 15-digit |
| IPv4 | `\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b` | `[REDACTED:ip]` | Configurable: on by default |
| IPv6 | `\b([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b` | `[REDACTED:ip]` | Full-form IPv6; compressed forms also matched |
| IPv6 Compressed | `\b([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b` | `[REDACTED:ip]` | Matches `::1`, `fe80::1`, etc. Validated to avoid false positives on timestamps |
| JWT Token | `\beyJ[a-zA-Z0-9\-_]+\.eyJ[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+\b` | `[REDACTED:jwt]` | Detects base64-encoded JWT tokens in log output |
| UUID (user-id context) | Context-aware: only when field name suggests user identity | `[REDACTED:user_id]` | Applied only to fields named `user_id`, `customer_id`, `account_id` |

#### 3.4.3 Secret Patterns

| Type | Regex Pattern | Replacement |
|------|--------------|-------------|
| AWS Access Key | `AKIA[0-9A-Z]{16}` | `[SECRET_REDACTED]` |
| AWS Secret Key | `(?i)aws_secret_access_key[\s]*[=:][\s]*[A-Za-z0-9/+=]{40}` | `[SECRET_REDACTED]` |
| Stripe Secret Key | `sk_TESTONLY_[a-zA-Z0-9]{24,}` | `[SECRET_REDACTED]` |
| Stripe Publishable Key | `pk_TESTONLY_[a-zA-Z0-9]{24,}` | `[SECRET_REDACTED]` |
| GitHub PAT | `ghp_[a-zA-Z0-9]{36}` | `[SECRET_REDACTED]` |
| GitHub App Token | `ghs_[a-zA-Z0-9]{36}` | `[SECRET_REDACTED]` |
| GitHub OAuth | `gho_[a-zA-Z0-9]{36}` | `[SECRET_REDACTED]` |
| GitLab PAT | `glpat-[a-zA-Z0-9\-]{20,}` | `[SECRET_REDACTED]` |
| GCP Service Account Key | `"private_key":\s*"-----BEGIN [A-Z ]+ KEY-----` | `[SECRET_REDACTED]` |
| GCP API Key | `AIza[0-9A-Za-z\-_]{35}` | `[SECRET_REDACTED]` |
| Slack Bot Token | `xoxb-[0-9]{10,}-[a-zA-Z0-9]{24,}` | `[SECRET_REDACTED]` |
| Slack Webhook | `https://hooks\.slack\.com/services/T[a-zA-Z0-9]+/B[a-zA-Z0-9]+/[a-zA-Z0-9]+` | `[SECRET_REDACTED]` |
| Generic Bearer Token | `(?i)bearer\s+[a-zA-Z0-9\-_.~+/]+=*` | `[SECRET_REDACTED]` |
| Basic Auth | `(?i)basic\s+[a-zA-Z0-9+/]+=*` | `[SECRET_REDACTED]` |
| Private Key Block | `-----BEGIN (RSA\|EC\|DSA\|OPENSSH)? ?PRIVATE KEY-----` | `[SECRET_REDACTED]` |
| Generic High-Entropy | Strings >20 chars with entropy >4.5 bits/char in context of `password=`, `secret=`, `token=`, `key=` | `[SECRET_REDACTED]` |
| Env Var Pattern | `(?i)(.*_KEY\|.*_SECRET\|.*_TOKEN\|.*_PASSWORD)\s*[=:]\s*\S+` | Key name preserved, value replaced: `<KEY_NAME>=[SECRET_REDACTED]` |

#### 3.4.4 Scrubbing Implementation Strategy

```
function scrub(text: string, config: DataSafetyConfig): ScrubResult {
  let result = text
  let redactions: Redaction[] = []

  // Stage 1: PII
  for (const pattern of config.pii_patterns) {
    const matches = result.matchAll(new RegExp(pattern.regex, 'g'))
    for (const match of matches) {
      redactions.push({
        type: pattern.type,
        position: match.index,
        original_length: match[0].length
        // NOTE: original value is NEVER stored
      })
      result = result.replace(match[0], `[REDACTED:${pattern.type}]`)
    }
  }

  // Stage 2: Secrets
  for (const pattern of config.secret_patterns) {
    const matches = result.matchAll(new RegExp(pattern, 'g'))
    for (const match of matches) {
      redactions.push({
        type: 'secret',
        position: match.index,
        original_length: match[0].length
      })
      result = result.replace(match[0], '[SECRET_REDACTED]')
    }
  }

  return { text: result, redaction_count: redactions.length, redactions }
}
```

Key design decisions:
- PII scrubbing runs before secret detection so that email-like patterns in API keys do not get double-tagged.
- The `Redaction` struct records position and length but never the original value.
- Custom patterns from `intelligence.yaml` are appended to the default list, not replacing it.
- A post-scrub validation pass runs the full pattern list again to catch any residuals (defense-in-depth).

#### 3.4.5 Scrubbing Audit Log

Every scrub invocation logs:

```json
{
  "run_id": "RUN-20260408-1430",
  "service": "api-gateway",
  "source": "opensearch",
  "lines_processed": 50,
  "redactions": {
    "email": 12,
    "ip": 34,
    "phone": 0,
    "secret": 2,
    "jwt": 1
  },
  "processing_time_ms": 45
}
```

### 3.5 Error Detection and Classification Engine

Error detection combines **deterministic threshold checks** (outside the LLM) with **LLM-powered classification** (root cause, severity nuance, recommended action).

#### 3.5.1 Threshold-Based Detection (Deterministic)

The runner computes error metrics from Prometheus data and applies threshold rules:

```
for each service in scope:
  current_error_rate = query: error rate over last <sustained_duration> minutes
  threshold = config.error_detection.per_service_overrides[service]
              ?? config.error_detection.default_thresholds

  if current_error_rate > threshold.error_rate_percent:
    // Check sustained duration
    range_query = error rate at 1-minute resolution over <sustained_duration> minutes
    minutes_above_threshold = count(points where rate > threshold)

    if minutes_above_threshold >= threshold.sustained_duration_minutes:
      candidate_observation = {
        type: "error",
        metric_value: current_error_rate,
        threshold_value: threshold.error_rate_percent,
        sustained_minutes: minutes_above_threshold
      }
```

Additionally, the runner checks for:

| Error Type | Detection Method |
|------------|-----------------|
| Crash (process termination) | `up{job="<job>"} == 0` or `changes(up{job="<job>"}[1h]) > 0` |
| Exception (unhandled) | OpenSearch aggregation: count of `level:ERROR` grouped by exception class |
| Timeout | `histogram_quantile(0.99, ...) > <sla_threshold>` |
| Degraded performance | p95 latency exceeds 2x baseline |
| Data inconsistency | HTTP status 422/400 rate spike (application-level validation failures) |

#### 3.5.2 False Positive Filtering

Before a candidate observation proceeds to classification, it passes through filters:

```
function is_false_positive(candidate, config, current_time):
  // Check maintenance windows
  for window in config.false_positive_filters.maintenance_windows:
    if is_within_window(current_time, window):
      return { filtered: true, reason: "maintenance_window" }

  // Check excluded error patterns
  for pattern in config.false_positive_filters.excluded_error_patterns:
    if candidate.log_samples.any(line => line.matches(pattern)):
      return { filtered: true, reason: "excluded_pattern: " + pattern }

  // Check load test markers
  // (requires checking request headers/tags in OpenSearch data)
  for marker in config.false_positive_filters.load_test_markers:
    if candidate.request_metadata.has_marker(marker):
      return { filtered: true, reason: "load_test_traffic" }

  return { filtered: false }
```

#### 3.5.3 Severity Scoring Algorithm

Severity classification uses a scoring matrix. The deterministic scorer assigns an initial severity; the LLM may adjust it with justification.

**Scoring Matrix:**

| Factor | Weight | P0 (Critical) | P1 (High) | P2 (Medium) | P3 (Low) |
|--------|--------|--------------|-----------|-------------|----------|
| Error rate | 0.30 | > 50% | > 20% | > 5% | > 1% |
| Affected users (estimated) | 0.25 | > 10,000 or all users | > 1,000 | > 100 | < 100 |
| Service criticality | 0.20 | Revenue-critical path | Core feature | Secondary feature | Internal tooling |
| Duration | 0.15 | > 60 min and ongoing | > 30 min | > 10 min | < 10 min |
| Data integrity risk | 0.10 | Data loss confirmed | Data corruption possible | No data risk | No data risk |

**Scoring Algorithm:**

```
function compute_severity(candidate, service_config):
  score = 0.0

  // Error rate factor (0.0 - 1.0 mapped to thresholds)
  error_rate = candidate.metric_value
  if error_rate > 50: score += 0.30 * 1.0      // P0 range
  elif error_rate > 20: score += 0.30 * 0.75    // P1 range
  elif error_rate > 5: score += 0.30 * 0.50     // P2 range
  elif error_rate > 1: score += 0.30 * 0.25     // P3 range

  // Affected users (estimated from throughput * error_rate * duration)
  affected = estimate_affected_users(candidate)
  if affected > 10000: score += 0.25 * 1.0
  elif affected > 1000: score += 0.25 * 0.75
  elif affected > 100: score += 0.25 * 0.50
  else: score += 0.25 * 0.25

  // Service criticality (from config)
  criticality = service_config.criticality  // "critical" | "high" | "medium" | "low"
  criticality_scores = { critical: 1.0, high: 0.75, medium: 0.50, low: 0.25 }
  score += 0.20 * criticality_scores[criticality]

  // Duration
  duration_minutes = candidate.sustained_minutes
  if duration_minutes > 60: score += 0.15 * 1.0
  elif duration_minutes > 30: score += 0.15 * 0.75
  elif duration_minutes > 10: score += 0.15 * 0.50
  else: score += 0.15 * 0.25

  // Data integrity (from log analysis -- presence of specific error classes)
  if candidate.has_data_loss_indicator: score += 0.10 * 1.0
  elif candidate.has_data_corruption_indicator: score += 0.10 * 0.75
  else: score += 0.10 * 0.0

  // Map score to severity
  if score >= 0.75: return "P0"
  elif score >= 0.55: return "P1"
  elif score >= 0.35: return "P2"
  else: return "P3"
```

The LLM may override the deterministic severity by one level (up or down) with written justification. It cannot override by more than one level without the deterministic score also supporting it -- this prevents hallucinated severity inflation.

### 3.6 Deduplication Strategy

#### 3.6.1 Fingerprint Generation

Each candidate observation is assigned a fingerprint based on its structural characteristics. Observations with matching fingerprints are deduplicated.

**Fingerprint components:**

```
fingerprint = sha256(
  service_name +
  error_class +          // e.g., "ConnectionPoolExhausted", "TimeoutError"
  affected_endpoint +    // e.g., "/api/v2/orders" or "*" if service-wide
  error_code +           // HTTP status code or application error code
  stack_trace_top_3      // Top 3 frames of stack trace (normalized)
)
```

**Stack trace normalization:** Before hashing, stack traces are normalized to remove:
- Line numbers (which change across deployments)
- Memory addresses
- Thread IDs
- Timestamps within the trace

This ensures that the same logical error in two deployments produces the same fingerprint.

#### 3.6.2 Deduplication Windows

| Window | Purpose |
|--------|---------|
| **Intra-run** (within current observation run) | Multiple error instances in the same run are merged into one observation with `occurrence_count` |
| **Inter-run** (across observation runs, last 7 days) | If a fingerprint matches a recent observation that is still `pending` triage, the new occurrence is appended as an update to the existing observation rather than creating a new one |
| **Post-triage** (after triage decision) | If a fingerprint matches a `dismissed` observation from the last 30 days, the new observation is auto-dismissed with reason `"previously_dismissed_duplicate"` and logged. If it matches a `promoted` observation, it is flagged as `"related_to_promoted"` |

#### 3.6.3 Fingerprint Storage

```json
// .autonomous-dev/fingerprints/api-gateway.json
{
  "fingerprints": [
    {
      "hash": "a3f8c2d1e9b0...",
      "service": "api-gateway",
      "error_class": "ConnectionPoolExhausted",
      "endpoint": "/api/v2/orders",
      "first_seen": "2026-04-01T10:00:00Z",
      "last_seen": "2026-04-08T14:30:22Z",
      "occurrence_count": 7,
      "linked_observation_id": "OBS-20260408-143022-a7f3",
      "triage_status": "pending"
    }
  ]
}
```

#### 3.6.4 Similarity Matching

In addition to exact fingerprint matching, a fuzzy similarity layer catches near-duplicates:

- Stack traces with >80% frame overlap (Jaccard similarity on normalized frames) are considered similar
- Error messages with Levenshtein distance < 20% of message length are considered similar
- Temporally correlated errors (same service, error spike starting within 5 minutes) are grouped

When fuzzy matching triggers, the runner presents both the new candidate and the similar existing observation to the LLM for a merge/separate decision.

### 3.7 Usage Analytics Engine

#### 3.7.1 Baseline Calculation

Baselines are stored per-service and updated on each observation run:

```json
// .autonomous-dev/baselines/api-gateway.json
{
  "service": "api-gateway",
  "learning_mode": false,
  "learning_started": "2026-03-25T00:00:00Z",
  "learning_completed": "2026-04-01T00:00:00Z",
  "last_updated": "2026-04-08T14:30:22Z",
  "metrics": {
    "error_rate": {
      "mean_7d": 0.42,
      "stddev_7d": 0.18,
      "mean_14d": 0.45,
      "stddev_14d": 0.21,
      "mean_30d": 0.48,
      "stddev_30d": 0.24,
      "p50": 0.35,
      "p95": 0.89,
      "p99": 1.12
    },
    "latency_p50_ms": {
      "mean_7d": 45.2,
      "stddev_7d": 8.1,
      "mean_14d": 44.8,
      "stddev_14d": 8.5,
      "mean_30d": 43.9,
      "stddev_30d": 9.2,
      "p50": 44.0,
      "p95": 58.0,
      "p99": 72.0
    },
    "latency_p99_ms": { "...": "..." },
    "throughput_rps": { "...": "..." },
    "availability": { "...": "..." }
  }
}
```

**Learning mode** (FR-021): For the first 7 days after a service is added, the system:
1. Collects metrics on every observation run
2. Computes rolling statistics but does NOT generate anomaly or trend observations
3. Threshold-based error detection (section 3.5.1) remains active
4. After 7 days (minimum 6 observation runs), learning mode completes and anomaly/trend detection activates

**Baseline update algorithm:**

```
on each observation run:
  for each metric:
    new_value = current observation value
    // Exponentially weighted moving average (alpha = 0.1)
    // Prevents sudden shifts from distorting the baseline
    baseline.mean_7d = 0.9 * baseline.mean_7d + 0.1 * new_value
    // Standard deviation updated similarly
    baseline.stddev_7d = sqrt(0.9 * baseline.stddev_7d^2 + 0.1 * (new_value - baseline.mean_7d)^2)
```

For the 14d and 30d windows, the system queries Prometheus `avg_over_time` and `stddev_over_time` directly rather than maintaining a rolling calculation, as Prometheus retains the source data.

#### 3.7.2 Anomaly Detection

Anomaly detection uses the configured method (default: z-score) to identify statistically significant deviations:

**Z-Score Method:**

```
z = (current_value - baseline_mean) / baseline_stddev

if abs(z) > config.anomaly_detection.sensitivity (default: 2.5):
  flag as anomaly
  direction = "above" if z > 0 else "below"
```

**IQR Method** (alternative):

```
Q1 = baseline.p25
Q3 = baseline.p75
IQR = Q3 - Q1
lower_bound = Q1 - 1.5 * IQR
upper_bound = Q3 + 1.5 * IQR

if current_value < lower_bound or current_value > upper_bound:
  flag as anomaly
```

Anomaly observations are generated only when:
- The service is NOT in learning mode
- The anomaly persists across 2 consecutive observation runs (to filter transient spikes)
- The deviation is in a "bad" direction (increased error rate, increased latency, decreased throughput, decreased availability)

#### 3.7.3 Trend Analysis

Trend analysis detects gradual degradation using linear regression slope over the configured windows:

```
for each metric, for each window in [7d, 14d, 30d]:
  // Query Prometheus for hourly data points over the window
  data_points = prometheus_query_range(
    metric_query, start=now-<window>, end=now, step=1h
  )

  // Compute linear regression slope
  slope = linear_regression_slope(data_points)

  // Normalize slope as percentage change per window
  pct_change = (slope * window_hours) / baseline_mean * 100

  if abs(pct_change) > config.trend_analysis.min_slope_threshold (default: 5%):
    if direction is "degrading" (higher error rate, higher latency, lower throughput):
      generate trend observation
      estimate "days until threshold breach" by extrapolation
```

**PromQL for trend data** (7-day hourly latency):

```promql
avg_over_time(
  histogram_quantile(0.95,
    sum(rate(http_request_duration_seconds_bucket{job="api-gateway"}[5m])) by (le)
  )[7d:1h]
)
```

#### 3.7.4 Feature Adoption Tracking

For newly deployed endpoints (detected via Grafana deploy annotations):

```
1. Get recent deploy annotations from Grafana
2. For each deploy within the last 7 days:
   a. Identify new or changed endpoints (from deploy metadata or diff)
   b. Query Prometheus for traffic to those endpoints:
      sum(rate(http_requests_total{job="<job>", handler="<new_endpoint>"}[1h]))
   c. Report:
      - First observed traffic timestamp
      - Current traffic volume (rps)
      - Error rate on the new endpoint
      - Comparison to similar endpoints (if available)
```

### 3.8 Confidence Scoring

Each observation includes a confidence score (0.0 - 1.0) combining three factors:

```
confidence = w_evidence * evidence_score
           + w_dedup * dedup_score
           + w_history * history_score

where:
  w_evidence = 0.50  (weight for evidence strength)
  w_dedup    = 0.25  (weight for deduplication match quality)
  w_history  = 0.25  (weight for historical false positive rate)
```

**Evidence score** (0.0 - 1.0):

| Condition | Score |
|-----------|-------|
| Metric + Log + Alert all corroborate | 1.0 |
| Metric + Log corroborate | 0.8 |
| Metric only, sustained | 0.7 |
| Log only, high volume | 0.6 |
| Single data source, borderline | 0.4 |
| Data source gaps (e.g., Prometheus unavailable) | 0.3 |

**Dedup score** (0.0 - 1.0):

| Condition | Score |
|-----------|-------|
| Exact fingerprint match to a previously promoted observation | 1.0 |
| Fuzzy match (>80% similarity) to a promoted observation | 0.8 |
| New fingerprint, no matches | 0.5 |
| Similar to a previously dismissed observation | 0.3 |

**History score** (0.0 - 1.0):

| Condition | Score |
|-----------|-------|
| Similar observations historically promoted at >80% rate | 1.0 |
| Mixed triage history (50-80% promote rate) | 0.7 |
| New pattern, no history | 0.5 |
| Similar observations historically dismissed at >50% rate | 0.2 |

### 3.9 Observation Report Format

Reports follow YAML frontmatter + Markdown body format (FR-022, FR-023).

#### 3.9.1 File Naming

```
.autonomous-dev/observations/YYYY/MM/OBS-YYYYMMDD-HHMMSS-<short-id>.md
```

Where `<short-id>` is the first 4 characters of a random hex string.

#### 3.9.2 Full Report Example

```yaml
---
id: OBS-20260408-143022-a7f3
timestamp: "2026-04-08T14:30:22Z"
service: api-gateway
repo: org/api-gateway
type: error
severity: P1
confidence: 0.87
triage_status: pending
triage_decision: null
triage_by: null
triage_at: null
triage_reason: null
cooldown_active: false
linked_prd: null
linked_deployment: null
effectiveness: null
observation_run_id: RUN-20260408-1430
tokens_consumed: 12340
fingerprint: a3f8c2d1e9b04f72
occurrence_count: 1
data_sources:
  prometheus: available
  grafana: available
  opensearch: available
  sentry: not_configured
related_observations: []
---

# Observation: Elevated 5xx Error Rate on /api/v2/orders

## Summary

The `/api/v2/orders` endpoint has been returning HTTP 503 responses at a rate
of 12.3% over the past 45 minutes, compared to a baseline of 0.4%. The error
correlates with a deployment of commit `abc1234` at 13:45 UTC.

## Severity Rationale

| Factor | Value | Score |
|--------|-------|-------|
| Error rate | 12.3% (>5%, <20%) | P2 range |
| Estimated affected users | ~2,400 | P1 range |
| Service criticality | critical | P0 range |
| Duration | 45 min, ongoing | P1 range |
| Data integrity | No indicators | N/A |
| **Weighted score** | **0.63** | **P1** |

## Evidence

### Metrics (Prometheus)

| Metric | Current | Baseline (7d) | Threshold |
|--------|---------|---------------|-----------|
| Error rate (5xx) | 12.3% | 0.4% +/- 0.18% | 5.0% |
| p99 latency | 8,200 ms | 340 ms +/- 45 ms | N/A |
| Throughput | 53 rps | 58 rps +/- 6 rps | N/A |
| Availability | 87.7% | 99.6% | N/A |

### Logs (OpenSearch)

**Top error (1,847 occurrences in last 45 min):**

```
[ERROR] ConnectionPoolExhausted: pool "orders-db" max_connections=50
        active=50 waiting=312 user=[REDACTED:email]
        trace_id=[REDACTED:ip]
```

**First occurrence:** 2026-04-08T13:47:12Z

### Alerts (Grafana)

- Alert "API Gateway 5xx Rate" firing since 13:52 UTC
- Deploy annotation: commit `abc1234` deployed at 13:45 UTC

## Root Cause Hypothesis

> **Note: This is a hypothesis generated by the intelligence engine, not a
> confirmed root cause. Verify before acting.**

The deployment at 13:45 UTC likely introduced a connection pool leak or
increased per-request connection hold time, exhausting the database connection
pool under normal traffic load. Evidence: the `ConnectionPoolExhausted` error
first appeared 2 minutes after deployment, and the pool shows max active
connections (50/50) with a large wait queue (312).

## Recommended Action

**Fix**: Investigate the connection pool configuration change in commit
`abc1234`. Likely requires increasing pool size or fixing a connection leak.

## Related Observations

None (first occurrence of this pattern).
```

### 3.10 Human Triage Interface

#### 3.10.1 File-Based Triage (Primary -- Phase 1+)

The PM Lead triages by editing the YAML frontmatter of observation reports:

```yaml
# Before triage (system-generated)
triage_status: pending
triage_decision: null
triage_by: null
triage_at: null
triage_reason: null

# After triage (PM Lead edits)
triage_status: promoted        # promoted | dismissed | deferred | investigating
triage_decision: promote       # promote | dismiss | defer | investigate
triage_by: pwatson
triage_at: "2026-04-08T15:12:00Z"
triage_reason: "Connection pool issue confirmed. Needs fix PRD."
```

For deferred observations, an optional `defer_until` field:

```yaml
triage_decision: defer
triage_reason: "Wait for next deploy cycle to see if existing fix resolves it."
defer_until: "2026-04-15"
```

#### 3.10.2 Triage Processing

At the start of each observation run (step 2 in the runner lifecycle), the triage processor:

```
1. Scan all observation files with triage_status == pending
2. For each file where triage_decision is not null:
   a. Validate decision is one of: promote, dismiss, defer, investigate
   b. Update triage_status to match triage_decision
   c. If promoted: trigger PRD generation (section 3.12)
   d. If dismissed: update fingerprint store with dismissal
   e. If deferred: set reminder for defer_until date
   f. If investigating: flag for additional data collection on next run
   g. Log triage decision to audit trail
3. Check deferred observations where defer_until <= today:
   a. Reset triage_status to pending
   b. Add note: "Deferred observation returned for re-triage"
```

#### 3.10.3 Notification-Based Triage (Optional -- Phase 3)

When configured with a Slack/Discord webhook, the system posts observation summaries:

```
:warning: New P1 Observation: api-gateway

Elevated 5xx Error Rate on /api/v2/orders
Error rate: 12.3% (baseline: 0.4%)
Confidence: 0.87

Recommended: Fix

Reply with:
  /promote OBS-20260408-143022-a7f3 <reason>
  /dismiss OBS-20260408-143022-a7f3 <reason>
  /defer OBS-20260408-143022-a7f3 <date> <reason>
  /investigate OBS-20260408-143022-a7f3
```

The notification channel writes decisions back to the file-based system, keeping the file as the source of truth.

### 3.11 Feedback Loop Governance

#### 3.11.1 Cooldown Enforcement

```
function check_cooldown(service, error_class, config):
  // Find the most recent deployment linked to a promoted observation
  // for this service + error_class combination
  recent_fix_deploy = find_recent_fix_deployment(service, error_class)

  if recent_fix_deploy is null:
    return { active: false }

  deploy_date = recent_fix_deploy.deployed_at
  cooldown_end = deploy_date + config.governance.cooldown_days days

  if now < cooldown_end:
    return {
      active: true,
      reason: "Fix deployed on ${deploy_date}, cooldown until ${cooldown_end}",
      linked_deployment: recent_fix_deploy.id
    }

  return { active: false }
```

During cooldown, observations are still generated (for audit purposes) but flagged:

```yaml
cooldown_active: true
triage_status: cooldown
```

They are excluded from the triage queue until cooldown expires.

#### 3.11.2 Oscillation Detection

```
function check_oscillation(service, error_class, config):
  window_start = now - config.governance.oscillation_window_days days
  recent_observations = find_observations(
    service=service,
    error_class=error_class,
    created_after=window_start
  )

  if len(recent_observations) >= config.governance.oscillation_threshold:
    return {
      oscillating: true,
      count: len(recent_observations),
      window_days: config.governance.oscillation_window_days,
      observation_ids: [obs.id for obs in recent_observations],
      recommendation: "systemic_investigation"
    }

  return { oscillating: false }
```

When oscillation is detected, the observation report includes:

```markdown
## Oscillation Warning

This service + error class combination has generated 4 observations in the
last 30 days. This suggests a systemic issue that incremental fixes are not
resolving.

**Previous observations:**
- OBS-20260310-... (promoted, fix deployed, not effective)
- OBS-20260318-... (promoted, fix deployed, partially effective)
- OBS-20260325-... (promoted, fix in progress)
- OBS-20260408-... (this observation)

**Recommendation:** Promote as an architectural investigation PRD rather than
an incremental fix PRD.
```

#### 3.11.3 Effectiveness Tracking

After a cooldown period expires, the effectiveness tracker compares metrics:

```
function evaluate_effectiveness(observation, config):
  // Get the deployment linked to the observation's PRD
  deployment = get_deployment(observation.linked_deployment)
  if deployment is null:
    return "pending"

  deploy_date = deployment.deployed_at
  pre_window = [deploy_date - config.governance.effectiveness_comparison_days days, deploy_date]
  post_window = [deploy_date + config.governance.cooldown_days days,
                 deploy_date + config.governance.cooldown_days days +
                 config.governance.effectiveness_comparison_days days]

  // Query the relevant metric for both windows
  pre_avg = prometheus_query_range(observation.target_metric, pre_window).avg()
  post_avg = prometheus_query_range(observation.target_metric, post_window).avg()

  // For error rates: improvement means decrease
  // For latency: improvement means decrease
  // For throughput: improvement means increase
  improvement_pct = compute_improvement(observation.metric_type, pre_avg, post_avg)

  if improvement_pct >= config.governance.effectiveness_improvement_threshold:
    return "improved"
  elif improvement_pct <= -config.governance.effectiveness_improvement_threshold:
    return "degraded"
  else:
    return "unchanged"
```

The effectiveness result is written back to the observation report:

```yaml
effectiveness: improved  # improved | unchanged | degraded | pending
effectiveness_detail:
  pre_fix_avg: 12.3
  post_fix_avg: 0.6
  improvement_pct: 95.1
  measured_window: "2026-04-16 to 2026-04-23"
```

### 3.12 Observation-to-PRD Promotion Pipeline

When an observation is promoted, the system generates a PRD suitable for the autonomous development pipeline.

#### 3.12.1 PRD Generation Process

```
1. Read the promoted observation report
2. Extract structured data:
   - service, repo, severity, evidence, root cause hypothesis,
     recommended action, metric values
3. Generate PRD using Claude with the following prompt context:
   - Observation report (full text)
   - Service configuration (from intelligence.yaml)
   - Previous observations for same service (for context)
   - PRD template (from autonomous-dev pipeline format)
4. Write PRD to the pipeline's PRD directory:
   .autonomous-dev/prd/PRD-OBS-<observation-id>.md
5. Update observation report metadata:
   linked_prd: PRD-OBS-<observation-id>
6. Log the promotion event
```

#### 3.12.2 Generated PRD Template

```yaml
---
title: "Fix: <observation summary>"
version: 1.0
date: <current date>
author: "Production Intelligence Loop"
status: Draft
source: production-intelligence
observation_id: <observation-id>
severity: <observation severity>
service: <service name>
---

# <Problem title from observation>

## Problem Statement

<Generated from observation summary and evidence. Includes quantitative
metrics: error rate, latency values, affected user estimates.>

## Evidence

<Copied from observation report: metrics table, log excerpts, alert states.>

## Constraints

- Fix must address the root cause identified in observation <id>
- Target metric: <metric name> must improve by at least 10% post-deployment
- Service: <service name>, Repo: <repo>

## Success Criteria

| Metric | Current (broken) | Target (fixed) | Measurement |
|--------|-----------------|----------------|-------------|
| <target metric> | <current value> | <baseline value> | Prometheus query post-deploy |

## Scope

<Generated from recommended action in observation report.>
```

#### 3.12.3 Auto-Promotion (Phase 3)

Phase 3 introduces auto-promotion with safeguards:

```
function evaluate_auto_promote(observation, config):
  // Must be opt-in
  if not config.auto_promote.enabled:
    return false

  // Only P0/P1
  if observation.severity not in ["P0", "P1"]:
    return false

  // Confidence threshold
  if observation.confidence < 0.9:
    return false

  // Governance checks
  if observation.cooldown_active:
    return false
  if check_oscillation(observation.service, observation.error_class).oscillating:
    return false

  // Notification channel must be reachable
  if not notification_channel_reachable():
    return false

  // Auto-promote with override window
  promote_observation(observation)
  notify_pm_lead(observation, override_window=config.auto_promote.override_hours)
  schedule_override_check(observation, config.auto_promote.override_hours)
  return true
```

The PM Lead receives an immediate notification and has a 2-hour (configurable) window to override. If overridden, the PRD is cancelled and the observation returns to `pending` status.

---

## 4. Data Models

### 4.1 Observation Report Schema

```yaml
# YAML frontmatter (machine-readable)
id: string                    # OBS-YYYYMMDD-HHMMSS-<hex4>
timestamp: string             # ISO 8601
service: string               # Service name from config
repo: string                  # Repo identifier
type: enum                    # error | anomaly | trend | adoption
severity: enum                # P0 | P1 | P2 | P3
confidence: float             # 0.0 - 1.0
triage_status: enum           # pending | promoted | dismissed | deferred | investigating | cooldown
triage_decision: enum | null  # promote | dismiss | defer | investigate
triage_by: string | null      # Username
triage_at: string | null      # ISO 8601
triage_reason: string | null  # Free text
defer_until: string | null    # ISO 8601 date (for deferred observations)
cooldown_active: boolean
linked_prd: string | null     # PRD ID if promoted
linked_deployment: string | null  # Deployment ID if fix shipped
effectiveness: enum | null    # improved | unchanged | degraded | pending
effectiveness_detail:         # Present after effectiveness evaluation
  pre_fix_avg: float | null
  post_fix_avg: float | null
  improvement_pct: float | null
  measured_window: string | null
observation_run_id: string    # RUN-YYYYMMDD-HHMMSS
tokens_consumed: integer
fingerprint: string           # Hex hash
occurrence_count: integer
data_sources:                 # Per-source availability during this run
  prometheus: enum            # available | degraded | unreachable | not_configured
  grafana: enum
  opensearch: enum
  sentry: enum
related_observations: list    # IDs of related (deduped or similar) observations
oscillation_warning: boolean  # True if oscillation detected
```

### 4.2 Baseline Metrics Schema

```yaml
service: string
learning_mode: boolean
learning_started: string      # ISO 8601
learning_completed: string | null
last_updated: string          # ISO 8601
metrics:
  <metric_name>:              # e.g., error_rate, latency_p50_ms, throughput_rps
    mean_7d: float
    stddev_7d: float
    mean_14d: float
    stddev_14d: float
    mean_30d: float
    stddev_30d: float
    p50: float
    p95: float
    p99: float
```

### 4.3 Fingerprint Store Schema

```yaml
fingerprints:
  - hash: string              # SHA-256 hex
    service: string
    error_class: string
    endpoint: string
    first_seen: string        # ISO 8601
    last_seen: string         # ISO 8601
    occurrence_count: integer
    linked_observation_id: string
    triage_status: enum       # Last known triage status
```

### 4.4 Triage Audit Log Schema

```yaml
# Appended to .autonomous-dev/logs/intelligence/triage-audit.log (JSONL format)
{
  "observation_id": "OBS-20260408-143022-a7f3",
  "action": "promote",
  "actor": "pwatson",
  "timestamp": "2026-04-08T15:12:00Z",
  "reason": "Connection pool issue confirmed. Needs fix PRD.",
  "generated_prd": "PRD-OBS-20260408-143022-a7f3",
  "auto_promoted": false
}
```

### 4.5 Observation Run Metadata

```yaml
# Written to .autonomous-dev/logs/intelligence/RUN-<id>.log
run_id: string
started_at: string
completed_at: string
services_in_scope: list
data_source_status:
  prometheus: enum
  grafana: enum
  opensearch: enum
  sentry: enum
observations_generated: integer
observations_deduplicated: integer
observations_filtered: integer       # False positive filtered
triage_decisions_processed: integer
total_tokens_consumed: integer
queries_executed:
  prometheus: integer
  grafana: integer
  opensearch: integer
  sentry: integer
errors: list                         # Any errors during the run
```

---

## 5. MCP Query Examples

### 5.1 PromQL Queries

#### Current Error Rate (instant query)

```promql
# 5xx error rate as percentage, 5-minute window
sum(rate(http_requests_total{job="api-gateway", status=~"5.."}[5m]))
/
sum(rate(http_requests_total{job="api-gateway"}[5m]))
* 100
```

MCP call:

```
prometheus_query(
  query: 'sum(rate(http_requests_total{job="api-gateway",status=~"5.."}[5m])) / sum(rate(http_requests_total{job="api-gateway"}[5m])) * 100'
)
```

#### Sustained Error Rate Check (range query)

```promql
# Error rate at 1-minute resolution over last 30 minutes
sum(rate(http_requests_total{job="api-gateway", status=~"5.."}[1m]))
/
sum(rate(http_requests_total{job="api-gateway"}[1m]))
* 100
```

MCP call:

```
prometheus_query_range(
  query: 'sum(rate(http_requests_total{job="api-gateway",status=~"5.."}[1m])) / sum(rate(http_requests_total{job="api-gateway"}[1m])) * 100',
  start: '2026-04-08T14:00:00Z',
  end: '2026-04-08T14:30:00Z',
  step: '60s'
)
```

#### Latency Percentiles

```promql
# p99 latency in milliseconds
histogram_quantile(0.99,
  sum(rate(http_request_duration_seconds_bucket{job="api-gateway"}[5m])) by (le)
) * 1000
```

#### Error Rate by Endpoint (top offenders)

```promql
# Top endpoints by 5xx rate
topk(5,
  sum by (handler) (rate(http_requests_total{job="api-gateway", status=~"5.."}[5m]))
  /
  sum by (handler) (rate(http_requests_total{job="api-gateway"}[5m]))
  * 100
)
```

#### Service Availability

```promql
# Availability as uptime percentage over last 4 hours
avg_over_time(up{job="api-gateway"}[4h]) * 100
```

#### Process Crash Detection

```promql
# Number of restarts in last hour
changes(up{job="api-gateway"}[1h])
```

```promql
# Currently down
up{job="api-gateway"} == 0
```

#### Throughput

```promql
# Requests per second, 5-minute rate
sum(rate(http_requests_total{job="api-gateway"}[5m]))
```

#### Trend: 7-Day Hourly Error Rate (for linear regression)

```promql
# Hourly average error rate over 7 days
avg_over_time(
  (
    sum(rate(http_requests_total{job="api-gateway", status=~"5.."}[5m]))
    /
    sum(rate(http_requests_total{job="api-gateway"}[5m]))
    * 100
  )[7d:1h]
)
```

#### Baseline Statistics

```promql
# 7-day average error rate
avg_over_time(
  (sum(rate(http_requests_total{job="api-gateway",status=~"5.."}[5m])) / sum(rate(http_requests_total{job="api-gateway"}[5m])) * 100)[7d:]
)

# 7-day standard deviation of error rate
stddev_over_time(
  (sum(rate(http_requests_total{job="api-gateway",status=~"5.."}[5m])) / sum(rate(http_requests_total{job="api-gateway"}[5m])) * 100)[7d:]
)
```

### 5.2 Grafana API Calls

```
# List firing alerts for a dashboard
grafana_list_alerts(dashboard_uid="abc123", state="alerting")

# Get deploy annotations from last 4 hours
grafana_get_annotations(
  dashboard_uid="abc123",
  from="2026-04-08T10:30:00Z",
  to="2026-04-08T14:30:00Z",
  tags=["deploy", "release"]
)
```

### 5.3 OpenSearch Queries

```json
// Error count by exception class (last 4 hours)
{
  "query": {
    "bool": {
      "must": [
        { "match": { "level": "ERROR" } },
        { "range": { "@timestamp": { "gte": "now-4h" } } }
      ],
      "filter": [
        { "term": { "service.name": "api-gateway" } }
      ]
    }
  },
  "aggs": {
    "by_exception": {
      "terms": {
        "field": "exception.class.keyword",
        "size": 20,
        "order": { "_count": "desc" }
      }
    }
  },
  "size": 0
}
```

```json
// Recent error samples with stack traces (scrubbed before use)
{
  "query": {
    "bool": {
      "must": [
        { "match": { "level": "ERROR" } },
        { "range": { "@timestamp": { "gte": "now-4h" } } }
      ],
      "filter": [
        { "term": { "service.name": "api-gateway" } }
      ]
    }
  },
  "collapse": { "field": "exception.class.keyword" },
  "sort": [{ "@timestamp": "desc" }],
  "size": 10,
  "_source": [
    "@timestamp", "message", "level", "exception.class",
    "exception.message", "stack_trace", "trace_id",
    "request.method", "request.path", "response.status"
  ]
}
```

---

## 6. Error Handling

### 6.1 MCP Server Failures

| Failure Mode | Behavior |
|-------------|----------|
| MCP server unreachable at run start | Log warning, exclude from run, note in report `data_sources` field |
| MCP server times out mid-query | Retry once after 10s. If second attempt fails, log error, proceed with data collected so far |
| MCP server returns error response | Log the error code, skip that query, continue with remaining queries |
| All MCP servers unreachable | Abort the observation run, log critical error, retry on next scheduled run |

### 6.2 Scrubbing Pipeline Failures

| Failure Mode | Behavior |
|-------------|----------|
| Regex engine error (malformed custom pattern) | Skip the failing pattern, log error, continue with remaining patterns. Flag in audit log as `scrub_incomplete` |
| Scrubbing takes >30s for a batch | Timeout and truncate the batch. Do not pass unscrubbed data forward. Log the truncation |
| Post-scrub validation finds residual PII/secret | Re-scrub with stricter patterns. If still detected, replace the entire field with `[SCRUB_FAILED:field_name]` and log a security warning |

### 6.3 Intelligence Engine Failures

| Failure Mode | Behavior |
|-------------|----------|
| Claude session fails or times out | Retry once. If second attempt fails, generate a minimal observation with available data (metrics only, no LLM analysis) |
| Token budget exceeded mid-run | Complete the current service, skip remaining services, note in run metadata |
| LLM generates invalid observation structure | Validate YAML frontmatter against schema. Reject invalid observations and log the validation error |

### 6.4 File System Failures

| Failure Mode | Behavior |
|-------------|----------|
| Cannot write observation file | Retry with temporary filename. If persistent, log to stderr and the run audit log |
| Lock file conflict (concurrent run) | Wait up to 5 minutes with exponential backoff. If lock persists, skip that service |
| Observation directory does not exist | Create the directory structure automatically |

---

## 7. Security

### 7.1 Production Data Handling

**Principle: Defense in depth.** Multiple layers prevent production data leakage.

| Layer | Control |
|-------|---------|
| Network | MCP servers access monitoring APIs; the observation runner never has direct production database or service access |
| MCP permissions | All MCP connections are read-only (NFR-006). MCP servers should be configured with read-only API tokens |
| Scrubbing | All text data from production passes through PII/secret scrubbing before LLM processing or persistence (FR-039) |
| Post-scrub validation | A second pass catches anything the first pass missed |
| Audit logging | Every scrub operation is logged with redaction counts |
| Weekly audit scan | Automated scan of all observation reports for unscrubbed PII/secrets (Success Metric: leak rate = 0) |

### 7.2 Least Privilege

| Component | Required Permissions |
|-----------|---------------------|
| Prometheus MCP | `query` (read metrics). No `admin`, no `write` |
| Grafana MCP | `Viewer` role. Read dashboards, alerts, annotations. No edit/delete |
| OpenSearch MCP | Read-only access to log indices. No write, no index management |
| Sentry MCP | `member` or `viewer` project access. Read issues and events only |
| File system | Write only to `.autonomous-dev/` directory tree. Read access to repo for config |
| Claude session | Standard Claude Code session permissions. No elevated OS access |

### 7.3 Secret Management

MCP server credentials (tokens, URLs) are stored as environment variables, never in configuration files:

```
GRAFANA_MCP_URL, GRAFANA_MCP_TOKEN
PROMETHEUS_MCP_URL, PROMETHEUS_MCP_TOKEN
OPENSEARCH_MCP_URL, OPENSEARCH_MCP_TOKEN
SENTRY_MCP_URL, SENTRY_MCP_TOKEN
```

The `intelligence.yaml` configuration file must not contain credentials. The `.mcp.json` file references environment variables using `${VAR}` syntax.

### 7.4 Observation Report Access Control

- Observation reports are stored in the repository and inherit repository-level access controls
- Reports containing production data should not be included in public-facing outputs
- The `.autonomous-dev/observations/` directory should be added to `.gitignore` if the repository is public, or access-controlled if private
- Archived observations inherit the same access controls

---

## 8. Testing Strategy

### 8.1 Unit Tests

| Component | Test Focus | Example |
|-----------|-----------|---------|
| PII Scrubber | Pattern matching accuracy | `scrub("user john@example.com logged in")` returns `"user [REDACTED:email] logged in"` |
| Secret Detector | Pattern matching accuracy | `scrub("key=AKIAIOSFODNN7EXAMPLE")` returns `"key=[SECRET_REDACTED]"` |
| Severity Scorer | Scoring algorithm correctness | Given error_rate=15%, 2000 affected users, critical service, 45 min duration => P1 |
| Fingerprint Generator | Deterministic hashing | Same error with different timestamps produces same fingerprint |
| Stack Trace Normalizer | Line number/address removal | `at com.example.Foo.bar(Foo.java:42)` normalizes to `at com.example.Foo.bar(Foo.java:*)` |
| Cooldown Checker | Time window logic | Deploy 3 days ago with 7-day cooldown => cooldown_active=true |
| Oscillation Detector | Counting logic | 3 observations in 25 days => oscillating=true |
| Effectiveness Calculator | Before/after comparison | Pre=12.3%, Post=0.6% => improved, 95.1% improvement |
| Baseline Updater | EWMA calculation | Verify exponentially weighted moving average converges correctly |
| Anomaly Detector (z-score) | Statistical correctness | z=3.2 with sensitivity=2.5 => anomaly flagged |

### 8.2 Integration Tests

| Test Scenario | Setup | Assertion |
|--------------|-------|-----------|
| Full observation run with mock MCP servers | Mock Prometheus, Grafana, OpenSearch MCP responses | Observation report generated with correct structure, all fields populated |
| Scrub-before-process enforcement | Mock OpenSearch returns PII-laden logs | LLM prompt and observation report contain only scrubbed text |
| Deduplication across runs | Two runs with same error fingerprint | Second run updates existing observation instead of creating new one |
| Cooldown enforcement | Observation for service with recent fix deployment | Observation generated but flagged `cooldown_active: true` |
| Graceful degradation | Prometheus MCP unreachable | Run completes with OpenSearch data only, report notes `prometheus: unreachable` |
| Triage processing | Edit observation YAML to set `triage_decision: promote` | PRD generated on next run, observation updated with `linked_prd` |
| Token budget enforcement | Configure low token budget | Run terminates cleanly after budget exhaustion |

### 8.3 PII/Secret Scrubbing Tests

A dedicated test suite with a corpus of production-like log data containing known PII/secret instances:

```
Test corpus: 10,000 log lines with:
  - 500 embedded email addresses
  - 200 phone numbers (US and international)
  - 50 SSN patterns
  - 100 credit card numbers
  - 150 IP addresses
  - 50 AWS access keys
  - 30 GitHub tokens
  - 20 Stripe keys
  - 100 Bearer tokens
  - 50 JWT tokens
  - 200 generic high-entropy strings in key=value context

Expected: >99% recall (NFR-009), 0 false negatives on known patterns.
          <5% false positive rate (legitimate strings misidentified as PII).
Performance: <2s for the full 10K-line corpus (NFR-002).
```

### 8.4 End-to-End Tests

| Test | Description |
|------|-------------|
| Full loop | Inject error into mock production -> observation run detects it -> PM Lead promotes -> PRD generated -> mock deployment -> effectiveness tracker confirms improvement |
| Oscillation loop | Inject recurring error -> 3 observations generated -> oscillation warning appears on third observation |
| Learning mode | Add new service -> verify no anomaly observations for 7 days -> verify baseline populated -> verify anomaly detection activates after learning |
| Auto-promote (Phase 3) | High-confidence P0 observation -> auto-promoted -> PM Lead overrides within window -> PRD cancelled |

### 8.5 Security Tests

| Test | Description |
|------|-------------|
| PII leak audit | After a full observation run, scan all generated files for known PII patterns. Zero matches expected |
| Secret leak audit | After a full observation run, scan all generated files for known secret patterns. Zero matches expected |
| MCP write attempt | Verify that no MCP tool calls in the codebase use write/mutate operations |
| Credential scan | Verify `intelligence.yaml` and observation reports contain no hardcoded credentials |

---

## 9. Trade-offs & Alternatives

### 9.1 Regex-Based Scrubbing vs. NER/ML-Based Scrubbing

**Chosen: Regex-based.**

| Factor | Regex | NER/ML |
|--------|-------|--------|
| Latency | <2s per 10K lines | 10-30s per 10K lines (model inference) |
| Determinism | Fully deterministic, auditable | Probabilistic, may vary across runs |
| Recall on known patterns | >99% | ~95-98% (model-dependent) |
| Unknown PII types | Misses novel patterns | Better at detecting unseen patterns |
| Maintenance | Requires manual pattern updates | Requires model retraining |
| Dependencies | Zero external dependencies | Requires ML runtime (torch, spaCy, etc.) |

**Rationale:** NFR-002 requires <2s latency per 10K lines, which rules out most ML approaches. NFR-009 requires >99% recall on known patterns, which regex achieves more reliably than probabilistic models. The generic high-entropy detector (section 3.4.3) provides a catch-all for secret patterns not covered by specific regex.

**Mitigation for unknown PII:** The weekly audit scan (section 7.1) uses a broader, slower scan (including entropy analysis) to catch anything the real-time regex missed. If new PII patterns are found, they are added to the pattern list.

### 9.2 Scheduled Runs vs. Event-Driven (Webhook)

**Chosen: Scheduled runs (cron/interval).**

| Factor | Scheduled | Event-Driven |
|--------|-----------|-------------|
| Simplicity | Simple cron trigger | Requires webhook infrastructure |
| Cost predictability | Predictable token spend per day | Spikes during incidents |
| Latency | Up to 4 hours between issue and detection | Near-real-time |
| Noise | Batched analysis reduces noise | Risk of observation per alert |
| Infrastructure | No additional infra | Needs webhook receiver, queue |

**Rationale:** The PRD explicitly specifies a scheduled cadence (FR-006) and states this is not a real-time incident response tool (Non-Goal). Scheduled runs provide cost predictability and batch analysis that reduces noise.

**Future consideration:** Phase 3+ could add an optional event-driven mode triggered by P0 alerts from Grafana, running an immediate observation for the affected service only.

### 9.3 File-Based Triage vs. Web UI

**Chosen: File-based (primary).**

| Factor | File-Based | Web UI |
|--------|-----------|--------|
| Development cost | Zero frontend development | Significant frontend effort |
| Version control | Natively version-controlled | Requires API + database |
| IDE integration | Native (VS Code, vim, etc.) | Separate browser tab |
| Auditability | Git history provides full audit trail | Requires separate audit log implementation |
| Mobile / remote access | Requires repo access | Accessible anywhere |
| Batch triage | Edit multiple files | UI workflow needed |

**Rationale:** The PRD specifies file-based as the primary interface (Architectural Decision 4). The target user (PM Lead) already works in the repository. Notification-based triage (Slack/Discord) covers the mobile/remote access gap.

### 9.4 Central Observations Repo vs. Per-Service Repo

**Chosen: Per-service repo (store observations in each service's repo).**

This aligns with the PRD's configuration schema (FR-023) and keeps observations close to the code they reference. Cross-service views are provided by the weekly digest, which aggregates across repos.

**Trade-off:** Cross-service correlation (cascade detection) is harder when observations are distributed. Phase 2 addresses this by writing cross-service observations to a configurable central location.

### 9.5 LLM for Classification vs. Purely Rule-Based

**Chosen: Hybrid -- deterministic scoring + LLM classification.**

Threshold checks, deduplication fingerprinting, and severity scoring are deterministic. The LLM provides root-cause hypothesis generation, recommended action determination, and nuanced severity adjustment. This gives predictability for scoring while leveraging the LLM for analysis that benefits from natural language understanding.

---

## 10. Implementation Plan

### Phase 1: Observation Only (Weeks 1-6)

| Week | Milestone | Components |
|------|-----------|-----------|
| 1-2 | MCP integration + scrubbing pipeline | MCP server config for Grafana, Prometheus, OpenSearch. PII scrubber + secret detector with full test suite. Connectivity validation |
| 3-4 | Error detection + classification + dedup | Threshold-based error detection. Severity scoring algorithm. Fingerprint-based deduplication. False positive filtering |
| 4-5 | Report generation + file storage | Observation report generator (YAML + Markdown). Directory structure creation. File naming scheme. Schema validation |
| 5-6 | Triage interface + cooldown + scheduled runner | File-based triage processor. Cooldown enforcement. Cron-based schedule runner. End-to-end integration testing. Baseline bootstrapping (learning mode) |

**Phase 1 Exit Criteria:**
- 3+ observation runs complete successfully with zero PII/secret leaks
- PM Lead successfully triages 10+ observations via file-based interface
- Signal-to-noise ratio > 40%
- At least 1 observation promoted to PRD and processed by pipeline

### Phase 2: Automated Triage Suggestions (Weeks 7-14)

| Week | Milestone | Components |
|------|-----------|-----------|
| 7-8 | Anomaly detection + trend analysis | Z-score anomaly detection. Linear regression trend analysis. Baseline update algorithm refinement |
| 9-10 | Confidence scoring + triage suggestions | Confidence score computation (evidence + dedup + history). AI-generated triage suggestions. Feature adoption tracking |
| 11-12 | Governance: oscillation + effectiveness | Oscillation detection. Effectiveness tracker. Lifecycle linking (observation -> PRD -> deploy -> metric) |
| 13-14 | Weekly digest + health endpoints + retention | Weekly digest generator. Health endpoint integration. Retention policy (archive + delete). Per-service severity overrides. Audit trail for triage |

**Phase 2 Exit Criteria:**
- Triage suggestion accuracy > 70%
- Signal-to-noise ratio > 60%
- Fix effectiveness tracking operational for 3+ resolved observations
- Weekly digest operational and reviewed by PM Lead

### Phase 3: Auto-Promote with Human Override (Weeks 15-22)

| Week | Milestone | Components |
|------|-----------|-----------|
| 15-16 | Notification channel integration | Slack/Discord webhook posting. Reply-based triage commands. Notification channel health check |
| 17-18 | Auto-promote engine | Auto-promotion logic (confidence > 0.9, P0/P1 only). Override window mechanism. Safeguard enforcement |
| 19-20 | Sentry integration + PagerDuty cross-reference | Sentry MCP integration. Enriched error reports (stack traces, user counts). PagerDuty/OpsGenie read-only cross-reference |
| 21-22 | Hardening + end-to-end validation | End-to-end loop testing. Auto-promote override testing. Performance tuning. Documentation |

**Phase 3 Exit Criteria:**
- Auto-promoted observations have > 90% approval rate
- Zero auto-promoted PRDs that caused negative production impact
- End-to-end loop demonstrated: observation -> auto-promote -> PRD -> implementation -> deployment -> metric improvement verified

---

## 11. Open Questions

| # | Question | Context | Impact | Status |
|---|----------|---------|--------|--------|
| OQ-1 | How should cascade failures be attributed when the root-cause service is out of scope? | A database failure manifests as API errors. If the DB is not in observation scope, the system misattributes the root cause. | May generate misleading observations and ineffective fix PRDs. Phase 2 cross-service correlation helps but does not fully solve if the root service is not instrumented. | Open |
| OQ-2 | What is the monthly token budget for observation runs? | At 4h intervals, 10 services, 50K tokens/run = 3M tokens/day = ~90M tokens/month. Need to validate against actual costs. | Directly impacts schedule frequency and observation depth. May need to reduce frequency or scope if budget is constrained. | Open |
| OQ-3 | Should baseline bootstrapping ingest historical Prometheus data? | FR-021 specifies 7-day learning mode, but services may have months of historical data. Ingesting it accelerates baseline creation. | Faster time-to-value vs. additional complexity and cost in the bootstrapping process. | Open -- recommend ingesting 30d of history if available, falling back to 7-day learning if not |
| OQ-4 | Central observations repo vs. per-service repo? | Per-service keeps observations near code but fragments the digest. Central simplifies cross-service views but separates observations from code. | Affects file storage, cross-service correlation, and access control. | Open -- recommend per-service (default) with optional central mirror for digest |
| OQ-5 | Should PagerDuty cross-reference be elevated from P2 to P1? | Duplicate alerting (Risk R10) directly impacts user trust. If engineers see observations as redundant, adoption fails. | Without cross-referencing, every PagerDuty alert during an incident will also generate an observation, creating noise. | Open -- recommend P1 |
| OQ-6 | Should observation schedule be adaptive? | 4h may be too frequent for stable services, too infrequent for critical ones. An adaptive schedule (more frequent after recent issues, less frequent during stability) could optimize both. | Affects cost, noise level, and detection latency. Adds schedule management complexity. | Open -- defer to Phase 2; start with fixed 4h default |
| OQ-7 | Should the PII scrubbing pipeline use a dedicated library (e.g., presidio) instead of custom regex? | Custom regex is fast and deterministic but may miss novel PII formats. A library like Microsoft Presidio provides broader coverage but adds a dependency and latency. | Impacts NFR-002 (latency) and NFR-009 (recall). A library may provide better recall for edge cases but may not meet the <2s latency requirement. | Open -- recommend starting with regex, evaluating presidio for the weekly audit scan |
| OQ-8 | How should effectiveness tracking account for external factors? | A metric may improve due to traffic changes, infrastructure upgrades, or unrelated code changes, not the observation-generated fix. | Overstating effectiveness undermines trust. May need control metrics or confidence intervals for the effectiveness score. | Open -- recommend adding a `confounders_detected` flag when traffic volume or infrastructure changes significantly in the measurement window |
| OQ-9 | What happens when the PM Lead is unavailable for triage? | If no triage occurs for multiple cycles, observations accumulate and the system's detection-to-action latency degrades. | Value of the system diminishes if observations stall. Need escalation path or delegate mechanism. | Open -- recommend escalation: notify backup triager after 24h for P0/P1, 72h for P2/P3 |
| OQ-10 | How to handle canary deployments and A/B tests with expected error rates? | Canary deploys intentionally route traffic to unstable code. A/B tests may have different error profiles. | Without awareness of deployment strategies, the system generates false positives for intentional experiments. | Open -- recommend adding `canary_aware` config flag per service that filters traffic tagged with canary/experiment labels |

---

## Appendix A: Weekly Digest Report Format

```yaml
---
type: digest
week: "2026-W15"
period: "2026-04-06 to 2026-04-12"
generated_at: "2026-04-12T23:59:00Z"
---

# Production Intelligence Weekly Digest -- 2026-W15

## Summary

| Metric | Value |
|--------|-------|
| Total observations generated | 14 |
| Observations by severity | P0: 1, P1: 3, P2: 7, P3: 3 |
| Observations by type | error: 8, anomaly: 4, trend: 2 |
| Triage decisions | promote: 4, dismiss: 5, defer: 2, investigate: 1, pending: 2 |
| Signal-to-noise ratio | (4+1) / 14 = 35.7% |
| Average triage latency | P0/P1: 2.1 hours, P2/P3: 18.4 hours |
| Average tokens per run | 38,200 |

## Observations by Service

| Service | Observations | P0/P1 | Promoted | Dismissed |
|---------|-------------|-------|----------|-----------|
| api-gateway | 6 | 2 | 2 | 2 |
| order-service | 5 | 1 | 1 | 2 |
| user-service | 3 | 1 | 1 | 1 |

## Effectiveness Tracking

| Observation | PRD | Deployed | Pre-Fix | Post-Fix | Result |
|-------------|-----|----------|---------|----------|--------|
| OBS-20260401-... | PRD-OBS-0401 | 2026-04-03 | 8.2% err | 0.5% err | improved (93.9%) |
| OBS-20260328-... | PRD-OBS-0328 | 2026-04-01 | 1200ms p99 | 980ms p99 | improved (18.3%) |

## Recurring Patterns

| Pattern | Service | Occurrences (30d) | Status |
|---------|---------|-------------------|--------|
| ConnectionPoolExhausted | api-gateway | 4 | OSCILLATING |
| TimeoutError on /search | order-service | 2 | Monitoring |

## Recommendations

- **api-gateway ConnectionPoolExhausted**: Oscillation detected (4 in 30d).
  Recommend architectural review of connection pooling strategy.
- **Signal-to-noise ratio below target (35.7% vs 60%)**: Consider tightening
  P2/P3 thresholds or adding more exclusion patterns.
```

---

## Appendix B: Configuration Reference

The full configuration schema is documented in PRD-005 section 9. Key implementation notes:

- **Cron parsing**: Use `cron-parser` (npm) or equivalent to parse cron expressions. Simple intervals (`4h`, `30m`) are converted to cron: `4h` -> `0 */4 * * *`, `30m` -> `*/30 * * * *`.
- **Per-service overrides**: Deep-merged with defaults. Only specified fields override; unspecified fields inherit from `default_thresholds`.
- **Custom PII/secret patterns**: Appended to the built-in list, not replacing it. This ensures the baseline patterns are always active even if custom config is malformed.
- **Retention**: Implemented as a cleanup step at the end of each observation run. Files older than `observation_days` are moved to `archive/`. Files in `archive/` older than `archive_days` are deleted.

---

## Appendix C: Observation Type Decision Tree

```
Observation run starts
  |
  v
Query metrics + logs + alerts
  |
  v
Is error rate above threshold for sustained duration?
  |-- YES --> Error observation (section 3.5)
  |-- NO
  v
Is current value a statistical anomaly vs baseline? (Phase 2+)
  |-- YES --> Anomaly observation (section 3.7.2)
  |-- NO
  v
Is there a degradation trend over 7/14/30 day windows? (Phase 2+)
  |-- YES --> Trend observation (section 3.7.3)
  |-- NO
  v
Are there newly deployed features with notable adoption patterns? (Phase 2+)
  |-- YES --> Adoption observation (section 3.7.4)
  |-- NO
  v
No observation generated for this service this run.
```
