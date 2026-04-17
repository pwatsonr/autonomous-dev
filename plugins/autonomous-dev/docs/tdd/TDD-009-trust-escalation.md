# TDD-009: Escalation & Trust Framework

| Field           | Value                                                        |
|-----------------|--------------------------------------------------------------|
| **Title**       | Escalation & Trust Framework -- Technical Design             |
| **TDD ID**      | TDD-009                                                      |
| **Version**     | 1.0                                                          |
| **Date**        | 2026-04-08                                                   |
| **Status**      | Draft                                                        |
| **Author**      | Staff Engineer (autonomous-dev)                              |
| **Parent PRD**  | [PRD-007: Escalation & Trust Framework](../prd/PRD-007-escalation-trust.md) |
| **Plugin**      | autonomous-dev                                               |

---

## 1. Overview

This document specifies the technical design for the Escalation & Trust Framework described in PRD-007. The framework is the governance backbone of the autonomous-dev plugin: it controls *when* the system may act autonomously, *how* it requests human help, and *what* it records for posterity.

The design is organized around five subsystems:

1. **Trust Engine** -- Resolves, stores, and enforces trust levels (L0--L3) at pipeline gates.
2. **Escalation Engine** -- Classifies failures, formats structured escalation messages, routes them to the correct human, and handles responses.
3. **Kill Switch** -- Provides emergency halt capability with state preservation.
4. **Audit Trail Engine** -- Maintains an append-only, hash-chained event log and supports decision replay.
5. **Notification Framework** -- Delivers events to humans via multiple channels with batching, DND, and fatigue detection.

Each subsystem is designed as an independent module with well-defined interfaces, allowing phased delivery (Phase 1 through Phase 3 per PRD-007 Section 11).

---

## 2. Architecture

### 2.1 High-Level Component Diagram

```
                                    +---------------------+
                                    |   Plugin Config     |
                                    | (trust.yaml / env)  |
                                    +----------+----------+
                                               |
                                               | hot-reload
                                               v
+------------+    gate check    +==============+==============+
|  Pipeline  | --------------> ||       TRUST ENGINE          ||
|  Orchestr. | <-------------- ||  resolve / enforce / score  ||
+-----+------+    pass|pause   +==============+==============+
      |                                        |
      | on failure / ambiguity                  | trust-change events
      v                                        v
+=============+==============+     +======================+
||    ESCALATION ENGINE     ||     ||   AUDIT TRAIL       ||
||  classify / format /     || --> ||   ENGINE             ||
||  route / handle-response ||     || (events.jsonl)       ||
+=============+==============+     +======================+
      |                                        ^
      | notification payloads                  | all subsystems emit events
      v                                        |
+=============+==============+                 |
||  NOTIFICATION FRAMEWORK  || ----------------+
||  batch / DND / fatigue / ||
||  deliver                 ||
+===========================+

+=============+==============+
||       KILL SWITCH        || --- signals all subsystems via
||  /kill  /cancel  /pause  ||     AbortController / event bus
+===========================+
```

### 2.2 Escalation Flow (Sequence)

```
Pipeline Phase Agent         Escalation Engine       Routing Engine       Human          Audit Trail
      |                            |                       |                 |                |
      |-- phase fails ------------>|                       |                 |                |
      |                            |-- classify type ----->|                 |                |
      |                            |-- format message ---->|                 |                |
      |                            |                       |-- resolve target |                |
      |                            |                       |-- dispatch ----->|                |
      |                            |                       |                 |                |
      |                            |   <-- event: escalation_raised -------->| log            |
      |                            |                       |                 |                |
      |                            |      timeout?         |                 |                |
      |                            |      |-- yes -------->| chain to        |                |
      |                            |      |                | secondary ----->|                |
      |                            |                       |                 |                |
      |                            |   <----------------------- response ----|                |
      |                            |-- parse response      |                 |                |
      |                            |-- validate            |                 |                |
      |  <-- resume with guidance--|                       |                 |                |
      |                            |   <-- event: escalation_resolved ------>| log            |
      |                            |                       |                 |                |
```

### 2.3 Trust Decision Tree

```
Request arrives at a pipeline gate
    |
    +-- Resolve effective trust level
    |       |
    |       +-- request.trust_level is set? --> use it
    |       |
    |       +-- repo config has default_level? --> use it
    |       |
    |       +-- system_default_level --> use it (default: L1)
    |
    +-- Look up gate in TRUST_GATE_MATRIX[effective_level][gate]
    |       |
    |       +-- "human" --> PAUSE pipeline
    |       |       |
    |       |       +-- emit gate_approval_required notification
    |       |       +-- wait for human response (or timeout)
    |       |       +-- on approval --> log gate_approved, continue
    |       |       +-- on rejection --> log gate_rejected, handle per rejection type
    |       |
    |       +-- "system" --> agent reviews artifact
    |               |
    |               +-- pass --> log gate_approved (system), continue
    |               +-- fail, retries remaining --> retry with feedback
    |               +-- fail, retries exhausted --> raise QUALITY escalation
    |
    +-- After gate resolution, check for pending trust-level change
            |
            +-- change pending? --> apply new level, log trust_level_changed
            +-- no change --> continue to next phase
```

---

## 3. Detailed Design

### 3.1 Trust Engine

#### 3.1.1 Trust Ladder (L0--L3)

The trust ladder defines four discrete levels of autonomy. Each level is an integer (`0`--`3`) stored as part of the request context and repository configuration.

| Level | Name             | Description                                                                 |
|-------|------------------|-----------------------------------------------------------------------------|
| L0    | Full Oversight   | Human approves every gate. System is fully supervised.                      |
| L1    | Guided           | Human approves PRD and code/deployment gates. System handles middle phases. |
| L2    | PRD-Only         | Human approves PRD only. System handles all other gates including code review. |
| L3    | Autonomous       | System handles all gates. Human notified asynchronously. Security always escalates. |

#### 3.1.2 Trust Level Resolution

Trust level is resolved once per gate check (not once per request) to support mid-pipeline changes. Resolution follows a three-tier hierarchy with per-gate-check freshness:

```
EffectiveTrustLevel = resolve(request, repo, system_config)

function resolve(request, repo, system_config):
    // Layer 1: Per-request override (highest priority)
    if request.trust_level_override is not null:
        return request.trust_level_override

    // Layer 2: Per-repository default
    if system_config.trust.repositories[repo].default_level is not null:
        return system_config.trust.repositories[repo].default_level

    // Layer 3: System-wide default
    return system_config.trust.system_default_level  // default: 1
```

**Storage locations:**

| Scope       | Storage                                           | Mutability                                |
|-------------|---------------------------------------------------|-------------------------------------------|
| Per-request | `RequestContext.trust_level_override` (in-memory)  | Writable at any time via API/CLI command  |
| Per-repo    | `trust.repositories.<repo>.default_level` in config YAML | Writable via config update; hot-reloadable |
| Global      | `trust.system_default_level` in config YAML        | Writable via config update; hot-reloadable |

#### 3.1.3 Trust Level Change Mechanism (Mid-Pipeline)

A trust level change can be requested at any time during pipeline execution. The change is applied at the **next gate boundary**, never mid-phase.

**State machine implications:**

```
StateMachine for trust-level change:

    CURRENT_LEVEL --[change requested]--> CHANGE_PENDING
        |                                      |
        | (gate boundary reached)              |
        v                                      v
    CURRENT_LEVEL (no change)           NEW_LEVEL (applied)
                                              |
                                              v
                                        log trust_level_changed event
                                        notify human of effective change
```

**Rules:**

1. **Downgrade** (e.g., L2 to L0): Always allowed. Takes effect at the next gate boundary. All subsequent gates use the lower trust level.
2. **Upgrade** (e.g., L0 to L2): Allowed, but Phase 1 restricts this to prevent accidental escalation of autonomy. In Phase 1, upgrades require a confirmation step. In Phase 2+, upgrades apply immediately at the next gate boundary.
3. **Concurrent changes**: Last-write-wins. If two changes are requested before a gate boundary, only the most recent takes effect. Both changes are logged in the audit trail.
4. **In-flight phase**: A trust level change does NOT retroactively affect an in-progress phase. If a phase is mid-execution under L1, it completes under L1 rules. The new level applies to the *next* gate.

**Implementation:**

```typescript
interface TrustLevelChangeRequest {
  request_id: string;
  new_level: TrustLevel;       // 0 | 1 | 2 | 3
  reason: string;
  requested_by: string;
  requested_at: string;        // ISO 8601
}

class TrustEngine {
  private pendingChanges: Map<string, TrustLevelChangeRequest> = new Map();

  requestChange(change: TrustLevelChangeRequest): void {
    this.pendingChanges.set(change.request_id, change);
    this.auditTrail.append({
      event_type: "trust_level_change_requested",
      request_id: change.request_id,
      payload: change,
    });
  }

  resolveAtGateBoundary(requestId: string, currentLevel: TrustLevel): TrustLevel {
    const pending = this.pendingChanges.get(requestId);
    if (!pending) return currentLevel;

    this.pendingChanges.delete(requestId);
    this.auditTrail.append({
      event_type: "trust_level_changed",
      request_id: requestId,
      payload: {
        previous_level: currentLevel,
        new_level: pending.new_level,
        reason: pending.reason,
        requested_by: pending.requested_by,
      },
    });
    return pending.new_level;
  }
}
```

#### 3.1.4 Trust Level Gate Matrix

This is the authoritative gate matrix governing human vs. system authority at each pipeline gate for each trust level. The Trust Engine enforces this matrix at every gate check.

| Pipeline Gate           | L0 (Full Oversight) | L1 (Guided) | L2 (PRD-Only) | L3 (Autonomous) | Notes |
|-------------------------|---------------------|-------------|----------------|-----------------|-------|
| PRD Approval            | HUMAN               | HUMAN       | HUMAN          | SYSTEM          | At L3, system auto-approves PRDs. Human receives async notification. |
| Design Review           | HUMAN               | SYSTEM      | SYSTEM         | SYSTEM          | |
| Implementation Plan     | HUMAN               | SYSTEM      | SYSTEM         | SYSTEM          | |
| Code Review             | HUMAN               | HUMAN       | SYSTEM         | SYSTEM          | |
| Test Validation         | HUMAN               | SYSTEM      | SYSTEM         | SYSTEM          | |
| Deployment Approval     | HUMAN               | HUMAN       | SYSTEM         | SYSTEM          | |
| Security Review         | HUMAN               | HUMAN       | HUMAN          | HUMAN*          | * Always human. At L3, pipeline pauses and escalates. |

**Encoded as a constant data structure:**

```typescript
type GateAuthority = "human" | "system";

type PipelineGate =
  | "prd_approval"
  | "design_review"
  | "implementation_plan"
  | "code_review"
  | "test_validation"
  | "deployment_approval"
  | "security_review";

type TrustLevel = 0 | 1 | 2 | 3;

const TRUST_GATE_MATRIX: Record<TrustLevel, Record<PipelineGate, GateAuthority>> = {
  0: {
    prd_approval:        "human",
    design_review:       "human",
    implementation_plan: "human",
    code_review:         "human",
    test_validation:     "human",
    deployment_approval: "human",
    security_review:     "human",
  },
  1: {
    prd_approval:        "human",
    design_review:       "system",
    implementation_plan: "system",
    code_review:         "human",
    test_validation:     "system",
    deployment_approval: "human",
    security_review:     "human",
  },
  2: {
    prd_approval:        "human",
    design_review:       "system",
    implementation_plan: "system",
    code_review:         "system",
    test_validation:     "system",
    deployment_approval: "system",
    security_review:     "human",
  },
  3: {
    prd_approval:        "system",
    design_review:       "system",
    implementation_plan: "system",
    code_review:         "system",
    test_validation:     "system",
    deployment_approval: "system",
    security_review:     "human", // ALWAYS human, enforced regardless of level
  },
};
```

**Enforcement rule:** `security_review` is hardcoded to `"human"` at all levels. Even if a config override attempts to set it to `"system"`, the engine rejects the change and logs a `security_override_rejected` audit event.

#### 3.1.5 Trust Scoring and Promotion (Phase 3)

The trust scoring system computes a per-repository score based on delivery history. This is Phase 3 functionality; the data model is defined here for forward compatibility.

```typescript
interface TrustScore {
  repository: string;
  current_level: TrustLevel;
  consecutive_successes: number;
  consecutive_failures: number;
  total_deliveries: number;
  gate_pass_rate: number;          // 0.0 - 1.0
  escalation_rate: number;         // escalations / total_requests
  last_promotion: string | null;   // ISO 8601
  last_demotion: string | null;    // ISO 8601
  promotion_eligible: boolean;
  promotion_evidence: string[];    // Human-readable reasons
}
```

**Promotion threshold:** Configurable via `trust.promotion.min_consecutive_successes` (default: 20). When met, the system emits a `trust_promotion_suggested` notification. Promotion only takes effect after human approval (FR-08, non-negotiable).

**Auto-demotion:** After `trust.repositories.<repo>.auto_demotion.consecutive_failures` (default: 3) consecutive gate failures, the system automatically demotes to `demote_to` level and emits a `trust_level_demoted` event and notification.

---

### 3.2 Escalation Engine

#### 3.2.1 Escalation Taxonomy

Six escalation types, each with a defined trigger condition, default routing target, and pipeline behavior.

| Type             | Trigger                                                         | Default Target   | Pipeline Behavior        | Urgency Default |
|------------------|-----------------------------------------------------------------|------------------|--------------------------|-----------------|
| `product`        | Ambiguous requirements, conflicting PRD sections, scope unclear | PM Lead          | Pause at current gate    | `soon`          |
| `technical`      | Implementation failure after retry budget exhausted             | Tech Lead        | Pause at current phase   | `soon`          |
| `infrastructure` | CI/CD failure, dependency resolution, environment issues        | Sys Operator     | Pause immediately        | `immediate`     |
| `security`       | Security vulnerability detected in code or dependencies        | Security Lead    | **Halt immediately**     | `immediate`     |
| `cost`           | Projected cost exceeds budget threshold                         | PM Lead          | Pause before incurring   | `soon`          |
| `quality`        | Review gate failed after max retry iterations                   | Tech Lead        | Pause at failed gate     | `soon`          |

**Routing rules:**

1. `security` escalations **always** halt the pipeline regardless of trust level. This is a hardcoded invariant, not configurable.
2. `infrastructure` escalations pause immediately because the environment is unreliable for continued work.
3. `cost` escalations pause *before* the projected cost is incurred, giving the human a chance to approve or reject.
4. `product`, `technical`, and `quality` escalations pause at the current gate/phase boundary.

#### 3.2.2 Escalation Message Format

Every escalation message is a structured JSON object conforming to the following schema. This schema is versioned independently (currently `v1`) to allow delivery adapters to evolve without breaking consumers.

**JSON Schema (v1):**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://autonomous-dev.plugin/schemas/escalation-message/v1",
  "type": "object",
  "required": [
    "schema_version",
    "escalation_id",
    "type",
    "urgency",
    "request_id",
    "repository",
    "pipeline_phase",
    "timestamp",
    "summary",
    "what_was_attempted",
    "failure_reason",
    "options",
    "recommendation",
    "response_instructions",
    "routing"
  ],
  "properties": {
    "schema_version": {
      "type": "string",
      "const": "v1"
    },
    "escalation_id": {
      "type": "string",
      "pattern": "^esc-[0-9]{8}-[0-9]{3,}$",
      "description": "Globally unique escalation identifier. Format: esc-YYYYMMDD-NNN"
    },
    "type": {
      "type": "string",
      "enum": ["product", "technical", "infrastructure", "security", "cost", "quality"]
    },
    "urgency": {
      "type": "string",
      "enum": ["immediate", "soon", "informational"]
    },
    "request_id": { "type": "string" },
    "repository": { "type": "string" },
    "pipeline_phase": { "type": "string" },
    "timestamp": { "type": "string", "format": "date-time" },
    "summary": {
      "type": "string",
      "description": "Business-friendly 1-2 sentence summary. No raw stack traces."
    },
    "what_was_attempted": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 1,
      "description": "Ordered list of approaches tried before escalating."
    },
    "failure_reason": {
      "type": "string",
      "description": "Clear explanation of why the system cannot proceed."
    },
    "options": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "label", "risk", "description"],
        "properties": {
          "id": { "type": "string", "pattern": "^opt-[0-9]+$" },
          "label": { "type": "string" },
          "risk": { "type": "string", "enum": ["none", "low", "medium", "high"] },
          "description": { "type": "string" }
        }
      },
      "minItems": 2,
      "description": "At least two options: one resolution path and one cancel/abort path."
    },
    "recommendation": {
      "type": "object",
      "required": ["option_id", "rationale"],
      "properties": {
        "option_id": { "type": "string" },
        "rationale": { "type": "string" }
      }
    },
    "artifacts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["type", "label", "path"],
        "properties": {
          "type": { "type": "string", "enum": ["document", "review_feedback", "error_log", "cost_projection", "spec", "code_diff"] },
          "label": { "type": "string" },
          "path": { "type": "string" },
          "version": { "type": "string" }
        }
      },
      "default": []
    },
    "response_instructions": { "type": "string" },
    "routing": {
      "type": "object",
      "required": ["primary"],
      "properties": {
        "primary": { "type": "string" },
        "secondary": { "type": "string" },
        "timeout_minutes": { "type": "integer", "minimum": 1 }
      }
    },
    "previous_escalation_id": {
      "type": ["string", "null"],
      "description": "If this is a re-escalation, references the prior escalation."
    },
    "technical_details": {
      "type": "string",
      "description": "Optional. Raw logs, stack traces, or verbose diagnostics. Never shown as the primary message."
    }
  }
}
```

**Example: Product Escalation**

```json
{
  "schema_version": "v1",
  "escalation_id": "esc-20260408-001",
  "type": "product",
  "urgency": "soon",
  "request_id": "req-abc-123",
  "repository": "my-org/my-repo",
  "pipeline_phase": "design_review",
  "timestamp": "2026-04-08T14:32:00Z",
  "summary": "The PRD contains contradictory requirements for the notification system: Section 3.2 says notifications must be real-time, but Section 4.1 specifies batch-only delivery. The design agent cannot proceed without clarification.",
  "what_was_attempted": [
    "Attempted to reconcile by treating Section 4.1 as a fallback mode. The resulting design was internally inconsistent.",
    "Attempted to prioritize Section 3.2 (real-time). The cost estimate exceeded the budget constraint in Section 5."
  ],
  "failure_reason": "The two requirements are mutually exclusive under the stated budget constraint. Human judgment is needed to decide which takes priority.",
  "options": [
    {
      "id": "opt-1",
      "label": "Prioritize real-time (Section 3.2) and increase budget",
      "risk": "medium",
      "description": "Proceed with real-time notifications. Projected cost increases by ~30%. Requires budget approval."
    },
    {
      "id": "opt-2",
      "label": "Prioritize batch delivery (Section 4.1) and update Section 3.2",
      "risk": "low",
      "description": "Proceed with batch-only. The PRD Section 3.2 will be updated to reflect batch delivery."
    },
    {
      "id": "opt-3",
      "label": "Cancel the request",
      "risk": "none",
      "description": "Abandon this request. PRD needs rework before resubmission."
    }
  ],
  "recommendation": {
    "option_id": "opt-2",
    "rationale": "Batch delivery fits within the existing budget and aligns with the stated priority of cost control in Section 5. Real-time can be added as a future enhancement."
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
      "label": "Design agent review feedback",
      "path": ".autonomous-dev/reviews/PRD-042-design-review-1.json"
    }
  ],
  "response_instructions": "Reply with an option ID (e.g., 'opt-2') or provide free-text guidance. If choosing opt-1, confirm the budget increase is acceptable.",
  "routing": {
    "primary": "pm-lead",
    "secondary": "tech-lead",
    "timeout_minutes": 60
  },
  "previous_escalation_id": null
}
```

**Example: Security Escalation (immediate halt)**

```json
{
  "schema_version": "v1",
  "escalation_id": "esc-20260408-007",
  "type": "security",
  "urgency": "immediate",
  "request_id": "req-def-456",
  "repository": "my-org/payments-service",
  "pipeline_phase": "code_review",
  "timestamp": "2026-04-08T16:45:12Z",
  "summary": "The code review agent detected a hardcoded API secret in src/config/stripe.ts. The pipeline has been halted immediately. No code has been committed or pushed.",
  "what_was_attempted": [
    "Scanned generated code with secret detection rules. Detected a pattern matching a Stripe API key on line 42 of src/config/stripe.ts."
  ],
  "failure_reason": "Hardcoded secret detected. This is a security-critical finding that cannot be auto-resolved.",
  "options": [
    {
      "id": "opt-1",
      "label": "Remediate and retry",
      "risk": "none",
      "description": "Provide guidance on how the secret should be managed (env var, vault, etc.). System will regenerate the affected code."
    },
    {
      "id": "opt-2",
      "label": "Cancel the request",
      "risk": "none",
      "description": "Abandon this request entirely."
    }
  ],
  "recommendation": {
    "option_id": "opt-1",
    "rationale": "The secret should be moved to an environment variable. The rest of the implementation is sound."
  },
  "artifacts": [
    {
      "type": "code_diff",
      "label": "Generated code with flagged secret",
      "path": ".autonomous-dev/workspaces/req-def-456/src/config/stripe.ts"
    }
  ],
  "response_instructions": "Reply with 'opt-1' and specify the secret management approach, or 'opt-2' to cancel.",
  "routing": {
    "primary": "security-lead",
    "secondary": "pm-lead",
    "timeout_minutes": 15
  },
  "previous_escalation_id": null,
  "technical_details": "Pattern match: /sk_TESTONLY_[a-zA-Z0-9]{24}/ at src/config/stripe.ts:42. Confidence: HIGH."
}
```

**Example: Cost Escalation**

```json
{
  "schema_version": "v1",
  "escalation_id": "esc-20260408-012",
  "type": "cost",
  "urgency": "soon",
  "request_id": "req-ghi-789",
  "repository": "my-org/data-pipeline",
  "pipeline_phase": "implementation_plan",
  "timestamp": "2026-04-08T10:15:00Z",
  "summary": "The implementation plan estimates 14 parallel agent invocations for this request, projecting a cost of $47.20. The configured budget ceiling is $25.00 per request.",
  "what_was_attempted": [
    "Explored reducing parallelism to 7 agents. Projected cost: $28.50 (still over budget).",
    "Explored sequential execution with 3 agents. Projected cost: $18.00 (under budget, but estimated completion time increases from 2 hours to 11 hours)."
  ],
  "failure_reason": "All implementation plans that meet the quality bar exceed the $25.00 budget. A trade-off decision between cost and speed is needed.",
  "options": [
    {
      "id": "opt-1",
      "label": "Approve the $47.20 plan (14 parallel agents)",
      "risk": "low",
      "description": "Full parallelism. Estimated completion: 2 hours. Budget exceeded by $22.20."
    },
    {
      "id": "opt-2",
      "label": "Use the $18.00 sequential plan (3 agents)",
      "risk": "low",
      "description": "Under budget but significantly slower. Estimated completion: 11 hours."
    },
    {
      "id": "opt-3",
      "label": "Cancel the request",
      "risk": "none",
      "description": "Abandon this request."
    }
  ],
  "recommendation": {
    "option_id": "opt-2",
    "rationale": "Staying under budget is the safer default. The 11-hour timeline is acceptable for a non-urgent data pipeline change."
  },
  "artifacts": [
    {
      "type": "cost_projection",
      "label": "Cost breakdown by agent",
      "path": ".autonomous-dev/cost-estimates/req-ghi-789.json"
    }
  ],
  "response_instructions": "Reply with an option ID. If choosing opt-1, confirm the budget override.",
  "routing": {
    "primary": "pm-lead",
    "timeout_minutes": 60
  },
  "previous_escalation_id": null
}
```

#### 3.2.3 Escalation Routing Engine

The routing engine determines *who* receives an escalation and *what happens* if they do not respond.

**Two operating modes:**

| Mode       | Behavior                                                                   | Config Key                  |
|------------|----------------------------------------------------------------------------|-----------------------------|
| `default`  | All escalations route to `escalation.routing.default_target` (PM Lead)     | `escalation.routing.mode`   |
| `advanced` | Each escalation type has its own primary/secondary target and timeout      | `escalation.routing.advanced` |

**Routing resolution algorithm:**

```typescript
interface RoutingTarget {
  primary: string;
  secondary?: string;
  timeout_minutes: number;
}

function resolveRouting(
  escalationType: EscalationType,
  config: EscalationConfig
): RoutingTarget {
  if (config.routing.mode === "default") {
    return {
      primary: config.routing.default_target,
      timeout_minutes: 60, // default timeout
    };
  }

  // Advanced mode
  const typeConfig = config.routing.advanced[escalationType];
  if (!typeConfig) {
    // Fallback to default target if type not configured
    return {
      primary: config.routing.default_target,
      timeout_minutes: 60,
    };
  }

  return {
    primary: typeConfig.primary,
    secondary: typeConfig.secondary,
    timeout_minutes: typeConfig.timeout_minutes,
  };
}
```

**Escalation chains and timeouts:**

When the primary target does not respond within `timeout_minutes`, the escalation chain activates:

```
Step 1: Dispatch to primary target
    |
    +-- Response received within timeout? --> resolve escalation
    |
    +-- Timeout reached, secondary exists?
            |
            +-- Yes --> Dispatch to secondary target (new timeout = same duration)
            |       |
            |       +-- Response received? --> resolve escalation
            |       |
            |       +-- Timeout again? --> apply timeout_behavior
            |
            +-- No secondary --> apply timeout_behavior immediately
```

**Timeout behaviors** (configurable per escalation type):

| Behavior  | Description                                                        | Applicable Types         |
|-----------|--------------------------------------------------------------------|--------------------------|
| `pause`   | Pipeline remains paused indefinitely until a human responds.       | All (default)            |
| `retry`   | System retries the failed phase with a different approach.         | `technical`, `quality`   |
| `skip`    | Skip the current gate and proceed. **Only for non-blocking types.**| `informational`-urgency only |
| `cancel`  | Cancel the request after extended timeout.                         | All except `security`    |

**Constraint:** `security` escalations are hardcoded to `pause`. No timeout behavior override can change this.

#### 3.2.4 Human Response Handler

When a human responds to an escalation, the handler performs the following sequence:

```
1. PARSE the response
   |
   +-- Structured response (option ID)? --> map to predefined action
   +-- Free-text response? --> attach as guidance to the pipeline phase context
   +-- Delegate response ("delegate:tech-lead")? --> re-route escalation to new target
   |
2. VALIDATE the response
   |
   +-- Is the selected option still valid? (e.g., request not already cancelled)
   +-- Is the delegate target a known routing target?
   |
3. RECORD in audit trail
   |
   +-- event_type: "escalation_resolved"
   +-- payload: { escalation_id, response_type, response_content, responder, timestamp }
   |
4. INCORPORATE into pipeline
   |
   +-- "approve" --> mark gate as passed, resume pipeline
   +-- "retry_with_changes" --> inject guidance into phase context, re-execute phase
   +-- "cancel" --> terminate request, preserve state
   +-- "override_proceed" --> mark gate as overridden, resume (logged as human override)
   +-- "delegate" --> re-dispatch escalation to new target
   |
5. RESUME pipeline execution from the escalation point
   |
6. MONITOR outcome
   |
   +-- If the phase fails again after incorporating human guidance:
       +-- Increment re-escalation counter
       +-- Raise a RE-ESCALATION with:
           - previous_escalation_id set
           - "Your previous guidance was applied and resulted in: [outcome]"
           - Full context of what happened when the guidance was applied
```

**Response parsing interface:**

```typescript
interface EscalationResponse {
  escalation_id: string;
  responder: string;
  timestamp: string;                           // ISO 8601
  response_type: "option" | "freetext" | "delegate";
  option_id?: string;                          // if response_type === "option"
  freetext?: string;                           // if response_type === "freetext"
  delegate_target?: string;                    // if response_type === "delegate"
}

type ResolvedAction =
  | { action: "approve" }
  | { action: "retry_with_changes"; guidance: string }
  | { action: "cancel" }
  | { action: "override_proceed"; justification: string }
  | { action: "delegate"; target: string };
```

---

### 3.3 Kill Switch

#### 3.3.1 `/kill` Command

The `/kill` command is the highest-priority emergency control. It halts all active pipeline execution.

**Two modes:**

| Mode       | Behavior                                                                                 | Latency Target |
|------------|------------------------------------------------------------------------------------------|-----------------|
| `graceful` | Signal all active requests to stop. Each request finishes its current **atomic operation** (e.g., a git commit, a file write) before halting. No new phases are started. | < 5 seconds to signal; actual halt depends on atomic operation duration (typically < 30s) |
| `hard`     | Immediately interrupt all execution. Accepts potential dirty state (partial writes, uncommitted changes). | < 5 seconds |

**Implementation:**

The kill switch uses a global `AbortController` pattern. Every pipeline executor checks the abort signal before starting a new phase or gate.

```typescript
class KillSwitch {
  private globalAbort: AbortController = new AbortController();
  private requestAborts: Map<string, AbortController> = new Map();
  private halted: boolean = false;

  async kill(mode: "graceful" | "hard", issuedBy: string): Promise<KillResult> {
    this.halted = true;
    const timestamp = new Date().toISOString();

    // Snapshot current state of all active requests BEFORE signaling
    const snapshot = this.captureStateSnapshot();

    if (mode === "hard") {
      // Hard: abort immediately
      this.globalAbort.abort("KILL_HARD");
    } else {
      // Graceful: set a flag that pipeline executors check at phase boundaries
      this.globalAbort.abort("KILL_GRACEFUL");
    }

    // Log the kill event
    this.auditTrail.append({
      event_type: "kill_issued",
      timestamp,
      payload: {
        mode,
        issued_by: issuedBy,
        active_requests: snapshot,
      },
    });

    // Emit notification
    this.notificationFramework.emit({
      type: "error",
      urgency: "immediate",
      summary: `Kill switch activated (${mode} mode) by ${issuedBy}. All pipelines halted.`,
      details: snapshot,
    });

    return { halted_requests: snapshot, timestamp };
  }

  async cancel(requestId: string, issuedBy: string): Promise<void> {
    const abort = this.requestAborts.get(requestId);
    if (abort) {
      abort.abort("CANCEL_REQUEST");
    }
    // Log and notify (same pattern as kill, scoped to one request)
  }

  isHalted(): boolean {
    return this.halted;
  }

  reenable(issuedBy: string): void {
    // Requires explicit human action to re-enable after kill
    this.halted = false;
    this.globalAbort = new AbortController(); // fresh controller
    this.auditTrail.append({
      event_type: "system_reenabled",
      timestamp: new Date().toISOString(),
      payload: { issued_by: issuedBy },
    });
  }
}
```

**State preservation after kill:**

After a kill, the following state is preserved:

| State Item                      | Location                                              | Purpose                        |
|--------------------------------|-------------------------------------------------------|--------------------------------|
| Pipeline position per request  | `.autonomous-dev/state/<request-id>/pipeline.json`    | Know where to resume           |
| All generated artifacts        | `.autonomous-dev/workspaces/<request-id>/`            | Forensic analysis              |
| Pending escalations            | `.autonomous-dev/state/escalations/pending.json`      | Resume routing after re-enable |
| Event log                      | `.autonomous-dev/events.jsonl`                        | Complete history               |
| Kill snapshot                  | `.autonomous-dev/state/kill-snapshot-<timestamp>.json` | State at moment of kill        |

**Post-kill behavior:** The system remains in a `HALTED` state. All incoming requests are rejected with a `SYSTEM_HALTED` error. The system only resumes after a human explicitly calls a re-enable command. This is enforced by the `emergency.restart_requires_human` config flag, which is hardcoded to `true` and cannot be overridden.

---

### 3.4 Audit Trail Engine

#### 3.4.1 Append-Only Event Log

All significant system events are written to a single append-only log file at the configured path (default: `.autonomous-dev/events.jsonl`). The file uses JSON Lines format: one JSON object per line.

**Event schema:**

```typescript
interface AuditEvent {
  event_id: string;              // UUID v4
  event_type: AuditEventType;
  timestamp: string;             // ISO 8601 with timezone
  request_id: string | null;     // null for system-level events (kill, config change)
  repository: string | null;
  pipeline_phase: string | null;
  agent: string | null;          // agent ID if applicable
  payload: Record<string, any>;  // type-specific structured data
  hash: string;                  // SHA-256 hash for chain integrity (Phase 3)
  prev_hash: string;             // hash of the previous event (Phase 3)
}

type AuditEventType =
  | "request_started"
  | "request_completed"
  | "gate_decision"              // includes: agent, score, verdict, human_override, artifact_version
  | "escalation_raised"
  | "escalation_resolved"
  | "escalation_timeout"
  | "human_override"
  | "trust_level_change_requested"
  | "trust_level_changed"
  | "trust_level_demoted"
  | "trust_promotion_suggested"
  | "kill_issued"
  | "cancel_issued"
  | "pause_issued"
  | "resume_issued"
  | "system_reenabled"
  | "notification_sent"
  | "notification_batched"
  | "systemic_issue_detected"
  | "config_changed"
  | "autonomous_decision";       // what was decided, alternatives, confidence, rationale
```

**Write protocol:**

```
1. Serialize event to JSON (single line, no embedded newlines)
2. Compute hash-chain fields (if integrity enabled):
   a. prev_hash = hash of the last written event (or "GENESIS" for the first event)
   b. hash = SHA-256(prev_hash + JSON.stringify(event_without_hash_fields))
3. Append to events.jsonl with O_APPEND flag (atomic append on POSIX)
4. Call fsync() to ensure durability
5. Update in-memory prev_hash for the next event
```

**Concurrency:** Multiple pipeline executors may write events concurrently. The append operation uses a file-level mutex (advisory lock via `flock()`) to ensure serialization. The lock is held only for the duration of the append+fsync, keeping contention minimal.

#### 3.4.2 Hash-Chain Integrity Algorithm (Phase 3)

The hash chain provides tamper evidence for the audit trail. Any modification, deletion, or reordering of events breaks the chain and is detectable.

**Algorithm:**

```
GENESIS event (first event in the log):
    prev_hash = "GENESIS"
    canonical = JSON.stringify({
        event_id, event_type, timestamp, request_id,
        repository, pipeline_phase, agent, payload
    })  // deterministic key ordering, no hash/prev_hash fields
    hash = SHA-256(prev_hash + "|" + canonical)

Subsequent events:
    prev_hash = hash of the immediately preceding event
    canonical = JSON.stringify({ ...event fields except hash and prev_hash })
    hash = SHA-256(prev_hash + "|" + canonical)
```

**Verification algorithm:**

```
function verifyIntegrity(logPath: string): VerificationResult {
    const lines = readLines(logPath);
    let expectedPrevHash = "GENESIS";
    const errors: IntegrityError[] = [];

    for (let i = 0; i < lines.length; i++) {
        const event = JSON.parse(lines[i]);

        // Check 1: prev_hash matches expected
        if (event.prev_hash !== expectedPrevHash) {
            errors.push({
                line: i + 1,
                event_id: event.event_id,
                error: "prev_hash mismatch",
                expected: expectedPrevHash,
                actual: event.prev_hash,
            });
        }

        // Check 2: hash is correctly computed
        const canonical = JSON.stringify(
            extractCanonicalFields(event),
            Object.keys(extractCanonicalFields(event)).sort()
        );
        const computedHash = sha256(event.prev_hash + "|" + canonical);

        if (event.hash !== computedHash) {
            errors.push({
                line: i + 1,
                event_id: event.event_id,
                error: "hash mismatch (event tampered)",
                expected: computedHash,
                actual: event.hash,
            });
        }

        expectedPrevHash = event.hash;
    }

    return {
        valid: errors.length === 0,
        total_events: lines.length,
        errors,
        chain_head: expectedPrevHash,
    };
}
```

**Key properties:**

- Insertion, deletion, or modification of any event causes all subsequent `prev_hash` values to mismatch.
- Canonical serialization uses sorted keys to ensure deterministic hashing regardless of JSON key order.
- The `hash` and `prev_hash` fields are excluded from the canonical representation to avoid circular dependency.
- Phase 1 and 2 write events without hash fields (set to empty string). Phase 3 enables hash chaining via the `audit.integrity.hash_chain_enabled` config flag. A one-time migration backfills hashes for existing events.

#### 3.4.3 Decision Log

Every autonomous decision (where the system acts without human approval) is logged as an `autonomous_decision` event with the following payload structure:

```typescript
interface AutonomousDecisionPayload {
  gate: PipelineGate;
  trust_level: TrustLevel;
  decision: "approve" | "reject" | "retry";
  artifact_id: string;
  artifact_version: string;
  reviewing_agent: string;
  score: number;                  // 0.0 - 1.0, agent's confidence in the artifact
  alternatives_considered: Array<{
    description: string;
    outcome: string;              // why this alternative was not chosen
  }>;
  confidence: number;             // 0.0 - 1.0, agent's confidence in the decision itself
  rationale: string;              // human-readable explanation of the decision
}
```

**Decision replay** (FR-45): Given a request ID, the system filters `events.jsonl` for all events with that `request_id`, sorts by timestamp, and produces a chronological narrative. This is implemented as a streaming filter over the log file (no secondary index in Phase 1; an in-memory index is built on demand in Phase 2).

---

### 3.5 Notification Framework

#### 3.5.1 Event Types and Delivery

Seven notification event types, each independently configurable for delivery method and channel:

| Event Type          | Default Urgency   | Default Delivery | Batchable | Description                                   |
|---------------------|-------------------|------------------|-----------|-----------------------------------------------|
| `phase_transition`  | `informational`   | CLI              | Yes       | Pipeline moved to a new phase                 |
| `gate_approved`     | `informational`   | CLI              | Yes       | A gate was approved (human or system)         |
| `gate_rejected`     | `soon`            | CLI              | No        | A gate was rejected                           |
| `escalation`        | Varies by type    | Slack            | No        | Escalation raised (always immediate delivery) |
| `error`             | `immediate`       | Slack            | No        | System error or unexpected failure            |
| `completion`        | `informational`   | Discord          | Yes       | Request completed successfully                |
| `daily_digest`      | `informational`   | Slack            | N/A       | Aggregated daily summary                      |

**Four delivery methods:**

| Method       | Payload Format            | Implementation                                         |
|-------------|--------------------------|--------------------------------------------------------|
| `cli`        | Formatted text to stdout | Direct console output. Always available.               |
| `discord`    | Discord embed JSON        | Structured embed with fields, color-coded by urgency.  |
| `slack`      | Slack Block Kit JSON      | Section blocks with mrkdwn formatting.                 |
| `file_drop`  | Raw JSON file             | Written to configured directory. For integration/archival. |

**Delivery adapter interface:**

```typescript
interface NotificationPayload {
  notification_id: string;
  event_type: NotificationEventType;
  urgency: "immediate" | "soon" | "informational";
  timestamp: string;
  request_id: string | null;
  repository: string | null;
  summary: string;
  details: Record<string, any>;
}

interface DeliveryAdapter {
  readonly method: "cli" | "discord" | "slack" | "file_drop";
  deliver(payload: NotificationPayload): Promise<DeliveryResult>;
  deliverBatch(payloads: NotificationPayload[]): Promise<DeliveryResult>;
}

interface DeliveryResult {
  success: boolean;
  method: string;
  error?: string;
}
```

**Fallback chain:** If the configured delivery method fails, the system falls back through: configured method -> `cli` -> `file_drop`. If all methods fail, the pipeline pauses (per NFR-10) rather than proceeding without notification.

#### 3.5.2 Notification Batching

Non-urgent notifications are batched into periodic digests to reduce noise.

**Batching rules:**

1. Notifications with `urgency: "immediate"` are **never** batched. They are delivered instantly.
2. Notification types listed in `notifications.batching.exempt_types` (default: `["escalation", "error"]`) are never batched.
3. All other notifications accumulate in a batch buffer.
4. The buffer is flushed at the configured interval (default: 60 minutes) or when the buffer reaches a configurable maximum size (default: 50 notifications).
5. The flushed batch is delivered as a single consolidated message, grouped by request ID and event type.

```typescript
class NotificationBatcher {
  private buffer: NotificationPayload[] = [];
  private flushTimer: NodeJS.Timer;

  constructor(private config: BatchingConfig, private adapter: DeliveryAdapter) {
    this.flushTimer = setInterval(() => this.flush(), config.interval_minutes * 60_000);
  }

  enqueue(payload: NotificationPayload): void {
    if (this.isExempt(payload)) {
      // Deliver immediately, bypass buffer
      this.adapter.deliver(payload);
      return;
    }
    this.buffer.push(payload);
    if (this.buffer.length >= this.config.max_buffer_size) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    const batch = [...this.buffer];
    this.buffer = [];
    this.adapter.deliverBatch(batch);
  }

  private isExempt(payload: NotificationPayload): boolean {
    return (
      payload.urgency === "immediate" ||
      this.config.exempt_types.includes(payload.event_type)
    );
  }
}
```

#### 3.5.3 Do Not Disturb (DND)

During DND hours, only `immediate`-urgency notifications break through. All others are queued and delivered as a batch when DND ends.

**DND logic:**

```
function shouldDeliver(payload, dndConfig, now):
    if not dndConfig.enabled:
        return true

    if isWithinDndWindow(now, dndConfig):
        // During DND hours
        if payload.urgency === "immediate":
            return true   // P0 breaks through
        else:
            enqueueForPostDnd(payload)
            return false
    else:
        return true
```

The DND window is evaluated in the configured timezone (`notifications.dnd.timezone`). The window supports overnight spans (e.g., 22:00 to 07:00).

#### 3.5.4 Notification Fatigue Detection and Mitigation

The system monitors notification volume per recipient and automatically switches to digest mode when fatigue thresholds are exceeded.

**Detection:**

```typescript
class FatigueDetector {
  private windowCounts: Map<string, { count: number; windowStart: number }> = new Map();

  recordNotification(recipient: string): boolean /* isFatigued */ {
    const now = Date.now();
    const entry = this.windowCounts.get(recipient);

    if (!entry || now - entry.windowStart > 3_600_000) {
      // New 1-hour window
      this.windowCounts.set(recipient, { count: 1, windowStart: now });
      return false;
    }

    entry.count++;
    if (entry.count >= this.config.threshold_per_hour) {
      return true; // Fatigue detected
    }
    return false;
  }
}
```

**Mitigation:** When fatigue is detected for a recipient:

1. A **meta-notification** is sent: "High notification volume detected. Switching to digest mode. Next digest in {cooldown_minutes} minutes."
2. All subsequent non-immediate notifications for that recipient are buffered for `fatigue.digest_cooldown_minutes` (default: 30).
3. After the cooldown, the buffer is flushed as a single digest.
4. Normal notification delivery resumes. If the fatigue threshold is hit again, the cycle repeats.

#### 3.5.5 Cross-Request Systemic Failure Alerts

The system correlates failures across requests to detect systemic issues (e.g., a shared dependency is broken, CI is down).

**Detection algorithm:**

```typescript
interface FailureRecord {
  request_id: string;
  repository: string;
  pipeline_phase: string;
  failure_type: string;
  timestamp: number;
}

class SystemicFailureDetector {
  private recentFailures: FailureRecord[] = [];

  recordFailure(failure: FailureRecord): SystemicAlert | null {
    const now = Date.now();
    const windowMs = this.config.failure_window_minutes * 60_000;

    // Prune old failures outside the window
    this.recentFailures = this.recentFailures.filter(
      f => now - f.timestamp <= windowMs
    );

    this.recentFailures.push(failure);

    // Check for systemic patterns
    // Pattern 1: N failures in the same repository
    const repoFailures = this.recentFailures.filter(
      f => f.repository === failure.repository
    );
    if (repoFailures.length >= this.config.failure_threshold) {
      return this.createSystemicAlert("repository", failure.repository, repoFailures);
    }

    // Pattern 2: N failures in the same pipeline phase across repos
    const phaseFailures = this.recentFailures.filter(
      f => f.pipeline_phase === failure.pipeline_phase
    );
    if (phaseFailures.length >= this.config.failure_threshold) {
      return this.createSystemicAlert("phase", failure.pipeline_phase, phaseFailures);
    }

    // Pattern 3: N failures of the same type across repos
    const typeFailures = this.recentFailures.filter(
      f => f.failure_type === failure.failure_type
    );
    if (typeFailures.length >= this.config.failure_threshold) {
      return this.createSystemicAlert("failure_type", failure.failure_type, typeFailures);
    }

    return null;
  }

  private createSystemicAlert(
    pattern: string,
    value: string,
    failures: FailureRecord[]
  ): SystemicAlert {
    return {
      alert_type: "systemic_issue",
      pattern,
      value,
      failure_count: failures.length,
      affected_requests: [...new Set(failures.map(f => f.request_id))],
      affected_repositories: [...new Set(failures.map(f => f.repository))],
      window_minutes: this.config.failure_window_minutes,
      summary: `Systemic issue detected: ${failures.length} failures matching pattern '${pattern}=${value}' across ${new Set(failures.map(f => f.request_id)).size} requests in the last ${this.config.failure_window_minutes} minutes.`,
    };
  }
}
```

When a systemic alert fires:

1. Individual pending escalation notifications for the affected requests are **suppressed**.
2. A single `systemic_issue` notification is emitted with `urgency: "immediate"`.
3. The systemic alert is logged in the audit trail as a `systemic_issue_detected` event.

---

## 4. Data Models

### 4.1 Trust Configuration

```yaml
# Stored in the plugin's config file, hot-reloadable
trust:
  system_default_level: 1             # 0-3, default for new repos
  repositories:
    "my-org/my-repo":
      default_level: 2
      auto_demotion:
        enabled: true
        consecutive_failures: 3
        demote_to: 1
  promotion:
    enabled: true
    min_consecutive_successes: 20
    require_human_approval: true      # Immutable: always true
```

### 4.2 Escalation Configuration

```yaml
escalation:
  routing:
    mode: "default"                   # "default" | "advanced"
    default_target: "pm-lead"
    advanced:
      product:        { primary: "pm-lead",        secondary: "tech-lead",    timeout_minutes: 60  }
      technical:      { primary: "tech-lead",      secondary: "pm-lead",      timeout_minutes: 120 }
      infrastructure: { primary: "sys-operator",   secondary: "tech-lead",    timeout_minutes: 30  }
      security:       { primary: "security-lead",  secondary: "pm-lead",      timeout_minutes: 15  }
      cost:           { primary: "pm-lead",                                   timeout_minutes: 60  }
      quality:        { primary: "tech-lead",      secondary: "pm-lead",      timeout_minutes: 120 }
  timeout_behavior:
    default: "pause"                  # "pause" | "retry" | "skip" | "cancel"
    overrides:
      infrastructure: "pause"
      security: "pause"              # Immutable: security always pauses
      quality: "retry"
  retry_limits:
    quality_gate_max_iterations: 3
    technical_max_approaches: 3
  verbosity:
    default: "standard"              # "terse" | "standard" | "verbose"
    overrides: {}                    # per-repo or per-team overrides
```

### 4.3 Notification Configuration

```yaml
notifications:
  delivery:
    default_method: "cli"            # "cli" | "discord" | "slack" | "file_drop"
    overrides:
      escalation: "slack"
      completion: "discord"
      daily_digest: "slack"
  batching:
    enabled: true
    interval_minutes: 60
    max_buffer_size: 50
    exempt_types: ["escalation", "error"]
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
```

### 4.4 Audit Configuration

```yaml
audit:
  retention:
    active_days: 90
    archive_enabled: true
    archive_path: ".autonomous-dev/archive/"
  integrity:
    hash_chain_enabled: false        # Enabled in Phase 3
    hash_algorithm: "sha256"
  log_path: ".autonomous-dev/events.jsonl"

emergency:
  kill_default_mode: "graceful"      # "graceful" | "hard"
  restart_requires_human: true       # Immutable: always true
```

### 4.5 Audit Event Examples

**Gate decision event:**

```json
{
  "event_id": "evt-550e8400-e29b-41d4-a716-446655440000",
  "event_type": "gate_decision",
  "timestamp": "2026-04-08T14:30:00Z",
  "request_id": "req-abc-123",
  "repository": "my-org/my-repo",
  "pipeline_phase": "design_review",
  "agent": "design-reviewer-v2",
  "payload": {
    "gate": "design_review",
    "trust_level": 1,
    "authority": "system",
    "verdict": "pass",
    "score": 0.87,
    "artifact_id": "TDD-042",
    "artifact_version": "v1",
    "human_override": null,
    "rationale": "Design document meets all structural requirements. Architecture section is thorough. No security concerns identified."
  },
  "hash": "",
  "prev_hash": ""
}
```

**Autonomous decision event:**

```json
{
  "event_id": "evt-660e8400-e29b-41d4-a716-446655440001",
  "event_type": "autonomous_decision",
  "timestamp": "2026-04-08T14:35:00Z",
  "request_id": "req-abc-123",
  "repository": "my-org/my-repo",
  "pipeline_phase": "implementation_plan",
  "agent": "implementation-planner-v1",
  "payload": {
    "gate": "implementation_plan",
    "trust_level": 2,
    "decision": "approve",
    "artifact_id": "impl-plan-042",
    "artifact_version": "v1",
    "reviewing_agent": "implementation-planner-v1",
    "score": 0.92,
    "alternatives_considered": [
      {
        "description": "Monolithic implementation in a single PR",
        "outcome": "Rejected: estimated PR size exceeds review threshold (>500 lines). Risk of merge conflicts."
      },
      {
        "description": "Microservice decomposition with 4 independent services",
        "outcome": "Rejected: over-engineering for the scope. Adds infrastructure complexity without proportional benefit."
      }
    ],
    "confidence": 0.88,
    "rationale": "Selected a 3-phase incremental approach: (1) core data model, (2) API endpoints, (3) UI integration. Each phase produces a reviewable, deployable unit. Aligns with the repository's existing PR size norms."
  },
  "hash": "",
  "prev_hash": ""
}
```

---

## 5. Trust Level Gate Matrix (Complete Reference)

This table is the single source of truth for gate enforcement. It extends the PRD matrix with explicit action descriptions.

| Pipeline Gate        | L0: Full Oversight          | L1: Guided                   | L2: PRD-Only                  | L3: Autonomous                | Override Behavior |
|----------------------|-----------------------------|------------------------------|-------------------------------|-------------------------------|-------------------|
| PRD Approval         | PAUSE. Human reviews PRD.   | PAUSE. Human reviews PRD.    | PAUSE. Human reviews PRD.     | SYSTEM auto-approves. Human notified async. | Human can reject at any level. |
| Design Review        | PAUSE. Human reviews TDD.   | SYSTEM agent reviews TDD.    | SYSTEM agent reviews TDD.     | SYSTEM agent reviews TDD.     | System failure -> quality escalation. |
| Implementation Plan  | PAUSE. Human reviews plan.  | SYSTEM agent reviews plan.   | SYSTEM agent reviews plan.    | SYSTEM agent reviews plan.    | System failure -> quality escalation. |
| Code Review          | PAUSE. Human reviews code.  | PAUSE. Human reviews code.   | SYSTEM agent reviews code.    | SYSTEM agent reviews code.    | System failure -> quality escalation. |
| Test Validation      | PAUSE. Human reviews tests. | SYSTEM runs and validates.   | SYSTEM runs and validates.    | SYSTEM runs and validates.    | Test failure -> technical escalation. |
| Deployment Approval  | PAUSE. Human approves deploy.| PAUSE. Human approves deploy.| SYSTEM auto-approves deploy.  | SYSTEM auto-approves deploy.  | Deploy failure -> infrastructure escalation. |
| Security Review      | PAUSE. Human reviews.       | PAUSE. Human reviews.        | PAUSE. Human reviews.         | PAUSE. Human reviews.         | **Always human. Non-negotiable.** |

**Gate check pseudocode:**

```
function checkGate(gate, request):
    effectiveLevel = trustEngine.resolve(request)
    authority = TRUST_GATE_MATRIX[effectiveLevel][gate]

    if authority === "human":
        pipeline.pause()
        notification.emit(gate_approval_required, { gate, request, effectiveLevel })
        response = await waitForHumanResponse(request, gate)
        auditTrail.log(gate_decision, { authority: "human", response })
        return response.verdict

    else: // authority === "system"
        result = await agentReview(gate, request)
        auditTrail.log(gate_decision, { authority: "system", result })

        if result.verdict === "pass":
            return "pass"
        else if result.retries_remaining > 0:
            return retry(gate, request, result.feedback)
        else:
            escalationEngine.raise("quality", request, gate, result)
            return "escalated"
```

---

## 6. Error Handling

| Scenario                                  | Behavior                                                                 |
|-------------------------------------------|--------------------------------------------------------------------------|
| Config file invalid/missing               | Fall back to hardcoded defaults (L1 trust, default routing, CLI delivery). Log `config_changed` event with error details. |
| Notification delivery fails               | Fallback chain: configured method -> CLI -> file_drop. If all fail, pipeline pauses. |
| Event log write fails                     | Retry with exponential backoff (3 attempts). If persistent, pipeline pauses and raises `infrastructure` escalation. Events buffered in memory during retry. |
| Hash chain broken (integrity check fails) | Log a `hash_chain_integrity_failure` event (to a separate integrity log). Emit `immediate` notification. Do NOT halt pipeline -- the hash chain is an audit feature, not a control feature. |
| Human response references invalid option  | Return validation error to human with available options. Do not resume pipeline. |
| Escalation routing target unknown         | Fall back to `escalation.routing.default_target`. Log a warning event. |
| Kill switch called during kill            | Idempotent. Second call is a no-op. Logged but does not change state. |
| Trust level set to invalid value          | Reject with validation error. Valid range: 0-3 integer. Log attempt. |
| Concurrent trust level changes            | Last-write-wins at the gate boundary. Both changes logged. |
| Escalation raised during DND for `immediate` urgency | Breaks through DND. Delivered immediately. |
| Re-escalation loop (>3 re-escalations for same issue) | Escalate to secondary target with meta-context: "This issue has been escalated {N} times without resolution." Suggest cancellation as an option. |

---

## 7. Security

### 7.1 Audit Trail Integrity

- **Append-only invariant:** The event log file is opened with `O_APPEND` and never truncated during the active retention period. The application code has no `truncate` or `overwrite` path for the active log.
- **Hash chain (Phase 3):** SHA-256 hash chain as described in Section 3.4.2. Provides tamper evidence. The chain can be verified independently by any party with read access to the log file.
- **Retention enforcement:** Events older than `audit.retention.active_days` are moved to `archive_path`, not deleted. The archive preserves hash chain continuity by recording the chain-head hash at the time of archival.

### 7.2 Authorization for Trust Changes

- **Trust level changes** are logged with the identity of the requestor (`requested_by` field). The system does not authenticate users (authentication is the platform layer's responsibility), but it records the claimed identity for audit purposes.
- **Trust promotion** requires explicit human approval. The `trust.promotion.require_human_approval` flag is hardcoded to `true` and cannot be overridden via configuration.
- **Security review override** is impossible. The `security_review` gate is hardcoded to `"human"` at all trust levels. Attempted overrides are logged as `security_override_rejected` events.
- **Kill switch re-enable** requires explicit human action. The `emergency.restart_requires_human` flag is hardcoded to `true`.

### 7.3 Sensitive Data in Escalations

- Escalation messages never include raw secrets, tokens, or credentials in the `summary`, `failure_reason`, or `options` fields.
- If a security escalation involves a detected secret (e.g., hardcoded API key), the `technical_details` field references the file path and line number but does NOT reproduce the secret value.
- Escalation messages sent via external delivery methods (Slack, Discord) are sanitized to remove file system paths. Only relative paths within the workspace are included.

---

## 8. Testing Strategy

### 8.1 Unit Tests

| Component                | Test Focus                                                                         |
|--------------------------|------------------------------------------------------------------------------------|
| Trust Engine             | Resolution hierarchy (per-request > per-repo > global). Gate matrix enforcement. Mid-pipeline change at gate boundary. |
| Escalation Classifier    | Each of the 6 types correctly classified from failure context. Edge cases: ambiguous failures that could be multiple types. |
| Escalation Formatter     | Message schema validation. Verbosity modes (terse/standard/verbose). Artifact attachment. |
| Routing Engine           | Default mode. Advanced mode per-type routing. Fallback when type not configured. |
| Kill Switch              | Graceful vs. hard mode. State snapshot correctness. Idempotent double-kill. Re-enable flow. |
| Audit Event Writer       | Append-only semantics. Correct field population. Hash chain computation. |
| Hash Chain Verifier      | Valid chain passes. Tampered event detected. Deleted event detected. Reordered events detected. |
| Notification Batcher     | Exempt types bypass buffer. Buffer flushed at interval. Buffer flushed at max size. |
| DND Filter               | Notifications suppressed during window. Immediate urgency breaks through. Post-DND flush. |
| Fatigue Detector         | Threshold triggers digest mode. Cooldown resets. Window expiration. |
| Systemic Failure Detector| Per-repo pattern. Per-phase pattern. Per-type pattern. Window expiration prunes old records. |

### 8.2 Integration Tests

| Scenario                                                  | Validates                                                    |
|-----------------------------------------------------------|--------------------------------------------------------------|
| Full pipeline at L0: every gate pauses for human          | Gate matrix enforcement end-to-end                           |
| Full pipeline at L1: PRD and code gates pause, others auto| Selective gate enforcement                                   |
| Full pipeline at L3: no pauses except security            | Autonomous mode with security invariant                      |
| Mid-pipeline downgrade from L2 to L0                      | Trust change applied at next gate, not retroactively         |
| Quality escalation after 3 retries                        | Retry budget enforcement, escalation message format          |
| Escalation -> human responds -> pipeline resumes          | End-to-end escalation lifecycle                              |
| Re-escalation when human guidance fails                   | Re-escalation with linked context                            |
| Escalation chain timeout -> secondary target              | Timeout and chain routing                                    |
| `/kill graceful` during active phase                      | Graceful halt at atomic boundary, state preserved            |
| `/kill hard` during active phase                          | Immediate halt, state preserved                              |
| 20 consecutive successes -> promotion suggestion          | Trust scoring, notification, human-only promotion            |
| 3 consecutive failures -> auto-demotion                   | Auto-demotion, notification                                  |
| Notification fatigue -> digest mode switch                | Fatigue detection, meta-notification, cooldown               |
| 3 failures in same repo within window -> systemic alert   | Cross-request correlation, individual suppression            |
| Event log hash chain verification                         | Integrity check passes on clean log, fails on tampered log   |

### 8.3 Kill Switch Drill

Per PRD-007 Risk R6, the kill switch is tested quarterly with a **kill switch drill**:

1. Start 3+ synthetic requests across 2+ repositories.
2. Issue `/kill graceful`. Verify all halt within 5 seconds (signaling) and 30 seconds (completion).
3. Verify state preservation for all requests.
4. Re-enable and verify system accepts new requests.
5. Repeat with `/kill hard`.
6. Record drill results in the audit trail.

---

## 9. Trade-offs & Alternatives

### 9.1 Single Log File vs. Structured Database for Audit Trail

**Chosen:** Single `events.jsonl` file with append-only semantics.

**Alternative:** SQLite database or PostgreSQL for structured querying.

**Rationale:** The plugin operates within a single-machine, single-user (or small team) context. A JSONL file is:
- Simpler to implement and debug (human-readable, `grep`-able).
- Trivially append-only (no ORM, no migration, no connection pool).
- Portable (a single file that can be copied, backed up, or shared).
- Sufficient throughput for the 100 events/second NFR (append + fsync on modern SSDs handles this comfortably).

The trade-off is slower decision replay for large logs. This is acceptable in Phase 1 (streaming filter). Phase 2 adds an in-memory index. If the log exceeds ~1M events and query latency becomes problematic, a migration to SQLite is a well-understood upgrade path.

### 9.2 Trust Level as Integer vs. Named Policy

**Chosen:** Integer levels (0-3) with a fixed gate matrix.

**Alternative:** Named policies (e.g., "oversight", "guided", "autonomous") with per-policy customizable gate matrices.

**Rationale:** The PRD defines exactly four levels with a specific gate matrix. Named policies add flexibility but also complexity: users would need to understand and configure their own gate matrices, increasing the chance of misconfiguration. The fixed matrix provides a clear, auditable contract. If custom policies are needed in the future, the gate matrix constant can be replaced with a config-driven lookup without changing the enforcement engine.

### 9.3 Escalation Routing: Inline vs. External Workflow Engine

**Chosen:** Inline routing engine with timeout chains built into the escalation engine.

**Alternative:** Delegate routing to an external workflow engine (e.g., Temporal, Step Functions).

**Rationale:** The routing logic is simple (primary -> timeout -> secondary -> timeout behavior). An external workflow engine adds deployment complexity, a new dependency, and operational overhead disproportionate to the routing complexity. The inline implementation is testable, debuggable, and self-contained. If routing grows to support multi-level chains (>2 targets), round-robin, or load-balanced routing, an external engine becomes justified.

### 9.4 Hash Chain vs. HMAC for Audit Integrity

**Chosen:** Hash chain (SHA-256, each event hashes the previous event's hash).

**Alternative:** HMAC with a server-side secret key.

**Rationale:** Hash chain provides tamper evidence without requiring secret key management. Anyone with read access to the log can verify integrity. HMAC provides stronger guarantees (it proves the log was written by a specific key holder), but requires secure key storage, rotation, and access control -- infrastructure that is out of scope for a single-machine plugin. Hash chain is the right trade-off for Phase 3; HMAC can be layered on top later if the plugin moves to a multi-tenant hosted model.

### 9.5 Notification Delivery: Plugin-Native vs. Platform-Delegated

**Chosen:** Plugin produces structured payloads; delivery adapters handle method-specific formatting and transport.

**Alternative:** Plugin directly integrates with Slack API, Discord API, etc.

**Rationale:** Per PRD-007 NG-4, the plugin does not build notification delivery infrastructure. The adapter interface allows the platform layer (or third-party integrations) to implement delivery without coupling the plugin to specific APIs. This also makes testing straightforward: unit tests use a mock adapter.

---

## 10. Implementation Plan

### Phase 1: Foundation (L0/L1 with Basic Escalation)

| Task | Description | Dependencies | Estimate |
|------|-------------|--------------|----------|
| 1.1  | Implement `TrustEngine` with resolution hierarchy (per-request, per-repo, global) | Config loader | 2 days |
| 1.2  | Implement `TRUST_GATE_MATRIX` constant and gate check logic | 1.1 | 1 day |
| 1.3  | Implement trust level change (downgrade only) with gate-boundary application | 1.1, 1.2 | 1 day |
| 1.4  | Implement escalation taxonomy classifier (6 types) | None | 1 day |
| 1.5  | Implement escalation message formatter (standard verbosity) | 1.4 | 2 days |
| 1.6  | Implement default routing (all to PM Lead) | 1.4, 1.5 | 1 day |
| 1.7  | Implement human response handler (parse, validate, incorporate, resume) | 1.6 | 2 days |
| 1.8  | Implement structured response options for common scenarios | 1.7 | 1 day |
| 1.9  | Implement `/kill` (graceful mode) and `/cancel {request-id}` | KillSwitch class | 2 days |
| 1.10 | Implement state preservation after kill (snapshot + persist) | 1.9 | 1 day |
| 1.11 | Implement `AuditTrailEngine` with append-only `events.jsonl` | None | 2 days |
| 1.12 | Implement `gate_decision` and `escalation_raised/resolved` event logging | 1.11, 1.2, 1.7 | 1 day |
| 1.13 | Implement CLI and file_drop delivery adapters | Notification interface | 1 day |
| 1.14 | Implement basic daily digest (completion summary) | 1.13 | 1 day |
| 1.15 | Integration tests: L0 and L1 full pipeline, escalation lifecycle, kill switch | All above | 3 days |

**Phase 1 Total: ~22 days**

### Phase 2: Advanced Autonomy (L2/L3 with Full Routing)

| Task | Description | Dependencies | Estimate |
|------|-------------|--------------|----------|
| 2.1  | Enable L2 and L3 trust levels in gate matrix enforcement | Phase 1 | 1 day |
| 2.2  | Implement advanced routing (per-type targets) | 1.6 | 2 days |
| 2.3  | Implement escalation chains with timeout and secondary routing | 2.2 | 2 days |
| 2.4  | Implement all 4 timeout behaviors (pause, retry, skip, cancel) | 2.3 | 2 days |
| 2.5  | Implement mid-pipeline trust level upgrade | 1.3 | 1 day |
| 2.6  | Implement Discord embed and Slack Block Kit delivery adapters | 1.13 | 3 days |
| 2.7  | Implement notification batching | 1.13 | 2 days |
| 2.8  | Implement DND hours | 2.7 | 1 day |
| 2.9  | Implement notification fatigue detection and mitigation | 2.7 | 2 days |
| 2.10 | Implement cross-request systemic failure detection | 1.11 | 2 days |
| 2.11 | Implement `/kill hard` mode | 1.9 | 1 day |
| 2.12 | Implement `/pause` and `/resume` commands | 1.9 | 2 days |
| 2.13 | Implement decision replay (streaming filter + in-memory index) | 1.11 | 2 days |
| 2.14 | Implement configurable escalation verbosity (terse/standard/verbose) | 1.5 | 1 day |
| 2.15 | Implement re-escalation with linked context | 1.7 | 2 days |
| 2.16 | Integration tests: L2/L3, routing chains, DND, fatigue, systemic alerts, replay | All above | 4 days |

**Phase 2 Total: ~30 days**

### Phase 3: Trust Intelligence

| Task | Description | Dependencies | Estimate |
|------|-------------|--------------|----------|
| 3.1  | Implement per-repository trust scoring engine | Phase 2 | 3 days |
| 3.2  | Implement trust promotion suggestion with evidence | 3.1 | 2 days |
| 3.3  | Implement automatic trust demotion on consecutive failures | 3.1 | 1 day |
| 3.4  | Implement hash-chain integrity for audit trail | 1.11 | 2 days |
| 3.5  | Implement hash-chain verification CLI command | 3.4 | 1 day |
| 3.6  | Implement event log archival (active to cold storage) | 1.11 | 2 days |
| 3.7  | Implement office-hours routing | 2.2 | 2 days |
| 3.8  | Implement delegate response ("route to someone else") | 1.7 | 1 day |
| 3.9  | Backfill hash chain for existing events (migration) | 3.4 | 1 day |
| 3.10 | Integration tests: promotion/demotion, hash verification, archival, delegation | All above | 3 days |

**Phase 3 Total: ~18 days**

---

## 11. Open Questions

| #   | Question | Context / Impact | Owner | Status |
|-----|----------|------------------|-------|--------|
| OQ-1 | Should the trust promotion threshold be configurable per repository (not just globally)? | PRD Q1. High-velocity repos may reach 20 successes in days; critical infra repos may take months. A per-repo threshold avoids one-size-fits-all problems. Recommend: yes, with global default as fallback. | PM Lead | Open |
| OQ-2 | How do we handle conflicting guidance from multiple humans on the same escalation? | PRD Q2. In advanced routing mode, an escalation could reach both PM Lead and Tech Lead. If they disagree, the system needs a tiebreaker. Propose: first response wins, but the second respondent is notified and can override within a grace period. | PM Lead | Open |
| OQ-3 | Should the kill switch require confirmation (e.g., `/kill --confirm`) to prevent accidental invocation? | PRD Q5. Speed vs. safety trade-off. Propose: no confirmation for `/kill graceful` (it is safe), require `--confirm` flag for `/kill hard` (it accepts dirty state). | PM Lead | Open |
| OQ-4 | What is the archive retention period? | PRD Q4. Active retention is 90 days. Archive retention is undefined. Recommend: 1 year default, configurable. Compliance-driven orgs can set to indefinite. | PM Lead | Open |
| OQ-5 | How should the system handle meta-escalations (the escalation system itself is broken)? | PRD Q9. If the routing engine fails, notifications fail, or the audit trail is unwritable, the system has no channel to communicate the failure. Propose: a hardcoded fallback path that writes to stderr + a `.autonomous-dev/EMERGENCY.log` file, and pauses all pipelines. | Staff Eng | Open |
| OQ-6 | Should the hash chain use a separate signing key (HMAC) in addition to SHA-256 chaining? | HMAC provides stronger guarantees (proves authorship) but requires key management. For a single-machine plugin, SHA-256 chaining is sufficient. Revisit if the plugin moves to a hosted multi-tenant model. | Staff Eng | Open |
| OQ-7 | For L3 autonomous mode, should there be a hard cost ceiling that triggers escalation regardless of trust level? | PRD Q7. Without this, an L3 request on a large repo could incur unbounded cost. Propose: yes, add a `trust.l3_cost_ceiling` config (default: $100) that triggers a cost escalation even at L3. | PM Lead | Open |
| OQ-8 | How should we handle trust levels for monorepos with multiple services? | PRD Q8. Options: (a) trust is per-repo (simple, coarse), (b) trust is per-path-prefix (complex, granular), (c) trust is per-service-catalog-entry (requires service catalog integration). Recommend: start with per-repo in Phase 1, add per-path-prefix in Phase 3 if needed. | Staff Eng | Open |

---

*End of TDD-009.*
