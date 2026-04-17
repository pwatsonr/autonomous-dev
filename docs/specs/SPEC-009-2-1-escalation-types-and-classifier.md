# SPEC-009-2-1: Escalation Type System and Classifier

## Metadata
- **Parent Plan**: PLAN-009-2
- **Tasks Covered**: Task 1 (Define escalation type system), Task 2 (Implement Escalation Classifier)
- **Estimated effort**: 7 hours

## Description

Define the complete type system for the escalation subsystem including the v1 JSON schema type, and implement the classifier that maps pipeline failure contexts to one of six escalation types with priority-based ambiguity resolution. The classifier is the entry point for all escalation decisions -- every pipeline failure passes through it to determine the type and urgency of human intervention needed.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/escalation/types.ts` | Create | All escalation subsystem types and interfaces |
| `src/escalation/classifier.ts` | Create | Failure-to-escalation-type classifier |

## Implementation Details

### types.ts

```typescript
export type EscalationType =
  | "product"
  | "technical"
  | "infrastructure"
  | "security"
  | "cost"
  | "quality";

export type EscalationUrgency = "immediate" | "soon" | "informational";

export type TimeoutBehavior = "pause" | "retry" | "skip" | "cancel";

export type RoutingMode = "default" | "advanced";

export interface EscalationMessage {
  // v1 JSON schema fields (TDD Section 3.2.2)
  schema_version: "v1";
  escalation_id: string;             // Format: esc-YYYYMMDD-NNN
  timestamp: string;                 // ISO 8601
  request_id: string;
  repository: string;
  pipeline_phase: string;
  escalation_type: EscalationType;
  urgency: EscalationUrgency;
  summary: string;                   // Human-readable, max 200 chars
  failure_reason: string;            // Detailed explanation
  options: EscalationOption[];       // At least 2 options
  artifacts?: EscalationArtifact[];  // Relevant artifacts
  technical_details?: string;        // Verbose mode only
  previous_escalation_id?: string;   // For re-escalation linking
  retry_count: number;
  cost_impact?: CostImpact;
}

export interface EscalationOption {
  option_id: string;                 // Format: opt-N
  label: string;                     // Human-readable label
  action: string;                    // Machine-readable action type
  description?: string;              // Extended description (verbose mode)
}

export interface EscalationArtifact {
  type: "log" | "diff" | "report" | "screenshot";
  path: string;                      // Workspace-relative path
  summary?: string;
}

export interface CostImpact {
  estimated_cost: number;
  currency: string;
  threshold_exceeded: boolean;
  budget_remaining?: number;
}

export interface RoutingTarget {
  target_id: string;
  display_name: string;
  channel: string;                   // Delivery channel identifier
}

export interface EscalationConfig {
  routing: {
    mode: RoutingMode;
    default_target: RoutingTarget;
    advanced?: Record<EscalationType, {
      primary: RoutingTarget;
      secondary?: RoutingTarget;
      timeout_minutes: number;
      timeout_behavior: TimeoutBehavior;
    }>;
  };
  verbosity: "terse" | "standard" | "verbose";
  retry_budget: number;
}
```

### classifier.ts

```typescript
export interface FailureContext {
  pipelinePhase: string;
  errorType: string;
  errorMessage: string;
  errorDetails?: Record<string, unknown>;
  retryCount: number;
  maxRetries: number;
  costData?: { estimated: number; threshold: number };
  securityFindings?: { severity: string; count: number }[];
  cicdFailure?: boolean;
  environmentFailure?: boolean;
}

export class EscalationClassifier {
  classify(context: FailureContext): { type: EscalationType; urgency: EscalationUrgency };
}
```

Classification rules (evaluated in priority order -- first match wins):

| Priority | Condition | Type | Default Urgency |
|----------|-----------|------|-----------------|
| 1 | `securityFindings` present with severity >= "high" | `security` | `immediate` (always) |
| 2 | `cicdFailure === true` OR `environmentFailure === true` | `infrastructure` | `soon` |
| 3 | `costData` present AND `costData.estimated > costData.threshold` | `cost` | `soon` |
| 4 | Review gate failed AND `retryCount >= maxRetries` | `quality` | `soon` |
| 5 | Implementation failure AND `retryCount >= maxRetries` | `technical` | `soon` |
| 6 | All other failures (ambiguous requirements, unclear specs) | `product` | `informational` |

Invariant: `security` type always forces urgency to `immediate`, regardless of any other signal.

## Acceptance Criteria

1. `EscalationMessage` type includes every field from the v1 JSON schema.
2. `EscalationOption` requires at least `option_id`, `label`, and `action`.
3. `EscalationType` is exactly a 6-member union.
4. `TimeoutBehavior` is exactly a 4-member union.
5. Classifier returns `security` with `immediate` urgency when security findings are present.
6. Classifier returns `infrastructure` when CI/CD or environment failures occur.
7. Classifier returns `cost` when cost threshold is exceeded.
8. Classifier returns `quality` when review gate fails after max retries.
9. Classifier returns `technical` when implementation fails after retry budget.
10. Classifier returns `product` as the default catch-all.
11. Ambiguous failures (matching multiple conditions) resolve by priority order.
12. Security urgency is always `immediate` even if other signals suggest `informational`.

## Test Cases

1. **Security finding -> security/immediate** -- Context with `securityFindings: [{ severity: "high", count: 2 }]` returns `{ type: "security", urgency: "immediate" }`.
2. **CI/CD failure -> infrastructure/soon** -- Context with `cicdFailure: true` returns `{ type: "infrastructure", urgency: "soon" }`.
3. **Environment failure -> infrastructure/soon** -- Context with `environmentFailure: true` returns `infrastructure`.
4. **Cost exceeded -> cost/soon** -- Context with `costData: { estimated: 150, threshold: 100 }` returns `cost`.
5. **Review gate failed after retries -> quality/soon** -- Context with review gate phase, `retryCount: 3, maxRetries: 3` returns `quality`.
6. **Implementation failure after retries -> technical/soon** -- Context with implementation phase, `retryCount: 5, maxRetries: 5` returns `technical`.
7. **Ambiguous requirements -> product/informational** -- Context with no specific failure signals returns `product`.
8. **Ambiguity resolution: security + infrastructure** -- Context with both `securityFindings` and `cicdFailure: true` returns `security` (higher priority).
9. **Ambiguity resolution: cost + quality** -- Context with both cost exceeded and review gate failure returns `cost` (higher priority).
10. **Security urgency is immutable** -- Even if all other signals suggest `informational`, a security finding forces `immediate`.
11. **No security findings = not security** -- Context with `securityFindings: []` (empty array) does not classify as security.
12. **Low-severity security finding** -- Context with `securityFindings: [{ severity: "low", count: 1 }]` does NOT classify as `security` (severity must be >= "high").
