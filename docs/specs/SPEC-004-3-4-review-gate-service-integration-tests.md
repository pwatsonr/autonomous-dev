# SPEC-004-3-4: ReviewGateService Orchestrator & Integration Tests

## Metadata
- **Parent Plan**: PLAN-004-3
- **Tasks Covered**: Task 9, Task 10
- **Estimated effort**: 14 hours

## Description

Build the top-level ReviewGateService that wires all review gate components together into the complete create-review-revise-re-review lifecycle, and the comprehensive integration test suite that exercises all major paths through the system. The ReviewGateService is the single entry point for submitting documents to the review gate.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/review-gate/review-gate-service.ts` | Create | Top-level orchestrator |
| `tests/review-gate/review-gate-service.test.ts` | Create | Integration tests for the full lifecycle |
| `tests/review-gate/iteration-controller.test.ts` | Create | Extended iteration tests |
| `tests/review-gate/convergence-tracker.test.ts` | Create | Extended convergence tests |
| `tests/review-gate/feedback-formatter.test.ts` | Create | Extended formatter tests |
| `tests/review-gate/human-escalation-gateway.test.ts` | Create | Extended escalation tests |

## Implementation Details

### 1. ReviewGateService (`review-gate-service.ts`)

**Type definitions:**
```typescript
interface GateOutcome {
  gate_id: string;
  document_id: string;
  document_type: DocumentType;
  final_outcome: "approved" | "rejected" | "escalated" | "awaiting_human";
  final_score: number;
  total_iterations: number;
  review_result: GateReviewResult;
  escalation_package: EscalationPackage | null;
  human_approval_required: boolean;
  gate_record: ReviewGateRecord;
}

interface ReviewGateServiceConfig {
  max_iterations: number;                 // default: 3
  aggregation_method: "mean" | "median" | "min";  // default: "mean"
  trust_level: TrustLevel;                // default: "approve_roots"
  auto_rollback_on_regression: boolean;   // default: false
  panel_sizes: Record<DocumentType, number>;
  rotation_policy: Record<DocumentType, RotationPolicy>;
}
```

**Class: `ReviewGateService`**

**Constructor:**
```typescript
constructor(
  private preReviewValidator: PreReviewValidator,
  private panelAssemblyService: PanelAssemblyService,
  private blindFilter: BlindScoringContextFilter,
  private promptAssembler: ReviewerPromptAssembler,
  private reviewerExecutor: ReviewerExecutor,
  private scoreAggregator: ScoreAggregator,
  private disagreementDetector: DisagreementDetector,
  private approvalEvaluator: ApprovalEvaluator,
  private feedbackFormatter: FeedbackFormatter,
  private findingTracker: FindingTracker,
  private iterationController: IterationController,
  private convergenceTracker: ConvergenceTracker,
  private regressionDetector: QualityRegressionDetector,
  private trustLevelManager: TrustLevelManager,
  private humanEscalationGateway: HumanEscalationGateway,
  private rubricRegistry: RubricRegistry,
  private config: ReviewGateServiceConfig
)
```

**Primary method:**
```typescript
async submitForReview(
  document: DocumentForValidation,
  documentType: DocumentType,
  authorId: string,
  parentDocument?: DocumentForReview,
  previousPanel?: ReviewerAssignment[]
): Promise<GateOutcome>
```

**Orchestration sequence (single iteration):**

```
Step 1: Pre-Review Validation
  result = preReviewValidator.validate(document, documentType)
  if !result.valid:
    return GateOutcome with outcome "rejected", findings from validation errors
  scoringMode = result.scoring_mode

Step 2: Rubric Retrieval
  rubric = rubricRegistry.getRubric(documentType)

Step 3: Iteration State
  if first call for this document:
    state = iterationController.initializeGate(generateId(), document.id)
  state = iterationController.startIteration(state)

Step 4: Content Hash Check
  contentHash = computeContentHash(document.content)
  if contentHash matches any previous iteration:
    Auto-fail with critical:blocking finding
    Record outcome in iteration state
    Return changes_requested

Step 5: Blind Scoring Filter
  filteredDoc = blindFilter.filterDocument(document)
  filteredParent = parentDocument ? blindFilter.filterParentDocument(parentDocument) : null

Step 6: Panel Assembly
  panel = panelAssemblyService.assemblePanel(
    documentType, authorId, state.current_iteration, previousPanel
  )

Step 7: Prompt Assembly
  prompts = new Map()
  for each reviewer in panel:
    prompt = promptAssembler.assemblePrompt(
      reviewer, rubric, filteredDoc.content, filteredParent?.content,
      document.traces_from, getSectionMappings(documentType)
    )
    prompts.set(reviewer.reviewer_id, prompt)

Step 8: Checkpoint (review_started)
  iterationController.checkpoint(state, "review_started")

Step 9: Parallel Review Execution
  executionResult = await reviewerExecutor.executePanel(panel, prompts)
  if executionResult.escalation_required:
    Escalate to human (all reviewers failed)
    Return escalated outcome

Step 10: Checkpoint (review_completed)
  iterationController.checkpoint(state, "review_completed")

Step 11: Score Aggregation
  aggregationResult = scoreAggregator.aggregateScores(
    executionResult.review_outputs, rubric, config.aggregation_method
  )

Step 12: Disagreement Detection
  disagreements = disagreementDetector.detect(executionResult.review_outputs, rubric)

Step 13: Approval Evaluation
  approvalDecision = approvalEvaluator.evaluate(
    aggregationResult, executionResult.review_outputs, rubric,
    state.current_iteration, config.max_iterations
  )

Step 14: Feedback Formatting
  previousFindings = state.finding_history.length > 0
    ? state.finding_history[state.finding_history.length - 1].findings
    : null
  formattedFeedback = feedbackFormatter.formatFindings(
    executionResult.review_outputs, previousFindings
  )

Step 15: Finding Tracking
  trackingResult = findingTracker.trackFindings(
    formattedFeedback.merged_findings, previousFindings,
    state.finding_history.flatMap(h => h.findings)
  )

Step 16: Iteration Decision
  iterationDecision = iterationController.recordReviewOutcome(
    state, aggregationResult.aggregate_score,
    trackingResult.tracked_findings, contentHash,
    approvalDecision.outcome
  )

Step 17: Trust Level Evaluation
  if approvalDecision.outcome === "approved":
    humanCheck = trustLevelManager.requiresHumanApproval(documentType, "approved")
    if humanCheck.human_approval_required:
      Return GateOutcome with outcome "awaiting_human"

Step 18: Build GateReviewResult
  reviewResult = {
    gate_id: state.gate_id,
    document_id: document.id,
    document_version: document.frontmatter.version,
    iteration: state.current_iteration,
    outcome: approvalDecision.outcome,
    aggregate_score: aggregationResult.aggregate_score,
    threshold: rubric.approval_threshold,
    aggregation_method: config.aggregation_method,
    category_aggregates: aggregationResult.category_aggregates,
    findings: trackingResult.tracked_findings,
    disagreements,
    quality_regression: iterationDecision.quality_regression,
    stagnation_warning: iterationDecision.stagnation_warning,
    summary: generateSummary(approvalDecision, aggregationResult, trackingResult)
  }

Step 19: Escalation (if needed)
  if approvalDecision.outcome === "rejected" || iterationDecision.outcome === "rejected":
    package = humanEscalationGateway.assemblePackage(...)
    Return GateOutcome with outcome "escalated", escalation_package

Step 20: Checkpoint (decision)
  iterationController.checkpoint(state, "decision")

Step 21: Return GateOutcome
  return {
    gate_id: state.gate_id,
    document_id: document.id,
    document_type: documentType,
    final_outcome: iterationDecision.outcome ?? approvalDecision.outcome,
    final_score: aggregationResult.aggregate_score,
    total_iterations: state.current_iteration,
    review_result: reviewResult,
    escalation_package: null,
    human_approval_required: false,
    gate_record: buildGateRecord(state, reviewResult, executionResult, ...)
  }
```

**Summary generation:**
```typescript
function generateSummary(
  decision: ApprovalDecision,
  aggregation: AggregationResult,
  tracking: FindingTrackingResult
): string {
  const parts = [];
  parts.push(`Score: ${aggregation.aggregate_score.toFixed(2)}/${decision.threshold}.`);
  parts.push(`Outcome: ${decision.outcome}.`);
  if (tracking.resolved_findings.length > 0)
    parts.push(`${tracking.resolved_findings.length} finding(s) resolved.`);
  if (tracking.recurred_findings.length > 0)
    parts.push(`${tracking.recurred_findings.length} finding(s) recurred.`);
  if (tracking.new_findings.length > 0)
    parts.push(`${tracking.new_findings.length} new finding(s).`);
  if (decision.floor_violations.length > 0)
    parts.push(`${decision.floor_violations.length} per-category floor violation(s).`);
  return parts.join(" ");
}
```

**Crash recovery:**
On startup or when re-entering a gate for a known document, call `iterationController.restoreFromCheckpoint(gateId)`. If a checkpoint exists:
- If stage is "review_started": restart from Step 9 (re-execute reviewers).
- If stage is "review_completed": restart from Step 11 (re-aggregate, may reuse cached reviewer outputs).
- If stage is "decision": the gate completed; return the recorded outcome.

### 2. Integration Tests

All integration tests use mock LLM adapters that return predetermined JSON outputs. Tests exercise the full pipeline end-to-end.

## Acceptance Criteria

1. ReviewGateService receives a document and returns a `GateOutcome`.
2. Orchestration sequence follows the 21-step pipeline exactly.
3. On `changes_requested`: produces `GateReviewResult` with structured feedback.
4. On `approved`: signals document ready for next phase.
5. On `rejected`: triggers human escalation via HumanEscalationGateway.
6. Trust level evaluated after AI decision, before gate finalizes.
7. Identical revision detected via content hash; auto-fails with `critical:blocking`.
8. Crash recovery: checkpoints after review_started, review_completed, decision.
9. Crash recovery: restores from last checkpoint on restart.
10. Summary includes score, outcome, resolved/recurred/new findings count.

## Test Cases

### `tests/review-gate/review-gate-service.test.ts`

**Happy path tests:**
1. **Approved on first pass**: Well-formed PRD, mock reviewers return scores above threshold with no critical findings. Outcome: `approved`. Total iterations: 1.
2. **Approved with single reviewer**: Plan document (panel_size 1). Single reviewer approves. Outcome: `approved`.

**Revision loop tests:**
3. **Approved on second pass**: Mock reviewers return below-threshold on iteration 1 (`changes_requested`). Revised doc submitted for iteration 2. Scores above threshold. Outcome: `approved`. Total iterations: 2.
4. **Approved on third pass**: Fails iterations 1 and 2. Passes iteration 3. Outcome: `approved`. Total iterations: 3.

**Rejection and escalation tests:**
5. **Max iteration escalation**: Fails all 3 iterations. Outcome: `escalated`. Escalation package present with 3 review results.
6. **Critical:reject finding -- immediate rejection**: Mock reviewer returns `critical:reject` finding on iteration 1. Outcome: `escalated`. Total iterations: 1.
7. **Critical:blocking finding -- changes_requested**: Mock reviewer returns `critical:blocking` finding. Score above threshold. Outcome still `changes_requested`.

**Quality signals tests:**
8. **Quality regression flagged**: Iteration 1 score 80. Iteration 2 score 73 (drop > 5). `quality_regression` populated in review result.
9. **Stagnation warning on first detection**: Score declines on iteration 2. `stagnation_warning: true`. Not yet rejected.
10. **Stagnation forced rejection**: Score declines on iterations 2 and 3. Forced `rejected` outcome.
11. **Identical revision detection**: Same document content submitted twice. Second submission auto-fails with critical:blocking finding.

**Trust level tests:**
12. **approve_roots -- PRD approved, awaiting human**: PRD passes AI review. Trust level requires human. Outcome: `awaiting_human`.
13. **approve_roots -- TDD approved, no human**: TDD passes AI review. Trust level does not require human for TDD. Outcome: `approved`.
14. **full_auto -- PRD approved, no human**: Trust level full_auto. PRD passes. Outcome: `approved` directly.
15. **approve_all -- Code approved, awaiting human**: Trust level approve_all. Code passes. Outcome: `awaiting_human`.

**Finding tracking tests:**
16. **Findings resolved between iterations**: Iteration 1 flags 3 findings. Iteration 2 resolves 2 of them. Review result shows 2 resolved.
17. **Findings recurred**: Finding resolved in iteration 2, recurs in iteration 3. Marked as `recurred`.

**Disagreement tests:**
18. **Disagreement detected**: Two reviewers score `security_depth` at 75 and 55 (variance 20 >= 15). Disagreement flagged in review result.

**Error handling tests:**
19. **Pre-review validation fails**: Document missing required sections. Outcome: `rejected` with validation error findings.
20. **All reviewers fail**: Mock LLM adapter throws for all reviewers. Outcome: `escalated` with escalation reason "reviewer failure".

**Crash recovery tests:**
21. **Restore from review_completed checkpoint**: Simulate crash after reviewers complete. Restore. Verify aggregation and decision proceed correctly with the cached reviewer outputs.

**Edge case tests:**
22. **Document with 0-weight category**: Rubric has a category with weight 0. Score calculation skips it. No crash.
23. **Score exactly at threshold**: Aggregate score equals threshold. Outcome: `approved`.
24. **NaN aggregate score**: Mock inputs that produce NaN. Outcome: `changes_requested` with error logged.
