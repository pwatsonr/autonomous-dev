# SPEC-004-3-3: Human Escalation Gateway, Trust Levels & Human Decision Handler

## Metadata
- **Parent Plan**: PLAN-004-3
- **Tasks Covered**: Task 6, Task 7, Task 8
- **Estimated effort**: 11 hours

## Description

Build the HumanEscalationGateway that packages full escalation context and computes a recommended action, the TrustLevelManager that determines when human approval is required based on configurable trust levels, and the HumanDecisionHandler that processes human operator decisions on escalated documents. These components form the human integration layer of the review gate system.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/review-gate/human-escalation-gateway.ts` | Create | Escalation package assembly and action recommendation |
| `src/review-gate/trust-level-manager.ts` | Create | Trust level evaluation and human approval gating |
| `src/review-gate/human-decision-handler.ts` | Create | Processing human operator decisions |

## Implementation Details

### 1. HumanEscalationGateway (`human-escalation-gateway.ts`)

**Type definitions:**
```typescript
interface EscalationPackage {
  document_id: string;
  document_type: DocumentType;
  escalation_reason: string;
  escalation_trigger: EscalationTrigger;
  current_version: DocumentVersion;
  version_history: DocumentVersion[];
  review_history: GateReviewResult[];
  diffs: VersionDiff[];
  score_trend: number[];
  unresolved_findings: MergedFinding[];
  recurred_findings: MergedFinding[];
  parent_document: DocumentSummary | null;
  traceability_context: TraceLink[];
  recommended_action: "approve_override" | "manual_revision" | "reject_and_restart";
  recommended_action_rationale: string;
}

type EscalationTrigger =
  | "max_iterations_exhausted"
  | "critical_reject_finding"
  | "stagnation_persisted"
  | "trust_level_requirement"
  | "backward_cascade_depth_exceeded";

interface DocumentVersion {
  version: string;
  content: string;
  created_at: string;
}

interface VersionDiff {
  from_version: string;
  to_version: string;
  diff: string;  // unified diff format
}

interface DocumentSummary {
  document_id: string;
  document_type: DocumentType;
  title: string;
  summary: string;  // first 500 words or executive summary section
}

interface TraceLink {
  parent_document_id: string;
  parent_section_id: string;
  child_section_id: string;
}
```

**Class: `HumanEscalationGateway`**

**Primary method:**
```typescript
async assemblePackage(
  iterationState: IterationState,
  reviewHistory: GateReviewResult[],
  currentFindings: MergedFinding[],
  escalationTrigger: EscalationTrigger,
  documentVersions: DocumentVersion[],
  parentDocument: DocumentSummary | null,
  traceLinks: TraceLink[]
): Promise<EscalationPackage>
```

**Package assembly steps:**

1. **escalation_reason:** Human-readable string derived from trigger:
   - `max_iterations_exhausted`: `"Document did not achieve approval after {max_iterations} review iterations."`
   - `critical_reject_finding`: `"A critical finding requiring human intervention was identified: {finding.description}"`
   - `stagnation_persisted`: `"Review loop stagnated for 2+ consecutive iterations. Score trend: {trend}. Recurring findings: {count}."`
   - `trust_level_requirement`: `"Trust level '{level}' requires human approval for {document_type} documents."`
   - `backward_cascade_depth_exceeded`: `"Backward cascade depth exceeded maximum. Escalating before further cascade."`

2. **Version diffs:** Compute unified diffs between consecutive versions using a diff library. Each `VersionDiff` covers `v(N) -> v(N+1)`.

3. **Score trend:** Extract `aggregate_score` from each `GateReviewResult` in chronological order.

4. **Unresolved findings:** Filter `currentFindings` where `resolution_status === "open"`.

5. **Recurred findings:** Filter `currentFindings` where `resolution_status === "recurred"`.

6. **Recommended action computation:**

```typescript
function computeRecommendedAction(
  reviewHistory: GateReviewResult[],
  currentFindings: MergedFinding[],
  threshold: number
): { action: "approve_override" | "manual_revision" | "reject_and_restart"; rationale: string } {

  const latestReview = reviewHistory[reviewHistory.length - 1];
  const latestScore = latestReview.aggregate_score;
  const hasCriticalFindings = currentFindings.some(f => f.severity === "critical");
  const scoreTrend = reviewHistory.map(r => r.aggregate_score);
  const isScoreDeclining = scoreTrend.length >= 2
    && scoreTrend[scoreTrend.length - 1] < scoreTrend[scoreTrend.length - 2];
  const isStagnating = latestReview.stagnation_warning;

  // approve_override: within 3 points of threshold AND no critical findings
  if (latestScore >= threshold - 3 && !hasCriticalFindings) {
    return {
      action: "approve_override",
      rationale: `Latest score (${latestScore.toFixed(2)}) is within 3 points of the threshold (${threshold}). No critical findings. The remaining gap may be rubric noise. Consider approving with notes.`
    };
  }

  // reject_and_restart: critical findings OR stagnation OR declining scores
  if (hasCriticalFindings || isStagnating || isScoreDeclining) {
    const reasons = [];
    if (hasCriticalFindings) reasons.push("critical findings present");
    if (isStagnating) reasons.push("stagnation detected");
    if (isScoreDeclining) reasons.push("scores declining across iterations");
    return {
      action: "reject_and_restart",
      rationale: `Recommend rejection: ${reasons.join(", ")}. The document may need fundamental revision or parent document correction.`
    };
  }

  // manual_revision: default
  return {
    action: "manual_revision",
    rationale: `Specific findings remain unresolved but the document is fundamentally sound (score: ${latestScore.toFixed(2)}). Human guidance on the unresolved findings may help the author converge.`
  };
}
```

### 2. TrustLevelManager (`trust-level-manager.ts`)

**Class: `TrustLevelManager`**

**Constructor:**
```typescript
constructor(private trustLevel: TrustLevel = "approve_roots")
```

**Primary method:**
```typescript
requiresHumanApproval(
  documentType: DocumentType,
  aiOutcome: "approved" | "changes_requested" | "rejected"
): HumanApprovalDecision
```

**`HumanApprovalDecision` interface:**
```typescript
interface HumanApprovalDecision {
  human_approval_required: boolean;
  reason: string;
  gate_paused: boolean;  // true if gate should pause awaiting human decision
}
```

**Trust level logic:**

| Trust Level | PRD | TDD | Plan | Spec | Code |
|-------------|-----|-----|------|------|------|
| `full_auto` | No | No | No | No | No |
| `approve_roots` | Yes (after AI approval) | No | No | No | No |
| `approve_phase_1` | Yes (after AI approval) | Yes (after AI approval) | No | No | No |
| `approve_all` | Yes (after AI approval) | Yes (after AI approval) | Yes (after AI approval) | Yes (after AI approval) | Yes (after AI approval) |
| `human_only` | Yes (AI review skipped) | Yes (AI review skipped) | Yes (AI review skipped) | Yes (AI review skipped) | Yes (AI review skipped) |

**Implementation:**
```typescript
evaluateApproval(documentType: DocumentType, aiOutcome: string): HumanApprovalDecision {
  if (this.trustLevel === "full_auto") {
    return { human_approval_required: false, reason: "Trust level 'full_auto': AI decisions are final.", gate_paused: false };
  }

  if (this.trustLevel === "human_only") {
    return { human_approval_required: true, reason: "Trust level 'human_only': All documents require human review.", gate_paused: true };
  }

  // For the remaining levels, human approval is only required AFTER AI approves
  if (aiOutcome !== "approved") {
    return { human_approval_required: false, reason: "AI review did not approve. Returning to author.", gate_paused: false };
  }

  const requiresApproval = this.documentTypeRequiresApproval(documentType);
  if (requiresApproval) {
    return { human_approval_required: true, reason: `Trust level '${this.trustLevel}': ${documentType} documents require human approval after AI approval.`, gate_paused: true };
  }

  return { human_approval_required: false, reason: `Trust level '${this.trustLevel}': ${documentType} documents are autonomous.`, gate_paused: false };
}

private documentTypeRequiresApproval(documentType: DocumentType): boolean {
  switch (this.trustLevel) {
    case "approve_roots": return documentType === "PRD";
    case "approve_phase_1": return documentType === "PRD" || documentType === "TDD";
    case "approve_all": return true;
    default: return false;
  }
}
```

**Trust level evaluated AFTER AI review outcome is determined, BEFORE gate finalizes.** This means:
- If AI says `approved` and trust level requires human approval, the gate pauses.
- If AI says `changes_requested`, the document goes back to author regardless of trust level.
- If AI says `rejected`, escalation happens regardless of trust level.
- Exception: `human_only` skips AI review entirely.

### 3. HumanDecisionHandler (`human-decision-handler.ts`)

**Type definitions:**
```typescript
type HumanAction = "approve" | "approve_with_notes" | "revise" | "reject" | "cascade_up";

interface HumanDecision {
  action: HumanAction;
  operator_id: string;
  rationale: string;
  notes?: string;         // required for approve_with_notes
  guidance?: string;       // required for revise
  timestamp: string;       // ISO 8601
}

interface HumanDecisionResult {
  outcome: "approved" | "changes_requested" | "rejected" | "cascade_up";
  findings_addendum: MergedFinding[];  // any additional findings from human notes
  iteration_reset: boolean;            // true for "revise" action
  audit_record: AuditRecord;
}

interface AuditRecord {
  decision_id: string;
  gate_id: string;
  document_id: string;
  operator_id: string;
  action: HumanAction;
  rationale: string;
  timestamp: string;
  original_ai_outcome: string;
}
```

**Class: `HumanDecisionHandler`**

**Primary method:**
```typescript
processDecision(
  decision: HumanDecision,
  gateId: string,
  documentId: string,
  originalAiOutcome: string
): HumanDecisionResult
```

**Action implementations:**

| Action | outcome | findings_addendum | iteration_reset | Additional behavior |
|--------|---------|-------------------|-----------------|---------------------|
| `approve` | `"approved"` | System finding: "Approved by human override. Original AI outcome: {original}." Severity: `suggestion`. | false | All existing findings annotated as "accepted by human override" in their description. |
| `approve_with_notes` | `"approved"` | Human notes converted to findings. Each note becomes a `suggestion`-severity finding with `section_id: "human_notes"`, `category_id: "human_override"`. | false | Notes attached for downstream awareness. |
| `revise` | `"changes_requested"` | Human guidance converted to a `major` finding with `section_id: "human_guidance"`, `description: decision.guidance`. | true | Iteration counter resets. Author re-enters authoring phase with human guidance in context. |
| `reject` | `"rejected"` | System finding: "Rejected by human operator. Rationale: {rationale}." Severity: `critical`, sub: `reject`. | false | Pipeline subtree halts. |
| `cascade_up` | `"cascade_up"` | System finding: "Human confirmed issue is in parent document. Initiating backward cascade." Severity: `critical`, sub: `reject`. | false | Triggers backward cascade to parent document. |

**Audit record:** Every human action produces an `AuditRecord` with operator identity, timestamp, action taken, and rationale. These are immutable (append-only).

**Validation:**
- `approve_with_notes` requires non-empty `notes`. Throw `ValidationError` if missing.
- `revise` requires non-empty `guidance`. Throw `ValidationError` if missing.
- `operator_id` must be non-empty. Throw `ValidationError` if missing.
- `rationale` must be non-empty. Throw `ValidationError` if missing.

## Acceptance Criteria

1. EscalationPackage includes all versions, all feedback, diffs, score trend, unresolved/recurred findings, parent document, and traceability context.
2. `recommended_action` is `approve_override` when latest score is within 3 points of threshold AND no critical findings.
3. `recommended_action` is `reject_and_restart` when critical findings OR stagnation OR declining scores.
4. `recommended_action` is `manual_revision` as the default when neither of the above conditions holds.
5. Version diffs computed between consecutive document versions.
6. Trust level `full_auto`: no human approval required for any document type.
7. Trust level `approve_roots`: only PRD requires human approval after AI approval.
8. Trust level `approve_phase_1`: PRD and TDD require human approval.
9. Trust level `approve_all`: all document types require human approval.
10. Trust level `human_only`: AI review skipped, all docs go to human.
11. Trust level evaluated after AI outcome, before gate finalizes.
12. Human `approve`: document marked approved, findings noted as "accepted by human override".
13. Human `approve_with_notes`: notes attached as findings for downstream awareness.
14. Human `revise`: iteration counter resets, human guidance added to author context.
15. Human `reject`: pipeline subtree halts.
16. Human `cascade_up`: backward cascade initiated.
17. Every human action produces an immutable audit record with operator identity and rationale.
18. Validation enforces required fields for `approve_with_notes` (notes) and `revise` (guidance).

## Test Cases

### `tests/review-gate/human-escalation-gateway.test.ts`

1. **Max iterations escalation**: 3 iterations, all changes_requested. Package has 3 review entries, score_trend of 3 values, escalation_trigger: "max_iterations_exhausted".
2. **Critical reject escalation**: Single iteration with critical:reject finding. Package includes the finding. Trigger: "critical_reject_finding".
3. **Stagnation escalation**: 2 consecutive stagnation iterations. Trigger: "stagnation_persisted". Reason includes score trend and recurring finding count.
4. **Trust level escalation**: AI approved, but trust level requires human. Trigger: "trust_level_requirement".
5. **Recommended action -- approve_override**: Score 83, threshold 85 (within 3). No critical findings. Action: `approve_override`.
6. **Recommended action -- approve_override rejected by critical**: Score 83, threshold 85. But critical finding exists. Action: `reject_and_restart`.
7. **Recommended action -- reject_and_restart (stagnation)**: Stagnation detected. Action: `reject_and_restart`.
8. **Recommended action -- reject_and_restart (declining scores)**: Score trend [78, 75]. Action: `reject_and_restart`.
9. **Recommended action -- manual_revision (default)**: Score 70, no stagnation, no critical. Action: `manual_revision`.
10. **Version diffs present**: 3 versions. Package has 2 diffs (v1->v2, v2->v3).
11. **Unresolved findings filtered**: 5 total findings, 3 unresolved. Package `unresolved_findings` has 3.
12. **Recurred findings filtered**: 2 recurred findings. Package `recurred_findings` has 2.
13. **Parent document summary included**: Package has parent document summary with title and first 500 words.

### `tests/review-gate/trust-level-manager.test.ts`

14. **full_auto -- PRD approved**: No human approval required.
15. **full_auto -- Code approved**: No human approval required.
16. **approve_roots -- PRD approved**: Human approval required. `gate_paused: true`.
17. **approve_roots -- PRD changes_requested**: No human approval (AI didn't approve). `gate_paused: false`.
18. **approve_roots -- TDD approved**: No human approval (TDD is not a root).
19. **approve_phase_1 -- PRD approved**: Human approval required.
20. **approve_phase_1 -- TDD approved**: Human approval required.
21. **approve_phase_1 -- Plan approved**: No human approval.
22. **approve_all -- Spec approved**: Human approval required.
23. **approve_all -- Code changes_requested**: No human approval (not approved).
24. **human_only -- any document type**: Human approval required. AI skipped. `gate_paused: true`.
25. **Default trust level is approve_roots**: Construct with no arguments. Verify PRD needs approval.

### `tests/review-gate/human-decision-handler.test.ts`

26. **Approve action**: Returns outcome "approved". Audit record created with operator_id.
27. **Approve generates override finding**: Finding with description containing "human override" and severity "suggestion".
28. **Approve with notes**: Notes converted to suggestion-severity findings. Returns outcome "approved".
29. **Approve with notes -- missing notes throws**: `action: "approve_with_notes"` with no `notes` field. Throws ValidationError.
30. **Revise action**: Returns outcome "changes_requested". `iteration_reset: true`. Guidance as major finding.
31. **Revise -- missing guidance throws**: `action: "revise"` with no `guidance`. Throws ValidationError.
32. **Reject action**: Returns outcome "rejected". Critical:reject finding generated. `iteration_reset: false`.
33. **Cascade up action**: Returns outcome "cascade_up". Critical:reject finding mentioning backward cascade.
34. **Audit record completeness**: Every action produces audit record with `decision_id`, `gate_id`, `document_id`, `operator_id`, `action`, `rationale`, `timestamp`, `original_ai_outcome`.
35. **Missing operator_id throws**: Decision with empty `operator_id`. Throws ValidationError.
36. **Missing rationale throws**: Decision with empty `rationale`. Throws ValidationError.
