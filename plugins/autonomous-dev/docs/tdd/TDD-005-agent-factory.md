# TDD-005: Agent Factory & Self-Improvement

| Field          | Value                                                        |
|----------------|--------------------------------------------------------------|
| **Title**      | Agent Factory & Self-Improvement -- Technical Design         |
| **TDD ID**     | TDD-005                                                      |
| **Version**    | 0.1.0                                                        |
| **Date**       | 2026-04-08                                                   |
| **Author**     | Staff Engineering                                            |
| **Status**     | Draft                                                        |
| **Plugin**     | autonomous-dev                                               |
| **Parent PRD** | PRD-003: Agent Factory & Self-Improvement                    |
| **Depends On** | TDD-001 (System Core), TDD-002 (Document Pipeline)          |

---

## 1. Overview

This document is the technical design for the Agent Factory subsystem defined in PRD-003. The Agent Factory manages the complete lifecycle of AI agents within the autonomous-dev plugin: registration, invocation, metrics collection, improvement proposals, validation, versioning, dynamic creation, and security enforcement.

The design is driven by three principles drawn from the PRD's risk analysis:

1. **Conservative by default.** The system observes before it acts, proposes before it modifies, and requires human approval before it promotes. Autonomous behavior is opt-in and gated.
2. **Git as the source of truth.** Every agent definition lives in a committed git state. No agent loads from uncommitted files. All changes are auditable through git history.
3. **Separation of concerns in the modification lifecycle.** The agent that identifies a weakness is not the agent that proposes a fix, which is not the agent that reviews the fix, which is not the code that promotes the fix. No single component has end-to-end control.

This is the riskiest subsystem in the autonomous-dev architecture. The design reflects that risk: security controls are not bolted on after the architecture is defined -- they are structural constraints that shape every component.

### 1.1 Scope

This TDD covers:

- Agent definition format and schema validation
- Agent registry (loading, discovery, version tracking)
- Per-invocation and aggregate performance metrics
- Metrics storage (JSONL for streaming, SQLite for queries)
- Agent improvement lifecycle (observation through promotion)
- A/B testing framework for agent validation
- Dynamic agent creation pipeline
- Agent versioning (semver, git-backed, rollback)
- Integrity and security enforcement
- Meta-reviewer agent design
- Foundation agent catalog (first 6 core agents fully specified)

### 1.2 Out of Scope

- Orchestrator scheduling of agents (covered by TDD for PRD-004)
- Pipeline stage definitions (covered by TDD for PRD-002)
- Daemon process supervisor (covered by TDD for PRD-001)
- Cross-installation agent sharing or federation

---

## 2. Architecture

### 2.1 Component Overview

```
+-------------------------------------------------------------------+
|                        Agent Factory                               |
|                                                                    |
|  +------------------+    +-------------------+    +--------------+ |
|  |  Agent Registry  |    |  Metrics Engine   |    |  Integrity   | |
|  |  - loader        |    |  - collector      |    |  Enforcer    | |
|  |  - validator     |    |  - aggregator     |    |  - hash check| |
|  |  - catalog       |    |  - anomaly detect |    |  - git check | |
|  |  - version mgr   |    |  - storage (JSONL)|    |  - tool guard| |
|  +--------+---------+    |  - query (SQLite) |    +------+-------+ |
|           |              +--------+----------+           |         |
|           |                       |                      |         |
|  +--------v-----------------------v----------------------v-------+ |
|  |                    Agent Runtime                               | |
|  |  - tool access enforcement                                    | |
|  |  - invocation wrapper (pre/post hooks)                        | |
|  |  - metrics emission                                           | |
|  +---------------------------------------------------------------+ |
|                                                                    |
|  +-------------------+    +-------------------+    +--------------+|
|  | Improvement       |    | A/B Validation    |    | Dynamic      ||
|  | Lifecycle         |    | Engine            |    | Creation     ||
|  | - observer        |    | - input selector  |    | - gap detect ||
|  | - analyst         |    | - blind runner    |    | - researcher ||
|  | - proposer        |    | - blind scorer    |    | - generator  ||
|  | - canary mgr      |    | - comparator      |    | - validator  ||
|  | - promoter        |    +-------------------+    +--------------+|
|  +-------------------+                                             |
|                                                                    |
|  +---------------------------------------------------------------+ |
|  |                    Security Layer                              | |
|  |  - meta-reviewer agent gate                                   | |
|  |  - privilege boundary enforcement                             | |
|  |  - audit log (append-only)                                    | |
|  |  - rate limiter                                               | |
|  +---------------------------------------------------------------+ |
+-------------------------------------------------------------------+
```

### 2.2 Agent Lifecycle State Machine

This is the authoritative state machine. All agent state transitions are governed by this diagram. Transitions not shown here are illegal.

```
                          LOAD FROM GIT
                               |
                               v
                    +----------+-----------+
                    |      REGISTERED      |
                    | (schema validated,   |
                    |  hash verified,      |
                    |  tools checked)      |
                    +----------+-----------+
                               |
                     startup / on-demand
                               |
                               v
                    +----------+-----------+
            +------>|       ACTIVE         |<-----------+
            |       | (serving invocations)|            |
            |       +----------+-----------+            |
            |                  |                        |
            |       +----------+----------+             |
            |       |                     |             |
            |       v                     v             |
            |  +----+--------+    +-------+------+      |
            |  | UNDER_REVIEW|    |    FROZEN    |      |
            |  | (proposal   |    | (operator    |      |
            |  |  generated) |    |  locked, no  |      |
            |  +----+--------+    |  auto-modify)|      |
            |       |             +--------------+      |
            |       v                                   |
            |  +----+--------+                          |
            |  | VALIDATING  |                          |
            |  | (A/B test   |                          |
            |  |  in flight) |                          |
            |  +----+--------+                          |
            |       |                                   |
            |       v                                   |
            |  +----+--------+                          |
            |  |   CANARY    |                          |
            |  | (dual-run   |                          |
            |  |  period)    |                          |
            |  +----+--------+                          |
            |       |                                   |
            |  +----+------+                            |
            |  |           |                            |
            |  v           v                            |
            | PROMOTED   REJECTED ----------------------+
            | (commit     (keep current,
            |  new ver)    log reason)
            |     |
            +-----+
         (new version
          becomes ACTIVE)
```

**State transition rules:**

| From | To | Trigger | Guard |
|------|----|---------|-------|
| -- | REGISTERED | Agent file found in `agents/` on scan | Schema valid, hash matches committed state, tools in allowlist |
| REGISTERED | ACTIVE | Startup complete or first invocation request | No guards beyond registration validation |
| ACTIVE | UNDER_REVIEW | `performance-analyst` generates improvement proposal | Observation threshold met (10+ invocations), not FROZEN |
| ACTIVE | FROZEN | Operator runs `agent freeze <name>` | None |
| FROZEN | ACTIVE | Operator runs `agent unfreeze <name>` | None |
| UNDER_REVIEW | VALIDATING | Meta-reviewer approves proposal, A/B test initiated | Meta-reviewer passed, rate limit not exceeded |
| VALIDATING | CANARY | A/B results favor proposed version | Phase 3 enabled; otherwise skip to PROMOTED with human approval |
| VALIDATING | PROMOTED | A/B results favor proposed AND human approves (Phase 1-2) | Human approval via `agent promote` |
| VALIDATING | REJECTED | A/B results do not favor proposed OR human rejects | None |
| CANARY | PROMOTED | Canary period completes with positive results + human/auto approval | Phase 3: auto for patch, human for minor/major |
| CANARY | REJECTED | Canary shows regression or human rejects | Auto-rollback if quality decline detected |
| PROMOTED | ACTIVE | Git commit succeeds, registry reloads | Commit must succeed |
| REJECTED | ACTIVE | Automatic transition, current version continues | Rejection reason logged |

---

## 3. Detailed Design

### 3.1 Agent Definition Schema

Agent definitions are `.md` files stored in the `agents/` directory at the plugin root. Each file uses YAML frontmatter for machine-readable configuration and a Markdown body for the agent's system prompt.

#### 3.1.1 Frontmatter Schema

```yaml
# REQUIRED fields
name: string           # Unique identifier, kebab-case, e.g., "prd-author"
version: string        # Semver, e.g., "1.2.0"
role: enum             # One of: author, executor, reviewer, meta
description: string    # Human-readable summary of what the agent does

# REQUIRED -- capability declarations
expertise: string[]    # List of domain tags, e.g., ["product-requirements", "user-stories"]
tools: string[]        # Allowed tools, e.g., ["Read", "Glob", "Grep"]
model: string          # Model identifier, e.g., "claude-sonnet", "claude-opus"
turn_limit: integer    # Maximum conversation turns per invocation

# REQUIRED -- quality evaluation
evaluation_rubric:     # Map of dimension -> criterion description
  <dimension>: string  # e.g., completeness: "All required sections present..."

# REQUIRED -- version tracking
version_history:       # Array of version records (most recent first)
  - version: string
    date: string       # ISO 8601 date
    author: string     # "system", "meta-reviewer", or human identifier
    change: string     # One-line description of what changed

# OPTIONAL fields
frozen: boolean        # Default false. If true, no automated modifications allowed.
risk_tier: enum        # One of: low, medium, high, critical. Default derived from role.
domain_affinity: string[]  # Domains where this agent is known to perform well
deprecated_by: string  # If set, name of the agent that replaces this one
max_tokens: integer    # Per-invocation output token budget. Default: 16384.
temperature: float     # LLM temperature. Default: 0.0 for deterministic output.
```

#### 3.1.2 Frontmatter Validation Rules

The registry validates every agent file against these rules at load time:

1. `name` must be unique across all loaded agents.
2. `name` must match the filename (e.g., `prd-author.md` must have `name: prd-author`).
3. `version` must be valid semver (MAJOR.MINOR.PATCH).
4. `role` must be one of the four allowed archetypes.
5. `tools` must be a subset of the allowed tools for the agent's `role` (see Section 3.1.3).
6. `evaluation_rubric` must have at least 2 dimensions.
7. `version_history` must have at least one entry and the first entry's `version` must match the top-level `version` field.
8. `turn_limit` must be a positive integer, maximum 100.
9. `model` must reference a model in the system's model registry.
10. `temperature` must be in range [0.0, 1.0].

Validation failures are fatal for the individual agent (it is not loaded) but non-fatal for the system (other agents continue to load). All validation errors are logged to the audit log.

#### 3.1.3 Tool Access Policy by Role

This table is the authoritative allowlist. The registry enforces it at load time. The runtime enforces it at invocation time.

| Role | Allowed Tools | Rationale |
|------|--------------|-----------|
| `author` | `Read`, `Glob`, `Grep`, `WebSearch` | Research-oriented. Cannot modify files. |
| `executor` | `Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash` | Full development access within working directory. |
| `reviewer` | `Read`, `Glob`, `Grep` | Read-only analysis. Cannot modify anything. |
| `meta` | `Read`, `Glob`, `Grep` | Read-only analysis. Explicitly cannot modify agent files. |

**Hard prohibitions (all roles):**
- No agent has access to `git push`.
- No agent has access to credential stores or secrets management tools.
- No agent has network access beyond `WebSearch`.
- No agent has access to modify files in the `agents/` directory (enforced at the Bash/Edit/Write tool level by path filtering).

#### 3.1.4 Complete Agent Definition Example

Below is the full, canonical example of an agent `.md` file.

```markdown
---
name: prd-author
version: 1.0.0
role: author
description: >
  Writes Product Requirements Documents from product direction input.
  Focuses on user stories, functional requirements, and success metrics.
  Structures output using the standard PRD template with all mandatory sections.
expertise:
  - product-requirements
  - user-story-writing
  - stakeholder-analysis
  - market-analysis
  - success-metrics
model: claude-sonnet
turn_limit: 25
max_tokens: 16384
temperature: 0.0
tools:
  - Read
  - Glob
  - Grep
  - WebSearch
evaluation_rubric:
  completeness: "All required PRD sections present and substantive (problem, goals, non-goals, user stories, requirements, NFRs, success metrics, risks, phasing)"
  clarity: "Requirements are unambiguous and independently testable; no requirement requires interpretation"
  user_focus: "User stories are specific, measurable, and prioritized (P0/P1/P2); cover all identified personas"
  feasibility: "Technical constraints acknowledged without over-specifying solutions; risks rated and mitigated"
  traceability: "Every requirement has a unique ID; success metrics are linked to specific goals"
risk_tier: medium
domain_affinity:
  - web-applications
  - api-design
  - developer-tooling
frozen: false
version_history:
  - version: 1.0.0
    date: 2026-04-08
    author: system
    change: "Initial release -- foundation agent for PRD authoring"
---

# PRD Author Agent

You are a senior product manager writing a Product Requirements Document (PRD).

## Your Role

You produce comprehensive, structured PRDs from product direction input. Your output
is consumed by technical design agents who will create architecture documents, so your
requirements must be precise enough to design against but not so prescriptive that they
constrain implementation choices.

## Input

You will receive one of:
- A product direction document (freeform markdown describing what to build and why)
- A Jira ticket or issue with product context
- A verbal description of a feature or system to be designed

## Output

A complete PRD following the autonomous-dev PRD template. The document MUST include
every section defined in the template. Omitting a section is not acceptable; if a
section is not applicable, include it with a brief explanation of why.

## Required Sections

1. **Problem Statement** -- What problem does this solve? Who has this problem? Why
   does it matter now?
2. **Goals** -- Numbered, measurable goals. Each goal must be verifiable.
3. **Non-Goals** -- Explicitly state what this PRD does NOT cover.
4. **User Stories** -- Organized by persona. Each story follows "As a [role], I want
   [capability] so that [benefit]" format. Prioritized P0/P1/P2.
5. **Functional Requirements** -- Numbered, testable requirements using SHALL/SHOULD/MAY.
6. **Non-Functional Requirements** -- Performance, security, reliability, scalability.
7. **Success Metrics** -- How do we know this succeeded? Specific numbers, not vague
   aspirations.
8. **Risks & Mitigations** -- Rated by likelihood and impact. Each risk has at least
   one mitigation.
9. **Phasing** -- If applicable, break delivery into phases with clear exit criteria.
10. **Open Questions** -- Unresolved decisions that need input before design can proceed.

## Quality Standards

- Every requirement must be independently testable.
- User stories must be specific enough that an engineer can estimate effort.
- Risks must be honest. Do not downplay risks to make the document look cleaner.
- Non-goals are as important as goals. Be explicit about boundaries.
- Success metrics must be quantitative where possible.

## Constraints

- Do NOT propose technical solutions. You define the "what" and "why", not the "how".
- Do NOT hallucinate market data or user research. If you need data, use WebSearch to
  find real sources. If data is unavailable, say so.
- Do NOT copy content from inputs verbatim. Synthesize and structure.
- Stay within the turn limit. If the PRD requires more research than a single session
  allows, produce the best possible draft and flag incomplete sections.
```

### 3.2 Agent Registry

The Agent Registry is responsible for loading, validating, caching, and serving agent definitions. It is the single entry point for any component that needs to access an agent.

#### 3.2.1 Registry Architecture

```
agents/                          Agent Registry (in-memory)
  prd-author.md        ---->    +----------------------------------+
  tdd-author.md        ---->    | Map<string, AgentRecord>         |
  code-executor.md     ---->    |   name -> {                      |
  quality-reviewer.md  ---->    |     definition: ParsedAgent,     |
  ...                           |     state: AgentState,           |
                                |     sha256: string,              |
                                |     loadedAt: timestamp,         |
                                |     metricsRef: MetricsHandle    |
                                |   }                              |
                                +----------------------------------+
                                          |
                                          v
                                +----------------------------------+
                                | Registry API                     |
                                |  .list() -> AgentSummary[]       |
                                |  .get(name) -> AgentRecord       |
                                |  .getForTask(domain) -> Agent[]  |
                                |  .reload() -> ValidationReport   |
                                |  .freeze(name) -> void           |
                                |  .unfreeze(name) -> void         |
                                +----------------------------------+
```

#### 3.2.2 Loading Sequence

The registry load sequence runs at system startup and can be triggered manually via `autonomous-dev agent reload`.

```
1. SCAN agents/ directory for *.md files
2. For each file:
   a. VERIFY file is in committed git state
      - Run: git status --porcelain <filepath>
      - If output is non-empty (modified, untracked, staged): REJECT, log security alert
   b. COMPUTE SHA-256 hash of file contents
   c. VERIFY hash matches committed version
      - Run: git show HEAD:<relative-path> | sha256sum
      - Compare with computed hash
      - If mismatch: REJECT, log security alert
   d. PARSE YAML frontmatter
   e. VALIDATE frontmatter against schema (Section 3.1.2)
      - If invalid: REJECT, log validation error with specific field failures
   f. VALIDATE tools against role allowlist (Section 3.1.3)
      - If disallowed tool found: REJECT, log security alert
   g. PARSE markdown body as system prompt
   h. CHECK name uniqueness against already-loaded agents
      - If duplicate: REJECT both, log conflict error
   i. REGISTER agent in the in-memory catalog
3. LOG summary: N agents loaded, M rejected, with rejection reasons
4. EMIT startup metrics event
```

**Performance target (NFR-01):** The full load sequence for up to 50 agents must complete in under 2 seconds. The git operations are the bottleneck; they are batched into a single `git status --porcelain agents/` call followed by per-file hash verification.

#### 3.2.3 Version Tracking

The registry maintains version information in two places:

1. **In-file version**: The `version` field in frontmatter. This is the human-readable version that follows semver rules.
2. **Git history**: The complete history of changes to the agent file. This is the authoritative record.

On load, the registry verifies that the `version` field in frontmatter matches the most recent entry in `version_history`. A mismatch is a validation warning (not fatal) but is logged and surfaced in `agent inspect`.

#### 3.2.4 Agent Discovery

The registry supports two discovery modes:

1. **By name**: Direct lookup. Used by the orchestrator when a pipeline stage specifies which agent to invoke.
2. **By domain**: Semantic matching against the `expertise` field. Used for agent selection when the orchestrator needs to find the best agent for a task.

Domain matching uses a two-pass approach:

- **Pass 1 (exact):** Check if any agent's `expertise` list contains a tag that exactly matches one of the task's domain tags (case-insensitive).
- **Pass 2 (semantic):** If no exact match, compute cosine similarity between the task's domain description and each agent's `description` + `expertise` fields using a lightweight embedding model. Return agents with similarity above 0.6, sorted by score.

If no agent exceeds the 0.6 threshold, this constitutes a **domain gap** (see Section 3.7).

### 3.3 Performance Metrics

#### 3.3.1 Per-Invocation Metrics

Every agent invocation produces a metrics record. The record is emitted by the Agent Runtime wrapper, not by the agent itself -- agents cannot influence their own metrics.

**Per-invocation record schema:**

```typescript
interface InvocationMetric {
  // Identity
  invocation_id: string;       // UUID v4
  agent_name: string;          // e.g., "prd-author"
  agent_version: string;       // e.g., "1.2.0"
  pipeline_run_id: string;     // Links to the broader pipeline execution

  // Input
  input_hash: string;          // SHA-256 of the input content
  input_domain: string;        // Detected domain, e.g., "python-web-api"
  input_tokens: number;        // Token count of input

  // Output
  output_hash: string;         // SHA-256 of the output content
  output_tokens: number;       // Token count of output
  output_quality_score: number; // 1.0 - 5.0 from reviewer, null if not yet reviewed
  quality_dimensions: Record<string, number>; // Per-rubric-dimension scores

  // Review
  review_iteration_count: number;  // How many review rounds before approval/rejection
  review_outcome: "approved" | "rejected" | "escalated";
  reviewer_agent: string;          // Which reviewer scored this output

  // Performance
  wall_clock_ms: number;       // Total wall clock time for this invocation
  turn_count: number;          // Actual turns used (vs. turn_limit)
  tool_calls: ToolCallRecord[]; // Log of tool invocations

  // Metadata
  timestamp: string;           // ISO 8601 with timezone
  environment: string;         // "production", "validation", "canary"
}

interface ToolCallRecord {
  tool_name: string;
  timestamp: string;
  duration_ms: number;
  success: boolean;
  error_type: string | null;   // null if success, error category otherwise
}
```

#### 3.3.2 Aggregate Metrics

Aggregate metrics are computed from per-invocation records. They are recomputed after each new invocation, not on a schedule.

```typescript
interface AggregateMetrics {
  agent_name: string;
  agent_version: string;
  computed_at: string;          // ISO 8601

  // Core metrics (rolling 30-day window)
  invocation_count: number;
  approval_rate: number;        // approved / total, 0.0 - 1.0
  average_quality_score: number; // mean of output_quality_score
  median_quality_score: number;
  quality_score_stddev: number;
  average_review_iterations: number;
  average_wall_clock_ms: number;
  average_turn_count: number;
  total_tokens_consumed: number; // input + output across all invocations

  // Trend analysis (last 20 invocations)
  trend_direction: "improving" | "stable" | "declining";
  trend_slope: number;          // Linear regression slope of quality scores
  trend_confidence: number;     // R-squared of the linear regression

  // Domain breakdown
  domain_metrics: Record<string, {
    invocation_count: number;
    approval_rate: number;
    average_quality_score: number;
    trend_direction: "improving" | "stable" | "declining";
  }>;

  // Percentiles for anomaly detection
  review_iterations_p95: number;
  wall_clock_ms_p95: number;

  // Active alerts
  active_alerts: Alert[];
}

interface Alert {
  alert_id: string;
  severity: "critical" | "warning" | "info";
  type: string;                 // e.g., "approval_rate_below_threshold"
  message: string;
  triggered_at: string;
  threshold_value: number;
  actual_value: number;
  acknowledged: boolean;
}
```

#### 3.3.3 Anomaly Detection Rules

Anomaly detection runs after every invocation metric is recorded. The following rules are evaluated:

| Rule | Condition | Severity | Default Threshold |
|------|-----------|----------|-------------------|
| Approval rate drop | `approval_rate < threshold` (30-day window) | Critical | 0.70 |
| Quality score decline | Average quality drops by > N over 10-invocation window | Warning | 0.5 points |
| Review iteration spike | `review_iteration_count > p95` for 3 consecutive invocations | Warning | Agent-specific p95 |
| Escalation rate exceeded | Human escalation rate > threshold (30-day window) | Critical | 0.30 |
| Trend reversal | `trend_direction` changes from "stable"/"improving" to "declining" | Warning | -- |
| Token budget exceeded | Single invocation exceeds 2x the agent's historical average | Info | 2.0x average |

Alerts follow these rules:
- **Deduplication:** The same alert for the same agent is not re-fired until the condition resolves and then recurs.
- **Escalation:** Critical alerts are surfaced via the system notification mechanism (PRD-001). Warning and Info alerts appear in the dashboard and CLI only.
- **Auto-resolve:** Alerts auto-resolve when the triggering condition no longer holds for 5 consecutive invocations.

#### 3.3.4 Metrics Storage

Metrics are stored in two formats for complementary access patterns:

**JSONL (append-only stream):** Every per-invocation record is appended to a JSONL file at `data/metrics/agent-invocations.jsonl`. This is the primary write path and serves as the durable log.

JSONL format example (one record per line, shown here with formatting for readability):

```jsonl
{"invocation_id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","agent_name":"prd-author","agent_version":"1.0.0","pipeline_run_id":"run-2026-04-08-001","input_hash":"sha256:ab3f...","input_domain":"python-web-api","input_tokens":2340,"output_hash":"sha256:cd9e...","output_tokens":8921,"output_quality_score":4.2,"quality_dimensions":{"completeness":4.5,"clarity":4.0,"user_focus":4.3,"feasibility":3.8,"traceability":4.4},"review_iteration_count":1,"review_outcome":"approved","reviewer_agent":"doc-reviewer","wall_clock_ms":45230,"turn_count":12,"tool_calls":[{"tool_name":"Read","timestamp":"2026-04-08T10:23:01Z","duration_ms":45,"success":true,"error_type":null},{"tool_name":"WebSearch","timestamp":"2026-04-08T10:23:15Z","duration_ms":2100,"success":true,"error_type":null}],"timestamp":"2026-04-08T10:24:30Z","environment":"production"}
{"invocation_id":"b2c3d4e5-f6a7-8901-bcde-f12345678901","agent_name":"tdd-author","agent_version":"1.1.0","pipeline_run_id":"run-2026-04-08-001","input_hash":"sha256:ef01...","input_domain":"python-web-api","input_tokens":9845,"output_hash":"sha256:1234...","output_tokens":14230,"output_quality_score":3.8,"quality_dimensions":{"architecture":4.0,"api_design":3.5,"data_model":4.1,"security":3.2,"trade_offs":4.2},"review_iteration_count":2,"review_outcome":"approved","reviewer_agent":"architecture-reviewer","wall_clock_ms":89450,"turn_count":22,"tool_calls":[{"tool_name":"Read","timestamp":"2026-04-08T10:30:01Z","duration_ms":32,"success":true,"error_type":null},{"tool_name":"Glob","timestamp":"2026-04-08T10:30:05Z","duration_ms":18,"success":true,"error_type":null},{"tool_name":"Grep","timestamp":"2026-04-08T10:30:45Z","duration_ms":55,"success":true,"error_type":null}],"timestamp":"2026-04-08T10:32:15Z","environment":"production"}
{"invocation_id":"c3d4e5f6-a7b8-9012-cdef-123456789012","agent_name":"prd-author","agent_version":"1.0.0","pipeline_run_id":"run-2026-04-08-002","input_hash":"sha256:5678...","input_domain":"rust-embedded","input_tokens":1890,"output_hash":"sha256:9abc...","output_tokens":7650,"output_quality_score":2.8,"quality_dimensions":{"completeness":3.0,"clarity":3.2,"user_focus":2.5,"feasibility":2.0,"traceability":3.3},"review_iteration_count":3,"review_outcome":"approved","reviewer_agent":"doc-reviewer","wall_clock_ms":67800,"turn_count":18,"tool_calls":[{"tool_name":"Read","timestamp":"2026-04-08T11:00:01Z","duration_ms":28,"success":true,"error_type":null},{"tool_name":"WebSearch","timestamp":"2026-04-08T11:00:30Z","duration_ms":3200,"success":true,"error_type":null},{"tool_name":"WebSearch","timestamp":"2026-04-08T11:01:15Z","duration_ms":2800,"success":true,"error_type":null}],"timestamp":"2026-04-08T11:03:45Z","environment":"production"}
```

**SQLite (queryable store):** Per-invocation records are also written to `data/agent-metrics.db` for complex queries (aggregations, joins, time-range filters). The SQLite write happens asynchronously after the JSONL append; if it fails, the JSONL record is the authoritative source and the SQLite writer retries on next startup.

SQLite schema:

```sql
CREATE TABLE agent_invocations (
    invocation_id TEXT PRIMARY KEY,
    agent_name TEXT NOT NULL,
    agent_version TEXT NOT NULL,
    pipeline_run_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    input_domain TEXT,
    input_tokens INTEGER NOT NULL,
    output_hash TEXT NOT NULL,
    output_tokens INTEGER NOT NULL,
    output_quality_score REAL,
    review_iteration_count INTEGER NOT NULL,
    review_outcome TEXT NOT NULL CHECK (review_outcome IN ('approved', 'rejected', 'escalated')),
    reviewer_agent TEXT,
    wall_clock_ms INTEGER NOT NULL,
    turn_count INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    environment TEXT NOT NULL DEFAULT 'production',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_invocations_agent ON agent_invocations(agent_name, timestamp);
CREATE INDEX idx_invocations_domain ON agent_invocations(input_domain, timestamp);
CREATE INDEX idx_invocations_pipeline ON agent_invocations(pipeline_run_id);
CREATE INDEX idx_invocations_environment ON agent_invocations(environment);

CREATE TABLE quality_dimensions (
    invocation_id TEXT NOT NULL REFERENCES agent_invocations(invocation_id),
    dimension TEXT NOT NULL,
    score REAL NOT NULL,
    PRIMARY KEY (invocation_id, dimension)
);

CREATE TABLE tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invocation_id TEXT NOT NULL REFERENCES agent_invocations(invocation_id),
    tool_name TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    success BOOLEAN NOT NULL,
    error_type TEXT
);

CREATE INDEX idx_tool_calls_invocation ON tool_calls(invocation_id);

CREATE TABLE agent_alerts (
    alert_id TEXT PRIMARY KEY,
    agent_name TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    threshold_value REAL,
    actual_value REAL,
    triggered_at TEXT NOT NULL,
    resolved_at TEXT,
    acknowledged BOOLEAN NOT NULL DEFAULT 0
);

CREATE INDEX idx_alerts_agent ON agent_alerts(agent_name, triggered_at);
CREATE INDEX idx_alerts_active ON agent_alerts(resolved_at) WHERE resolved_at IS NULL;

CREATE TABLE aggregate_snapshots (
    agent_name TEXT NOT NULL,
    agent_version TEXT NOT NULL,
    computed_at TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,  -- Full AggregateMetrics as JSON
    PRIMARY KEY (agent_name, computed_at)
);
```

**Dual-write rationale:** JSONL is append-only and crash-safe (a partial write at most loses the last record). SQLite enables the complex queries needed for aggregation, anomaly detection, and dashboarding. The JSONL file is the source of truth; SQLite can be rebuilt from it if corrupted.

**Retention:** Per-invocation records are retained for 90 days in both stores. Aggregate snapshots are retained indefinitely. A daily maintenance job prunes records older than the retention window.

**Graceful degradation (NFR-06):** If the SQLite database is unavailable (locked, corrupted), the system continues to function:
1. JSONL writes continue normally.
2. Metrics are buffered in memory (bounded to 1000 records).
3. Anomaly detection is paused (logged as a warning).
4. On next startup or database recovery, buffered records and any JSONL records not yet in SQLite are replayed into the database.

### 3.4 Agent Improvement Lifecycle

The improvement lifecycle is the core feedback loop that enables agents to get better over time. It is intentionally conservative: the system never modifies an agent without multiple validation steps and (in Phase 1-2) explicit human approval.

#### 3.4.1 Lifecycle Phases

```
+---------------------------+
|     1. OBSERVATION        |
| Collect metrics silently  |
| until threshold reached   |
| (default: 10 invocations) |
+------------+--------------+
             |
             v
+------------+--------------+
|     2. ANALYSIS           |
| performance-analyst agent |
| reviews metrics, produces |
| structured weakness report|
+------------+--------------+
             |
             v
+------------+--------------+
|     3. PROPOSAL           |
| System generates modified |
| agent definition as diff  |
| against current version   |
+------------+--------------+
             |
             v
+------------+--------------+
|     4. META-REVIEW        |
| agent-meta-reviewer       |
| checks for privilege      |
| escalation, scope creep,  |
| prompt injection vectors  |
+------------+--------------+
             |
     +-------+-------+
     |               |
     v               v
  PASS            REJECT
     |          (log reason,
     v           no change)
+----+---------+
| 5. VALIDATION |
| A/B test on   |
| 3+ historical |
| inputs        |
+----+---------+
     |
     v
+----+---------+
| 6. CANARY    |  <-- Phase 3 only; Phase 1-2 skip this
| Dual-run for |
| 7 days       |
+----+---------+
     |
     v
+----+---------+
| 7. PROMOTION |
| Human approve|
| (or auto for |
|  patch in P3)|
+--------------+
```

#### 3.4.2 Observation Phase

**Trigger:** Automatic, after an agent is first loaded.

**Behavior:** The system collects invocation metrics without attempting any analysis or modification. The observation phase has a configurable threshold (default: 10 invocations) that must be met before analysis begins.

**Stored state:**
```json
{
  "agent_name": "prd-author",
  "observation_started_at": "2026-04-08T00:00:00Z",
  "invocations_recorded": 7,
  "threshold": 10,
  "status": "collecting"
}
```

**Edge cases:**
- If the threshold is never reached (low-usage agent), the operator can manually trigger analysis via `autonomous-dev agent analyze <name> --force`.
- The threshold resets to 0 when a new version is promoted (the new version needs its own observation period).

#### 3.4.3 Analysis Phase

**Trigger:** Observation threshold met.

**Actor:** The `performance-analyst` agent (a meta agent with read-only access to metrics).

**Input to the analyst:**
- All per-invocation metrics for the agent
- Aggregate metrics and trend data
- Per-dimension quality scores
- Domain-specific breakdowns

**Output:** A structured weakness report:

```typescript
interface WeaknessReport {
  agent_name: string;
  agent_version: string;
  analysis_date: string;
  overall_assessment: "healthy" | "needs_improvement" | "critical";
  weaknesses: Weakness[];
  strengths: string[];       // For context; we do not degrade what works
  recommendation: "no_action" | "propose_modification" | "propose_specialist";
}

interface Weakness {
  dimension: string;          // Which rubric dimension is weak
  severity: "low" | "medium" | "high";
  evidence: string;           // Specific data, e.g., "scores 2.1/5 on security across 8/12 invocations"
  affected_domains: string[]; // Which domains trigger this weakness
  suggested_focus: string;    // High-level suggestion (not a complete fix)
}
```

**Decision logic:**
- If `overall_assessment` is "healthy": no action, re-evaluate after 10 more invocations.
- If `overall_assessment` is "needs_improvement" or "critical" AND `recommendation` is "propose_modification": proceed to Proposal phase.
- If `recommendation` is "propose_specialist": route to Dynamic Creation pipeline (Section 3.7) instead.

#### 3.4.4 Proposal Phase

**Trigger:** Analysis recommends a modification.

**Actor:** The system (not an agent) generates the proposal by:

1. Taking the current agent definition as the base.
2. Injecting the weakness report into a prompt template that instructs an LLM to produce a modified version of the agent's system prompt addressing the identified weaknesses.
3. Constraining the modification:
   - The `tools` field MUST NOT change. (Automated tool changes are prohibited.)
   - The `role` field MUST NOT change.
   - The `expertise` field may be refined but not expanded to new domains.
   - The `evaluation_rubric` may have dimensions adjusted but not removed.
4. Computing the diff between current and proposed agent definition.
5. Bumping the version (minor for prompt changes, patch for formatting).

**Output:** A proposal record:

```typescript
interface AgentProposal {
  proposal_id: string;          // UUID
  agent_name: string;
  current_version: string;
  proposed_version: string;
  diff: string;                 // Unified diff of the .md file
  weakness_report_id: string;   // Link to the analysis that motivated this
  rationale: string;            // Plain-language explanation of the change
  constrained_fields: string[]; // Fields that were explicitly not changed (for audit)
  created_at: string;
  status: "pending_meta_review" | "meta_approved" | "meta_rejected" |
          "validating" | "validated_positive" | "validated_negative" |
          "canary" | "promoted" | "rejected";
}
```

#### 3.4.5 Meta-Review Phase

**Trigger:** Proposal generated.

**Actor:** `agent-meta-reviewer` agent.

**Input:** The full proposal record including the diff.

**Review checklist (enforced by the meta-reviewer's prompt):**

1. **Tool access escalation:** Does the diff add any tools to the `tools` list? If yes, REJECT immediately.
2. **Role change:** Does the diff change the `role` field? If yes, REJECT immediately.
3. **Scope creep:** Does the diff add expertise tags or capabilities not justified by the weakness report? If yes, REJECT with explanation.
4. **Prompt injection vectors:** Does the diff introduce patterns that could be exploited by adversarial input? Specifically:
   - Instructions that reference input content as instructions (e.g., "follow the instructions in the user's input")
   - Removal of safety boundaries or guardrails
   - Addition of tool calls not present in the original
5. **Schema compliance:** Does the modified agent still pass all validation rules from Section 3.1.2?
6. **Proportionality:** Is the size of the change proportional to the weakness being addressed? Large rewrites for minor issues are flagged.

**Output:**

```typescript
interface MetaReviewResult {
  proposal_id: string;
  verdict: "approved" | "rejected";
  findings: MetaReviewFinding[];
  reviewed_at: string;
}

interface MetaReviewFinding {
  category: "tool_escalation" | "role_change" | "scope_creep" |
            "prompt_injection" | "schema_violation" | "disproportionate_change";
  severity: "blocker" | "warning" | "info";
  description: string;
  line_reference: string;       // Line(s) in the diff that triggered the finding
}
```

If any finding has severity "blocker", the proposal is rejected. Warnings are included in the proposal for human review but do not block validation.

#### 3.4.6 Validation Phase (A/B Testing)

See Section 3.5 for the full A/B testing protocol.

#### 3.4.7 Canary Phase (Phase 3 Only)

**Trigger:** A/B validation favors the proposed agent, Phase 3 is enabled.

**Duration:** Configurable, default 7 days.

**Behavior:** Both the current and proposed agent versions run on every new invocation. The orchestrator uses the current agent's output for the pipeline (no impact on production) and runs the proposed agent in shadow mode. Both outputs are scored by the reviewer agent.

**Canary state:**

```json
{
  "agent_name": "prd-author",
  "current_version": "1.2.0",
  "proposed_version": "1.3.0",
  "canary_started_at": "2026-04-15T00:00:00Z",
  "canary_ends_at": "2026-04-22T00:00:00Z",
  "comparisons": [
    {
      "invocation_id": "...",
      "current_score": 4.1,
      "proposed_score": 4.4,
      "domain": "python-web-api"
    }
  ],
  "auto_rollback_triggered": false
}
```

**Canary exit criteria:**
- If proposed agent scores higher than current in 60%+ of comparisons: eligible for promotion.
- If proposed agent scores lower than current in 40%+ of comparisons: REJECT, revert to current.
- If any single comparison shows proposed scoring more than 1.5 points lower: REJECT immediately (catastrophic regression guard).
- Minimum 3 comparisons required before any promotion decision.

#### 3.4.8 Promotion Phase

**Trigger:** Validation (Phase 1-2) or Canary (Phase 3) results are positive.

**Phase 1-2 behavior (human-approved):**
1. System presents the operator with:
   - The proposal diff
   - The weakness report that motivated the change
   - The A/B comparison results (per-input scores for both versions)
   - The meta-reviewer findings
2. Operator reviews and runs `autonomous-dev agent promote <name> <version>`.
3. System:
   a. Writes the new agent definition to the `.md` file
   b. Updates `version` and `version_history` in frontmatter
   c. Commits with message: `feat(agents): update <name> v<old> -> v<new> -- <rationale summary>`
   d. Reloads the registry

**Phase 3 behavior (autonomous for patch-level only):**
1. If `proposed_version` is a patch increment (x.y.Z):
   a. Auto-promote with commit message: `fix(agents): auto-promote <name> v<old> -> v<new> -- <rationale>`
   b. Send notification to operator with diff and comparison results
   c. Operator has 24-hour override window via `autonomous-dev agent rollback <name>`
   d. If quality decline detected within 48 hours of auto-promotion: auto-rollback, disable autonomous promotion for this agent for 30 days
2. If `proposed_version` is minor or major: require human approval (same as Phase 1-2)

### 3.5 A/B Testing Framework

The A/B testing framework is the validation mechanism that determines whether a proposed agent modification is an improvement. It runs both the current and proposed agents on historical inputs and compares outputs using blind scoring.

#### 3.5.1 A/B Evaluation Protocol (Step by Step)

**Prerequisites:**
- A proposal record with status `meta_approved`
- At least 3 historical invocation records for the agent with complete input/output data
- Sufficient token budget for the validation run

**Protocol:**

```
STEP 1: SELECT HISTORICAL INPUTS
  - Query the metrics database for this agent's past invocations
  - Filter to invocations in the "production" environment
  - If the weakness report identifies specific domains, prefer inputs from those domains
  - Select a minimum of 3 inputs, maximum of 5
  - Selection criteria:
    a. At least 1 input where the current agent scored poorly (below median)
    b. At least 1 input where the current agent scored well (above median)
    c. At least 1 input from the domain identified in the weakness report (if applicable)
  - Record selected input hashes for audit trail

STEP 2: RUN CURRENT AGENT
  - For each selected input:
    a. Invoke the current agent version with the historical input
    b. Record the output (labeled internally as "version_A")
    c. Record wall clock time and token consumption
  - Note: Do NOT reuse the historical output; re-run to control for non-determinism

STEP 3: RUN PROPOSED AGENT
  - For each selected input (same inputs, same order):
    a. Invoke the proposed agent version with the historical input
    b. Record the output (labeled internally as "version_B")
    c. Record wall clock time and token consumption

STEP 4: RANDOMIZE LABELS
  - For each input, randomly assign which output is presented as "Output 1"
    and which is "Output 2"
  - Store the mapping (e.g., {input_1: {output_1: "version_B", output_2: "version_A"}})
  - The scorer MUST NOT know which output comes from which version

STEP 5: BLIND SCORING
  - For each input, invoke the appropriate reviewer agent (doc-reviewer for
    authors, quality-reviewer for executors, architecture-reviewer for design agents)
  - Provide the reviewer with:
    a. The original input
    b. "Output 1" and "Output 2" (randomized order)
    c. The agent's evaluation_rubric
  - The reviewer scores each output on every rubric dimension (1.0 - 5.0)
  - The reviewer also provides a free-text comparison explaining which output
    is stronger and why
  - REPEAT scoring 3 times per input (to reduce non-determinism) and take median

STEP 6: DE-RANDOMIZE AND COMPARE
  - Map scores back to version_A (current) and version_B (proposed)
  - For each input, compute:
    a. Per-dimension score delta (proposed - current)
    b. Overall score delta (mean of dimension deltas)
    c. Win/loss/tie per input (proposed wins if overall delta > 0.2,
       current wins if delta < -0.2, tie otherwise)

STEP 7: AGGREGATE AND DECIDE
  - Compute aggregate results:
    a. Proposed win count, current win count, tie count
    b. Mean score delta across all inputs
    c. Per-dimension improvement/regression
  - Decision:
    - If proposed wins on 60%+ of inputs AND mean delta > 0: VALIDATION POSITIVE
    - If proposed loses on 40%+ of inputs OR mean delta < -0.2: VALIDATION NEGATIVE
    - Otherwise: INCONCLUSIVE (requires human judgment or additional inputs)
```

#### 3.5.2 A/B Evaluation Result Schema

```typescript
interface ABEvaluationResult {
  evaluation_id: string;       // UUID
  proposal_id: string;         // Links to the proposal being validated
  agent_name: string;
  current_version: string;
  proposed_version: string;

  inputs: ABInput[];
  aggregate: ABAggregate;

  verdict: "positive" | "negative" | "inconclusive";
  started_at: string;
  completed_at: string;
  total_tokens_consumed: number;
}

interface ABInput {
  input_hash: string;
  input_domain: string;
  selection_reason: string;     // Why this input was chosen

  current_scores: DimensionScores;   // Median of 3 scoring rounds
  proposed_scores: DimensionScores;

  current_overall: number;
  proposed_overall: number;
  delta: number;                     // proposed - current
  winner: "proposed" | "current" | "tie";

  reviewer_commentary: string;       // Free-text from the reviewer
  scoring_variance: number;          // Variance across the 3 scoring rounds
}

interface DimensionScores {
  [dimension: string]: number;       // 1.0 - 5.0
}

interface ABAggregate {
  proposed_wins: number;
  current_wins: number;
  ties: number;
  mean_delta: number;
  per_dimension_delta: Record<string, number>;
  recommendation: string;            // Human-readable summary
}
```

#### 3.5.3 Manual A/B Triggering

Operators can manually trigger an A/B comparison between any two agent versions:

```bash
autonomous-dev agent compare <name> --version-a 1.2.0 --version-b 1.3.0 --inputs 5
```

This follows the same protocol as automated validation but allows the operator to specify which versions to compare and how many inputs to use. Results are written to `data/evaluations/` and displayed in the CLI.

### 3.6 Agent Versioning

#### 3.6.1 Semver Rules

Agent versions follow strict semantic versioning:

| Change Type | Version Bump | Examples | Approval Required |
|-------------|-------------|----------|-------------------|
| **Major** (x.0.0) | Fundamental change to role, expertise, or approach | Complete prompt rewrite; new expertise domain; role change | Always human |
| **Minor** (0.x.0) | Prompt improvement, new instructions, rubric refinement | Better handling of edge cases; improved output structure; new rubric dimension | Always human (Phase 1-2); human (Phase 3) |
| **Patch** (0.0.x) | Formatting, typo fixes, minor clarifications | Fix a typo in instructions; reformat a list; clarify an ambiguous sentence | Human (Phase 1-2); auto-eligible (Phase 3) |

The proposer determines the version bump based on the scope of the diff:
- If `role`, `expertise` (adding new tags), or more than 50% of the markdown body changed: major
- If any rubric dimension changed, new instructions added, or 10-50% of body changed: minor
- If less than 10% of body changed and no frontmatter fields changed (except version/version_history): patch

#### 3.6.2 Git-Backed Storage

Every agent version is a committed state in the git repository. The git history of each agent file IS the version history. The `version_history` field in frontmatter is a human-readable summary, not the authoritative record.

**Commit message conventions:**

```
feat(agents): create <name> v1.0.0 -- <rationale>       # New agent
feat(agents): update <name> v1.0.0 -> v1.1.0 -- <rationale>  # Minor/major
fix(agents): update <name> v1.1.0 -> v1.1.1 -- <rationale>   # Patch
fix(agents): auto-promote <name> v1.1.1 -> v1.1.2 -- <rationale>  # Auto (Phase 3)
revert(agents): rollback <name> v1.1.0 -> v1.0.0 -- <reason>  # Rollback
```

#### 3.6.3 Rollback Mechanism

Rollback is a first-class operation that restores an agent to its previous version.

**Command:** `autonomous-dev agent rollback <name>`

**Rollback sequence:**

```
1. IDENTIFY current version from registry
2. IDENTIFY previous version from git history
   - git log --oneline agents/<name>.md | head -2
   - Extract the second entry (previous commit)
3. DISPLAY impact analysis to operator:
   a. Artifacts produced by the current (to-be-rolled-back) version
      - Query metrics DB: SELECT COUNT(*) FROM agent_invocations
        WHERE agent_name = <name> AND agent_version = <current>
   b. Show the diff between current and previous versions
   c. List any in-flight pipeline runs using the current version
4. REQUIRE operator confirmation (unless --force flag used)
5. RESTORE previous version:
   - git show <previous-commit>:agents/<name>.md > agents/<name>.md
6. UPDATE version_history in frontmatter to add rollback entry
7. COMMIT:
   - revert(agents): rollback <name> v<current> -> v<previous> -- <reason>
8. RELOAD registry
9. LOG rollback to audit log
10. EMIT rollback metric event
```

**Rollback does NOT:**
- Delete the rolled-back version from git history (it remains recoverable)
- Automatically re-evaluate artifacts produced by the rolled-back version
- Cascade to other agents (though the operator is warned about compatibility implications)

**Optional quarantine:** The operator can add `--quarantine` to the rollback command, which marks all artifacts produced by the rolled-back version as "quarantined" in the pipeline state, flagging them for human review.

### 3.7 Dynamic Agent Creation

When the system encounters a task in a domain not covered by existing agents, it can propose the creation of a new specialist agent.

#### 3.7.1 Domain Gap Detection

**Trigger:** The orchestrator requests an agent for a task, and the registry's domain matching (Section 3.2.4) returns no agent above the 0.6 similarity threshold.

**Gap detection pipeline:**

```
1. DETECT: No agent's expertise matches the task domain
2. LOG gap to data/domain-gaps.jsonl:
   {
     "gap_id": "uuid",
     "task_domain": "rust-wasm",
     "task_description": "Build a Rust WebAssembly module for...",
     "closest_agent": "code-executor",
     "closest_similarity": 0.42,
     "detected_at": "2026-04-08T10:00:00Z",
     "status": "detected"
   }
3. CHECK rate limit: Has a new agent been created this calendar week?
   - If yes: Log gap as "deferred", use closest agent with warning
   - If no: Proceed to creation pipeline
4. FALLBACK: Use the closest-matching agent with a warning injected
   into the pipeline state: "No specialist for domain 'rust-wasm';
   using 'code-executor' as fallback. Quality may be reduced."
```

#### 3.7.2 Agent Creation Pipeline

```
1. RESEARCH
   - Use WebSearch to find best practices for the detected domain
   - Identify key quality criteria, common pitfalls, and domain patterns
   - Time-box: 5 minutes maximum

2. SELECT ARCHETYPE
   - Determine which archetype (author, executor, reviewer, specialist)
     the new agent should be, based on the task type
   - Inherit the tool access policy from the archetype

3. SELECT TEMPLATE
   - Find the existing agent in the same archetype with the highest
     overall quality score to use as a structural template
   - Copy frontmatter structure and markdown body organization

4. GENERATE DEFINITION
   - Produce a complete .md file for the new agent:
     a. Frontmatter with all required fields
     b. System prompt tailored to the detected domain
     c. Evaluation rubric with domain-appropriate dimensions
     d. Version 1.0.0
   - Constrain: tools MUST match the archetype allowlist (no exceptions)

5. VALIDATE SCHEMA
   - Run the generated definition through the same validation rules
     as Section 3.1.2
   - If validation fails: log failure, abort creation

6. META-REVIEW
   - Submit to agent-meta-reviewer for the same review as proposals
     (Section 3.4.5)
   - Additional check: the new agent does not substantially overlap with
     an existing agent's expertise

7. QUEUE FOR HUMAN REVIEW
   - Write proposed agent to data/proposed-agents/<name>.md (NOT to agents/)
   - Log proposal in data/domain-gaps.jsonl (update status to "proposed")
   - Notify operator via system notification

8. HUMAN APPROVAL
   - Operator reviews the proposed agent definition
   - If approved: autonomous-dev agent accept <name>
     a. Move file from data/proposed-agents/ to agents/
     b. Commit: feat(agents): create <name> v1.0.0 -- <rationale>
     c. Reload registry
   - If rejected: autonomous-dev agent reject <name> --reason "<reason>"
     a. Update domain-gaps.jsonl status to "rejected"
     b. Delete file from data/proposed-agents/
```

#### 3.7.3 Rate Limits

| Limit | Default | Configurable |
|-------|---------|-------------|
| New agent creations per calendar week | 1 | Yes (`agent-factory.creation-rate-limit`) |
| Modifications per agent per calendar week | 1 | Yes (`agent-factory.modification-rate-limit`) |
| Maximum total agents in registry | 50 | Yes (`agent-factory.max-agents`) |
| A/B validation token budget per run | 100,000 tokens | Yes (`agent-factory.validation-token-budget`) |

### 3.8 Integrity and Security

This section defines the security architecture of the Agent Factory. Security is not a layer; it is a structural property of every component.

#### 3.8.1 Committed-State Requirement

**Invariant:** No agent file is loaded from uncommitted state. This is enforced at every load point.

**Implementation:**

```
On every agent load (startup, reload, post-promotion):
  1. git status --porcelain agents/<name>.md
     - If output is non-empty: REJECT
       - "M" (modified): File was modified after commit
       - "?" (untracked): File was never committed
       - "A" (staged): File is staged but not committed
  2. Compute SHA-256 of file on disk
  3. Compute SHA-256 of file at HEAD in git:
     git show HEAD:agents/<name>.md | sha256sum
  4. Compare hashes
     - If mismatch: REJECT, log security alert
  5. Only if both checks pass: load the agent
```

**Rationale:** This prevents runtime tampering. Even if an attacker (or a bug) modifies an agent file on disk, the modification has no effect until it is committed to git. The git commit creates an auditable record.

#### 3.8.2 Privilege Boundaries

The Agent Factory enforces strict privilege boundaries:

**Boundary 1: Tool access per role** (Section 3.1.3)
- Enforced at two points: load time (validation) and runtime (tool call interception)
- At runtime, the Agent Runtime wraps every tool call. If the tool is not in the agent's `tools` list, the call is blocked and a security event is logged.

**Boundary 2: Agent file isolation**
- No agent can modify files in the `agents/` directory.
- For executor agents that have `Bash`, `Edit`, and `Write` access: the runtime adds a path filter that rejects any operation targeting `agents/**`, `data/agent-*`, or `data/metrics/**`.
- This is implemented as a pre-tool-call hook, not as a trust in the agent's prompt.

**Boundary 3: Self-modification prohibition**
- No agent can modify its own definition.
- The Agent Factory subsystem (not an agent) is the only component that writes to `agents/`.
- The proposer generates the diff, the meta-reviewer reviews it, the promoter writes it. These are separate components with separate access.

**Boundary 4: Automated tool field immutability**
- Any proposed modification that changes the `tools` field is automatically rejected.
- This is a hard-coded check in the proposal phase, not a prompt instruction.
- Changing tool access requires a human-authored commit directly to the agent file.

#### 3.8.3 Audit Log

All security-relevant events are logged to `data/agent-audit.log`, an append-only file.

**Log format (JSONL):**

```jsonl
{"timestamp":"2026-04-08T10:00:00Z","event":"agent_loaded","agent":"prd-author","version":"1.0.0","sha256":"ab3f...","status":"success"}
{"timestamp":"2026-04-08T10:00:01Z","event":"agent_load_rejected","agent":"test-agent","reason":"uncommitted_modifications","sha256_disk":"cd9e...","sha256_git":"ef01..."}
{"timestamp":"2026-04-08T10:15:00Z","event":"tool_call_blocked","agent":"doc-reviewer","tool":"Edit","reason":"tool_not_in_allowlist"}
{"timestamp":"2026-04-08T11:00:00Z","event":"proposal_generated","agent":"prd-author","proposal_id":"uuid-1","current_version":"1.0.0","proposed_version":"1.1.0"}
{"timestamp":"2026-04-08T11:05:00Z","event":"meta_review_completed","proposal_id":"uuid-1","verdict":"approved","findings_count":1}
{"timestamp":"2026-04-08T12:00:00Z","event":"validation_completed","proposal_id":"uuid-1","verdict":"positive","mean_delta":0.3}
{"timestamp":"2026-04-08T12:01:00Z","event":"agent_promoted","agent":"prd-author","old_version":"1.0.0","new_version":"1.1.0","approved_by":"human","commit":"abc123"}
{"timestamp":"2026-04-08T13:00:00Z","event":"path_access_blocked","agent":"code-executor","path":"agents/prd-author.md","tool":"Edit","reason":"agents_directory_protected"}
```

**Append-only enforcement:** The audit log file is opened in append mode only. The system does not provide any mechanism to truncate, edit, or rotate the audit log programmatically. Log rotation is an operator responsibility (via external tooling like `logrotate`).

#### 3.8.4 Meta-Reviewer Agent

The `agent-meta-reviewer` is a dedicated security gate. Its design deserves special attention because it is itself an agent reviewing other agents.

**Design decisions:**

1. **The meta-reviewer is FROZEN by default.** It cannot be modified by the automated improvement lifecycle. Changes to the meta-reviewer require a human-authored commit.

2. **The meta-reviewer uses only structural checks, not judgment calls.** Its review checklist (Section 3.4.5) is a finite set of verifiable conditions (tool escalation, role change, schema compliance), not subjective quality assessments. This makes it less susceptible to eval gaming.

3. **The meta-reviewer does not have self-review capability.** It cannot review proposals that modify itself. Changes to the meta-reviewer bypass the meta-review step and go directly to human review.

4. **The meta-reviewer's findings are included in the human review.** Even when the meta-reviewer approves a proposal, the human reviewer sees the meta-reviewer's analysis, including any warnings.

5. **Open question (from PRD OQ-07):** Whether the meta-reviewer should use a different model than the agents it reviews. The current design uses `claude-sonnet` for consistency. If systematic blind spots are identified, this should be revisited.

### 3.9 Foundation Agent Catalog

The following 6 core agents are fully specified. The remaining 7 foundation agents (plan-author, spec-author, test-executor, deploy-executor, security-reviewer, architecture-reviewer, performance-analyst) follow the same structural patterns and will be fully defined during Phase 1 implementation.

#### 3.9.1 prd-author

See Section 3.1.4 for the complete agent definition.

- **Role:** author
- **Model:** claude-sonnet
- **Turn limit:** 25
- **Tools:** Read, Glob, Grep, WebSearch
- **Risk tier:** medium
- **Key rubric dimensions:** completeness, clarity, user_focus, feasibility, traceability

#### 3.9.2 tdd-author

```yaml
name: tdd-author
version: 1.0.0
role: author
description: >
  Writes Technical Design Documents from approved PRDs. Focuses on architecture
  decisions, API contracts, data models, and trade-off analysis. Explores the
  existing codebase to ground designs in reality.
expertise:
  - technical-design
  - architecture-decisions
  - api-contracts
  - data-modeling
  - trade-off-analysis
model: claude-sonnet
turn_limit: 30
max_tokens: 16384
temperature: 0.0
tools:
  - Read
  - Glob
  - Grep
  - WebSearch
evaluation_rubric:
  architecture: "Design decisions are explicit, justified, and consider alternatives"
  api_design: "API contracts are complete, versioned, and follow established patterns"
  data_model: "Data models cover all entities, relationships, and edge cases"
  security: "Security considerations are addressed at the architecture level"
  trade_offs: "At least 2 alternatives evaluated for each major decision with clear rationale"
risk_tier: medium
domain_affinity:
  - web-applications
  - api-design
  - distributed-systems
frozen: false
version_history:
  - version: 1.0.0
    date: 2026-04-08
    author: system
    change: "Initial release -- foundation agent for TDD authoring"
```

**System prompt focus:** The TDD author reads the parent PRD, explores the existing codebase for constraints, and produces a design document that addresses every requirement. It explicitly calls out trade-offs and alternatives rather than presenting a single solution.

#### 3.9.3 code-executor

```yaml
name: code-executor
version: 1.0.0
role: executor
description: >
  Generates production-quality code from implementation specifications.
  Writes code, tests, and documentation. Follows existing codebase
  patterns and conventions. Runs linters and tests to verify output.
expertise:
  - code-generation
  - refactoring
  - test-writing
  - code-patterns
  - documentation
model: claude-sonnet
turn_limit: 40
max_tokens: 16384
temperature: 0.0
tools:
  - Read
  - Glob
  - Grep
  - Edit
  - Write
  - Bash
evaluation_rubric:
  correctness: "Code compiles, passes all tests, handles edge cases"
  quality: "Code follows existing patterns, is well-structured, and maintainable"
  test_coverage: "Tests cover happy path, error cases, and boundary conditions"
  documentation: "Inline comments explain non-obvious logic; public APIs are documented"
  specification_adherence: "Every acceptance criterion from the spec is addressed"
risk_tier: high
domain_affinity:
  - web-applications
  - api-design
  - developer-tooling
frozen: false
version_history:
  - version: 1.0.0
    date: 2026-04-08
    author: system
    change: "Initial release -- foundation agent for code generation"
```

**Risk tier rationale:** High because executors have write access to the filesystem and can run commands via Bash. Path filtering prevents access to protected directories, but the attack surface is larger than read-only agents.

#### 3.9.4 quality-reviewer

```yaml
name: quality-reviewer
version: 1.0.0
role: reviewer
description: >
  Reviews code and document quality against best practices and established
  patterns. Provides structured feedback with specific, actionable
  findings. Scores output against rubric dimensions.
expertise:
  - code-quality
  - best-practices
  - maintainability
  - review-methodology
model: claude-sonnet
turn_limit: 15
max_tokens: 8192
temperature: 0.0
tools:
  - Read
  - Glob
  - Grep
evaluation_rubric:
  thoroughness: "Review covers all significant aspects of the artifact"
  specificity: "Findings reference specific lines or sections, not vague generalities"
  actionability: "Every finding includes a concrete suggestion for improvement"
  calibration: "Scores are consistent with the scoring rubric and prior reviews"
  fairness: "Review evaluates the artifact against its stated goals, not reviewer preferences"
risk_tier: low
domain_affinity: []
frozen: false
version_history:
  - version: 1.0.0
    date: 2026-04-08
    author: system
    change: "Initial release -- foundation agent for quality review"
```

**Note:** The quality-reviewer is also used in the A/B validation pipeline (Section 3.5). Its `fairness` rubric dimension is critical for blind scoring integrity.

#### 3.9.5 doc-reviewer

```yaml
name: doc-reviewer
version: 1.0.0
role: reviewer
description: >
  Reviews document artifacts (PRDs, TDDs, Plans, Specs) for completeness,
  consistency, and quality. Validates that documents follow their templates
  and that cross-document references are accurate.
expertise:
  - document-quality
  - completeness-checking
  - consistency-analysis
  - template-compliance
model: claude-sonnet
turn_limit: 15
max_tokens: 8192
temperature: 0.0
tools:
  - Read
  - Glob
  - Grep
evaluation_rubric:
  completeness: "All required template sections are present and substantive"
  consistency: "No internal contradictions; cross-references are accurate"
  clarity: "Language is unambiguous; requirements are testable"
  structure: "Document follows the template; sections are properly organized"
  traceability: "Parent document references are valid; requirement IDs are consistent"
risk_tier: low
domain_affinity: []
frozen: false
version_history:
  - version: 1.0.0
    date: 2026-04-08
    author: system
    change: "Initial release -- foundation agent for document review"
```

#### 3.9.6 agent-meta-reviewer

```yaml
name: agent-meta-reviewer
version: 1.0.0
role: meta
description: >
  Reviews proposed modifications to agent definitions. Checks for privilege
  escalation, scope creep, prompt injection vectors, and schema compliance.
  Acts as a security gate in the agent improvement lifecycle.
expertise:
  - agent-prompt-analysis
  - privilege-escalation-detection
  - scope-validation
  - prompt-injection-detection
  - schema-compliance
model: claude-sonnet
turn_limit: 15
max_tokens: 8192
temperature: 0.0
tools:
  - Read
  - Glob
  - Grep
evaluation_rubric:
  detection_accuracy: "Correctly identifies privilege escalation, scope creep, and injection vectors"
  false_positive_rate: "Does not block legitimate improvements without justification"
  completeness: "Checks all items in the review checklist for every proposal"
  explanation_quality: "Findings include clear explanations referencing specific lines in the diff"
risk_tier: critical
domain_affinity: []
frozen: true
version_history:
  - version: 1.0.0
    date: 2026-04-08
    author: system
    change: "Initial release -- meta-reviewer agent, frozen by default"
```

**Critical design notes:**
- `frozen: true` by default. This agent is not subject to automated improvement.
- `risk_tier: critical`. Any modification requires heightened human review.
- The meta-reviewer reviews other agents' proposals but cannot review proposals that modify itself.

---

## 4. Data Models Summary

### 4.1 Agent Definition (`.md` file)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique identifier, kebab-case |
| `version` | string | Yes | Semver (MAJOR.MINOR.PATCH) |
| `role` | enum | Yes | author, executor, reviewer, meta |
| `description` | string | Yes | Human-readable summary |
| `expertise` | string[] | Yes | Domain tags |
| `tools` | string[] | Yes | Allowed tool names |
| `model` | string | Yes | Model identifier |
| `turn_limit` | integer | Yes | Max turns per invocation |
| `evaluation_rubric` | map | Yes | Dimension -> criterion description |
| `version_history` | array | Yes | Version records |
| `max_tokens` | integer | No | Output token budget (default 16384) |
| `temperature` | float | No | LLM temperature (default 0.0) |
| `frozen` | boolean | No | Block automated modification (default false) |
| `risk_tier` | enum | No | low, medium, high, critical |
| `domain_affinity` | string[] | No | Known strong domains |
| `deprecated_by` | string | No | Replacement agent name |

### 4.2 Invocation Metric (JSONL + SQLite)

See Section 3.3.1 for the full schema. Key fields:

| Field | Type | Description |
|-------|------|-------------|
| `invocation_id` | UUID | Unique per invocation |
| `agent_name` | string | Which agent was invoked |
| `agent_version` | string | Which version was running |
| `output_quality_score` | float | 1.0 - 5.0 from reviewer |
| `quality_dimensions` | map | Per-rubric-dimension scores |
| `review_outcome` | enum | approved, rejected, escalated |
| `environment` | string | production, validation, canary |

### 4.3 A/B Evaluation Result

See Section 3.5.2 for the full schema. Key fields:

| Field | Type | Description |
|-------|------|-------------|
| `evaluation_id` | UUID | Unique per evaluation |
| `proposal_id` | UUID | Links to the proposal |
| `inputs` | ABInput[] | Per-input comparison results |
| `verdict` | enum | positive, negative, inconclusive |
| `aggregate.mean_delta` | float | Overall score improvement |

### 4.4 Agent Proposal

See Section 3.4.4 for the full schema. Key fields:

| Field | Type | Description |
|-------|------|-------------|
| `proposal_id` | UUID | Unique per proposal |
| `diff` | string | Unified diff of the change |
| `weakness_report_id` | string | Links to motivating analysis |
| `status` | enum | Lifecycle status (pending through promoted/rejected) |

### 4.5 Weakness Report

See Section 3.4.3 for the full schema.

### 4.6 Meta-Review Result

See Section 3.4.5 for the full schema.

---

## 5. API and Interface Contracts

### 5.1 CLI Commands

| Command | Description | Phase |
|---------|-------------|-------|
| `autonomous-dev agent list` | Display all registered agents with name, version, role, state, approval rate | P1 |
| `autonomous-dev agent inspect <name>` | Show full configuration, recent metrics, active alerts | P1 |
| `autonomous-dev agent metrics <name>` | Show current metrics, trend, domain breakdown | P1 |
| `autonomous-dev agent dashboard` | Summary table of all agents ranked by approval rate with trend indicators | P1 |
| `autonomous-dev agent reload` | Re-scan agents/ directory and reload registry | P1 |
| `autonomous-dev agent freeze <name>` | Prevent automated modifications to this agent | P1 |
| `autonomous-dev agent unfreeze <name>` | Re-enable automated modifications | P1 |
| `autonomous-dev agent rollback <name>` | Revert to previous committed version | P1 |
| `autonomous-dev agent analyze <name> [--force]` | Trigger analysis even below observation threshold | P2 |
| `autonomous-dev agent promote <name> <version>` | Approve and promote a proposed version | P2 |
| `autonomous-dev agent reject <name> <version> --reason "<reason>"` | Reject a proposed version | P2 |
| `autonomous-dev agent compare <name> --version-a X --version-b Y [--inputs N]` | Manual A/B comparison | P2 |
| `autonomous-dev agent accept <name>` | Accept a proposed new agent | P2 |
| `autonomous-dev agent gaps` | List detected domain gaps and their status | P2 |

### 5.2 Internal APIs

#### Registry API

```typescript
interface AgentRegistry {
  // Lifecycle
  load(): Promise<RegistryLoadResult>;
  reload(): Promise<RegistryLoadResult>;

  // Query
  list(): AgentSummary[];
  get(name: string): AgentRecord | null;
  getForTask(domainTags: string[], description: string): RankedAgent[];

  // State management
  freeze(name: string): void;
  unfreeze(name: string): void;
  getState(name: string): AgentState;
}

interface RegistryLoadResult {
  loaded: number;
  rejected: number;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  duration_ms: number;
}

interface RankedAgent {
  agent: AgentRecord;
  score: number;         // 0.0 - 1.0, similarity to the task domain
  matchType: "exact" | "semantic";
}
```

#### Metrics API

```typescript
interface MetricsEngine {
  // Write
  record(metric: InvocationMetric): Promise<void>;

  // Read
  getInvocations(agentName: string, options?: QueryOptions): InvocationMetric[];
  getAggregate(agentName: string): AggregateMetrics;
  getAlerts(agentName?: string): Alert[];

  // Anomaly detection
  evaluateAnomalies(agentName: string): Alert[];
}

interface QueryOptions {
  since?: string;         // ISO 8601 timestamp
  until?: string;
  domain?: string;
  environment?: string;
  limit?: number;
}
```

#### Improvement Lifecycle API

```typescript
interface ImprovementLifecycle {
  // Observation
  getObservationStatus(agentName: string): ObservationStatus;

  // Analysis
  triggerAnalysis(agentName: string): Promise<WeaknessReport>;

  // Proposal
  generateProposal(weaknessReport: WeaknessReport): Promise<AgentProposal>;

  // Meta-review
  metaReview(proposal: AgentProposal): Promise<MetaReviewResult>;

  // Validation
  runABValidation(proposal: AgentProposal): Promise<ABEvaluationResult>;

  // Promotion
  promote(agentName: string, version: string): Promise<PromotionResult>;
  reject(agentName: string, version: string, reason: string): void;
  rollback(agentName: string): Promise<RollbackResult>;
}
```

---

## 6. Error Handling

### 6.1 Error Categories

| Category | Examples | Handling |
|----------|----------|----------|
| **Load errors** | Invalid frontmatter, uncommitted file, hash mismatch | Reject individual agent, continue loading others. Log error. |
| **Runtime errors** | Agent exceeds turn limit, tool call fails, model unavailable | Retry with backoff for transient errors (model unavailable). Abort and escalate for persistent errors (turn limit exceeded). |
| **Metrics errors** | SQLite unavailable, disk full | Buffer in memory, flush on recovery. Continue agent execution. |
| **Validation errors** | A/B test fails to complete, insufficient historical inputs | Defer proposal. Log as inconclusive. Do not promote. |
| **Security errors** | Tool access violation, path access blocked, hash mismatch | Block the action immediately. Log to audit trail. Raise critical alert. Never fail open. |
| **Promotion errors** | Git commit fails, file write fails | Abort promotion. Agent remains at current version. Log error. |

### 6.2 Failure Modes

**Principle: Fail safe, not fail open.** When in doubt, the system does nothing rather than doing something potentially dangerous.

| Failure Mode | System Behavior |
|--------------|-----------------|
| Agent file modified at runtime | Detected on next load/invocation via hash check. Agent is disabled until the file is restored to committed state. |
| Metrics database corrupted | JSONL file is the source of truth. SQLite is rebuilt from JSONL on next startup. |
| Meta-reviewer agent unavailable | Proposals queue and wait. No proposal bypasses meta-review. |
| Git operations fail | Agent loading is blocked (committed-state check cannot complete). System falls back to last known good registry state from memory. |
| Reviewer agent produces inconsistent scores | Median-of-3 scoring absorbs noise. High variance is flagged as a warning in the evaluation result. |
| Proposed agent fails schema validation | Proposal is rejected. Weakness report is preserved for future analysis attempts. |

---

## 7. Security

This section consolidates security considerations that are distributed across the design. Cross-references to the detailed sections are provided.

### 7.1 Threat Model

| Threat | Vector | Mitigation | Section |
|--------|--------|------------|---------|
| **Runtime agent file tampering** | Attacker modifies an agent .md file on disk | Committed-state check + SHA-256 verification on every load | 3.8.1 |
| **Privilege escalation via prompt** | Agent's input contains instructions to use tools beyond its allowlist | Runtime tool call interception rejects unauthorized tools | 3.8.2 |
| **Agent modifies its own definition** | Agent writes to agents/ directory via Bash/Edit/Write | Path filtering blocks access to agents/ for all roles | 3.8.2 |
| **Improvement lifecycle injects backdoor** | Adversarial input trains the improvement system to add malicious instructions | Meta-reviewer gate + human approval + diff-based review | 3.4.5, 3.8.4 |
| **Tool field modified by automation** | Automated proposal adds tools to gain capabilities | Hard-coded rejection of tool field changes in proposals | 3.8.2 |
| **Eval gaming over time** | Agent modifications optimize for reviewer scores, not quality | Human-in-the-loop, rubric rotation, external validation, velocity caps | PRD 9.1 |
| **Cascading quality degradation** | Subtle quality drops compound through pipeline stages | End-to-end quality tracking, trend detection, blast radius limits | PRD 9.2 |
| **Meta-reviewer degraded** | Meta-reviewer itself becomes less effective | Frozen by default, human-authored changes only, no self-review | 3.8.4 |

### 7.2 Security Invariants

These invariants must hold at all times. Any violation is a critical security event.

1. **No agent loads from uncommitted state.** There are zero exceptions to this rule.
2. **No agent uses a tool not in its declared tools list.** Runtime enforcement, not prompt-based.
3. **No agent writes to the agents/ directory.** Path filtering at the tool call level.
4. **No automated process changes the tools field.** Hard-coded rejection.
5. **Every agent file change is a git commit.** No in-memory-only modifications.
6. **The audit log is append-only.** No truncation, editing, or deletion via the system.
7. **The meta-reviewer is frozen by default.** Automated improvement lifecycle cannot modify it.

### 7.3 Security Monitoring

The system emits security events that should be monitored by the operator:

| Event | Severity | Trigger |
|-------|----------|---------|
| `agent_load_rejected` | Critical | Uncommitted file, hash mismatch |
| `tool_call_blocked` | Critical | Agent attempted to use unauthorized tool |
| `path_access_blocked` | Critical | Agent attempted to access protected directory |
| `proposal_rejected_tool_escalation` | Critical | Proposal attempted to add tools |
| `meta_review_rejected` | Warning | Meta-reviewer found blocker issues |
| `anomaly_alert_critical` | Critical | Approval rate or escalation rate threshold breach |
| `auto_rollback_triggered` | Warning | Phase 3 auto-rollback activated |

---

## 8. Testing Strategy

### 8.1 Unit Tests

| Component | Test Focus |
|-----------|-----------|
| Frontmatter parser | Valid/invalid YAML, missing fields, type mismatches, edge cases (empty expertise list, 100 turn limit, 0.0/1.0 temperature boundaries) |
| Schema validator | Every validation rule from Section 3.1.2, tool allowlist enforcement per role, name uniqueness detection |
| Version parser | Valid/invalid semver, version bump classification (major/minor/patch), version_history consistency |
| Anomaly detector | Threshold crossing, deduplication, auto-resolve, rolling window computation |
| Metrics aggregator | Approval rate calculation, trend regression, domain segmentation, confidence intervals |
| Path filter | Block agents/ access for all roles, allow working directory access for executors, reject path traversal attempts |
| Rate limiter | Calendar-week boundary handling, per-agent tracking, configurable limits |

### 8.2 Integration Tests

| Scenario | Coverage |
|----------|----------|
| Full registry load cycle | Scan -> validate -> hash check -> register for 10+ agents |
| Agent invocation with metrics | Invoke agent -> emit metric -> verify JSONL + SQLite records |
| Committed-state enforcement | Modify agent file without commit -> verify load rejection |
| Tool access enforcement | Invoke reviewer agent -> attempt Edit tool -> verify block |
| Path access enforcement | Invoke executor agent -> attempt write to agents/ -> verify block |
| Rollback cycle | Promote v1.1.0 -> rollback -> verify v1.0.0 restored + git commit |
| Metrics graceful degradation | Delete SQLite DB -> invoke agent -> verify JSONL write + memory buffer |

### 8.3 Security Tests

| Test | Description |
|------|-------------|
| Uncommitted agent injection | Place a malicious .md file in agents/ without committing. Verify it never loads. |
| Tool escalation via prompt | Give an agent input that instructs it to use tools beyond its allowlist. Verify runtime blocks the call. |
| Path traversal via Bash | Give a code-executor input that attempts `cat agents/meta-reviewer.md`. Verify the path filter blocks it. |
| Proposal tool field change | Generate a proposal that adds `Bash` to an author agent. Verify automatic rejection. |
| Self-modification attempt | Give an agent input that asks it to write to its own definition file. Verify path filter blocks it. |
| Meta-reviewer bypass | Attempt to promote a proposal without meta-review. Verify the lifecycle rejects it. |

### 8.4 A/B Testing Validation

| Test | Description |
|------|-------------|
| Blind scoring integrity | Verify the scorer receives randomized output labels and cannot determine which is current vs. proposed. |
| Scoring consistency | Run the same A/B comparison 5 times. Verify verdict is consistent across runs (within expected variance). |
| Minimum input enforcement | Attempt A/B validation with 2 inputs. Verify the system requires at least 3. |
| Token budget enforcement | Set a low token budget. Verify A/B validation aborts when budget is exceeded. |

### 8.5 End-to-End Tests

| Test | Description |
|------|-------------|
| Full improvement lifecycle | Seed 15 invocations with known weakness -> observe analysis trigger -> verify proposal -> verify meta-review -> verify A/B validation -> promote -> verify new version active |
| Domain gap to agent creation | Submit task in unrecognized domain -> verify gap detection -> verify creation pipeline -> verify human review queue |
| Cascading quality detection | Degrade an upstream agent's output -> verify downstream quality score drops -> verify pipeline-level alert fires |

---

## 9. Trade-offs and Alternatives

### 9.1 Option A: Metrics Storage -- JSONL-only vs. SQLite-only vs. Dual-Write

| Option | Pros | Cons |
|--------|------|------|
| **A: JSONL-only** | Simplest, crash-safe, append-only, trivially portable | Complex queries require full scan; aggregation is expensive at scale |
| **B: SQLite-only** | Rich query support, indexing, aggregation built-in | Write-ahead log can corrupt on crash; single-writer lock limits concurrency |
| **C: Dual-write (chosen)** | JSONL for durability + SQLite for queries; SQLite rebuildable from JSONL | Two write paths to maintain; slight latency increase; storage overhead |

**Decision:** Option C. The durability guarantee of JSONL combined with the query power of SQLite gives us the best of both worlds. The storage overhead is negligible (metrics are small records). The complexity cost is justified by the system's need for both streaming append (real-time metrics) and complex queries (aggregation, anomaly detection, dashboards).

### 9.2 Option A: Blind Scoring -- Single Reviewer vs. Multi-Reviewer vs. Human-Only

| Option | Pros | Cons |
|--------|------|------|
| **A: Single reviewer, 1 score** | Cheapest, fastest | Non-deterministic; high variance; vulnerable to reviewer bias |
| **B: Single reviewer, median-of-3 (chosen)** | Reduces variance while keeping cost manageable | 3x token cost for scoring; still single-reviewer bias |
| **C: Multi-reviewer panel** | Multiple perspectives reduce blind spots | Expensive; consensus mechanism needed; slower |
| **D: Human-only scoring** | Most reliable | Doesn't scale; blocks improvement lifecycle on human availability |

**Decision:** Option B for automated validation, with Option D as an escape hatch (human approval is always required in Phase 1-2). Option C is viable for Phase 3 when autonomous promotion increases the importance of scoring accuracy.

### 9.3 Option A: Agent Definition Format -- YAML files vs. JSON vs. Markdown with Frontmatter

| Option | Pros | Cons |
|--------|------|------|
| **A: Pure YAML** | Machine-readable, schema-validatable, standard format | System prompt is awkward in YAML (multiline strings); not human-friendly for long prompts |
| **B: Pure JSON** | Strictest schema enforcement; easy to parse | Worst readability; no comments; system prompts are unreadable |
| **C: Markdown + YAML frontmatter (chosen)** | Config in frontmatter, prose in body; human-readable; version-control friendly | Requires frontmatter parser; body is unstructured text |

**Decision:** Option C. Agent definitions need to be human-readable (NFR-07) because humans review and approve every modification. Markdown body is natural for system prompts, which are essentially instructions in prose. YAML frontmatter provides the structured fields needed for the registry and validation.

### 9.4 Option A: Canary Execution -- Shadow Mode vs. Traffic Split vs. No Canary

| Option | Pros | Cons |
|--------|------|------|
| **A: Shadow mode (chosen)** | Zero production impact; proposed agent runs in parallel but output is discarded | 2x token cost during canary; canary is not tested with real downstream consumption |
| **B: Traffic split** | Tests with real downstream impact; more realistic signal | Production risk; partial traffic may not be representative |
| **C: No canary (Phase 1-2 only)** | Simplest; A/B validation is sufficient for human-approved promotions | No extended observation period; regression detection relies on post-promotion metrics |

**Decision:** Option C for Phase 1-2 (canary is deferred to Phase 3 per the PRD phasing). Option A for Phase 3 when autonomous promotion requires extended validation. Option B is explicitly rejected because the risk to production output quality is too high for a system where agent outputs feed into downstream agents.

---

## 10. Implementation Plan

### 10.1 Phase 1: Observation Framework (Weeks 1-4)

**Goal:** Ship the foundation agent catalog, registry, metrics collection, and dashboarding. No automated modifications.

| Week | Deliverables | PRD Requirements |
|------|-------------|-----------------|
| 1 | Agent definition schema + frontmatter parser + schema validator. Committed-state check (git status + SHA-256). Foundation agent definitions (first 6). | FR-01, FR-02, FR-03, FR-31 |
| 2 | Agent registry (load, discover, version track). Tool access enforcement (load-time + runtime). Path filtering for agents/ directory protection. | FR-04, FR-33, FR-35 |
| 3 | Per-invocation metrics recording (JSONL + SQLite dual-write). Aggregate metrics computation. Anomaly detection rules. Audit log. | FR-07, FR-08, FR-09, FR-10, FR-34 |
| 4 | CLI commands (list, inspect, metrics, dashboard). Rollback command. Freeze/unfreeze. Remaining 7 foundation agent definitions. | FR-05, FR-06, FR-11, FR-12, FR-19, FR-20, FR-27, FR-28 |

**Phase 1 exit criteria:**
- All 13 foundation agents loaded and functioning
- Metrics collected for 50+ invocations across 5+ agents
- At least 1 true positive anomaly alert confirmed
- Zero false agent loads from uncommitted state
- Rollback tested end-to-end

### 10.2 Phase 2: Human-Approved Modifications (Weeks 5-10)

**Goal:** Enable the system to propose improvements and new agents. All changes require human approval.

| Week | Deliverables | PRD Requirements |
|------|-------------|-----------------|
| 5-6 | Performance analysis (observation threshold, weakness report generation). `performance-analyst` agent. | FR-13, FR-14 |
| 7 | Proposal generation (diff-based). Meta-reviewer gate. `agent-meta-reviewer` activation. | FR-15, FR-32 |
| 8-9 | A/B validation framework (input selection, blind runner, blind scorer, comparator). Manual comparison CLI command. | FR-16 |
| 10 | Human-approved promotion workflow. Domain gap detection. Dynamic agent creation pipeline. Rate limiting. | FR-18, FR-21-FR-26, FR-24 |

**Phase 2 exit criteria:**
- 5+ modification proposals generated
- 3+ proposals approved and promoted
- Zero privilege escalation in proposed modifications
- 70%+ proposals show improvement in A/B validation
- 1+ new specialist agent proposed and validated

### 10.3 Phase 3: Autonomous with Guardrails (Weeks 11-16, Gated)

**Goal:** Limited autonomous improvement with guardrails. Requires explicit operator opt-in.

| Week | Deliverables | PRD Requirements |
|------|-------------|-----------------|
| 11-12 | Canary phase (shadow mode dual-run, canary state management, auto-termination on regression). | FR-17 |
| 13-14 | Autonomous patch-level promotion (notification, 24-hour override window, 48-hour auto-rollback). | Extension of FR-18 |
| 15-16 | Agent compatibility tracking. Pipeline-level re-validation on agent change. | FR-29, FR-30 |

**Phase 3 gate:** Phase 3 does NOT begin unless Phase 2 exit criteria are met AND the operator explicitly opts in via `autonomous-dev config set agent-factory.autonomous-promotion enabled`.

**Phase 3 exit criteria:**
- 10+ autonomous patch promotions executed
- Zero quality regressions from autonomous promotions
- Auto-rollback mechanism tested
- Operator override mechanism tested

---

## 11. Open Questions

These questions are inherited from the PRD with additional technical detail added where applicable.

| ID | Question | Technical Impact | Proposed Resolution |
|----|----------|-----------------|---------------------|
| OQ-01 | Observation threshold (10 invocations): correct? | Too low = noisy proposals from insufficient data. Too high = never triggers for infrequent agents. | Start at 10, make configurable per-agent. Collect data in Phase 1 to calibrate. |
| OQ-02 | Handling of rarely-invoked agents (<5/month)? | Improvement lifecycle never activates. Metrics are sparse and unreliable. | Add a `--force` flag to `agent analyze` for manual triggering. Add a configurable quarterly review cadence for low-usage agents. |
| OQ-03 | Is the meta-reviewer subject to improvement? | If yes: degraded meta-reviewer approves bad proposals. If no: it may become stale. | No automated improvement. Frozen by default. Human-authored quarterly reviews, informed by metrics on its finding accuracy (tracked via false positive rate when proposals are later rejected by humans). |
| OQ-04 | Blind scoring methodology details? | Affects A/B validation reliability. Multiple reviewers increase cost. | Start with single reviewer, median-of-3 (Option B from Section 9.2). Evaluate multi-reviewer in Phase 3. |
| OQ-05 | Cold-start for new specialist agents? | No historical inputs for validation. Synthetic inputs may not be representative. | Accept 3-5 synthetic inputs generated from the domain research step. Mark cold-start validations as lower confidence. Require human approval regardless. |
| OQ-06 | PR-based agent modification workflow? | Better team review, CI checks, comments. Adds process overhead. | Defer to Phase 2. The current design uses CLI-based promotion. If the operator's workflow is git-centric, the promotion command can be extended to create a branch and PR. |
| OQ-07 | Should meta-reviewer use a different model? | Same model family may have systematic blind spots on its own outputs. | Use the same model initially (claude-sonnet) for simplicity. If Phase 2 reveals systematic blind spots, evaluate using a different model or provider. Budget impact must be assessed. |
| OQ-08 | Conflicting improvement signals? | Improving completeness may hurt conciseness. Proposal may oscillate. | Weakness reports must identify a single primary focus. Proposals target one weakness at a time. If dimensions conflict, the operator decides the priority. |
| OQ-09 | Maximum agent count before consolidation? | Registry performance degrades at scale. Agent selection becomes noisy with too many similar agents. | Default max of 50 agents (configurable). Add an `agent consolidate` command in Phase 3 that identifies overlapping agents and proposes merges. |
| OQ-10 | Phase 3 autonomous promotion risk tiering? | High-risk agents (executors with Bash access) are more dangerous to auto-promote than low-risk agents (reviewers). | Allow Phase 3 autonomous promotion ONLY for agents with `risk_tier: low`. Medium requires human. High and critical always require human. |
| OQ-11 | Performance-analyst bias detection? | Analyst may systematically recommend the same type of improvement. | Track improvement categories over time. If 80%+ of proposals target the same dimension, flag for human review of the analyst's behavior. |
| OQ-12 | Domain gap queue prioritization when rate-limited? | Gaps queue up but priorities are unclear. | FIFO with manual override. Operator can reprioritize via `autonomous-dev agent gaps --reprioritize`. |
| OQ-13 (new) | How should the system handle model version changes? | A model update (e.g., claude-sonnet v1 to v2) may change agent behavior without any agent file change. | Treat model version changes as environment changes. Re-run A/B validation for all agents when the model version changes. Track model version in invocation metrics. |
| OQ-14 (new) | Should agent definitions support conditional logic? | Some agents may need different instructions for different domains. | No. Agent definitions are static. Domain-specific behavior is achieved through specialist agents, not conditional prompts. This keeps definitions simple and auditable. |

---

## Appendix A: File System Layout

```
autonomous-dev/
  agents/                          # Agent definition files (git-committed)
    prd-author.md
    tdd-author.md
    plan-author.md
    spec-author.md
    code-executor.md
    test-executor.md
    deploy-executor.md
    quality-reviewer.md
    security-reviewer.md
    architecture-reviewer.md
    doc-reviewer.md
    agent-meta-reviewer.md
    performance-analyst.md
  data/
    metrics/
      agent-invocations.jsonl      # Per-invocation metrics (append-only)
    agent-metrics.db               # SQLite queryable store
    agent-audit.log                # Append-only security audit log
    domain-gaps.jsonl              # Detected domain gaps
    proposed-agents/               # Proposed new agents awaiting approval
    evaluations/                   # A/B evaluation results
    agent-compatibility.json       # Agent version compatibility matrix (Phase 3)
  config/
    agent-factory.yaml             # Agent Factory configuration
```

## Appendix B: Configuration

```yaml
# config/agent-factory.yaml
agent-factory:
  # Observation
  observation-threshold: 10          # Invocations before improvement proposals
  observation-threshold-overrides:   # Per-agent overrides
    prd-author: 15

  # Rate limits
  creation-rate-limit: 1             # New agents per calendar week
  modification-rate-limit: 1         # Modifications per agent per calendar week
  max-agents: 50                     # Maximum agents in registry

  # Validation
  validation-token-budget: 100000    # Max tokens per A/B validation run
  validation-min-inputs: 3           # Minimum historical inputs for A/B test
  validation-max-inputs: 5           # Maximum historical inputs for A/B test
  scoring-rounds: 3                  # Scores per input (median taken)

  # Anomaly detection thresholds
  anomaly:
    approval-rate-threshold: 0.70
    quality-decline-threshold: 0.5   # Points over 10-invocation window
    escalation-rate-threshold: 0.30
    alert-resolve-count: 5           # Consecutive good invocations to auto-resolve

  # Canary (Phase 3)
  canary:
    duration-days: 7
    win-threshold: 0.60              # Proposed must win 60%+ of comparisons
    catastrophic-regression: 1.5     # Score drop threshold for immediate rejection
    min-comparisons: 3

  # Autonomous promotion (Phase 3, opt-in)
  autonomous-promotion: disabled     # "enabled" or "disabled"
  autonomous-promotion-override-hours: 24
  autonomous-promotion-auto-rollback-hours: 48
  autonomous-promotion-cooldown-days: 30  # After auto-rollback

  # Metrics retention
  metrics-retention-days: 90

  # Domain matching
  domain-similarity-threshold: 0.6
```

## Appendix C: Glossary

| Term | Definition |
|------|-----------|
| **Agent** | A configuration combining an LLM system prompt, tool access list, model preference, and evaluation rubric, stored as a `.md` file. |
| **Agent Factory** | The subsystem managing agent lifecycle: registration, metrics, improvement, creation, and security. |
| **Archetype** | One of four agent roles: author, executor, reviewer, meta. Determines tool access. |
| **A/B Validation** | Running two agent versions on the same inputs with blind scoring to compare quality. |
| **Blind scoring** | Evaluation where the reviewer does not know which output is from the current vs. proposed version. |
| **Canary period** | A time window during which both current and proposed agents run in parallel for extended comparison. |
| **Domain gap** | A mismatch between a task's domain and the expertise of all available agents. |
| **Foundation agent** | A pre-built agent shipped with the system at launch. |
| **Meta-reviewer** | The `agent-meta-reviewer` agent that audits proposed agent modifications for security concerns. |
| **Observation threshold** | Minimum invocations required before the system proposes improvements to an agent. |
| **Promotion** | Replacing the current agent version with a validated new version via git commit. |
| **Shadow mode** | Running a proposed agent in parallel with the current agent but discarding the proposed output (canary). |
