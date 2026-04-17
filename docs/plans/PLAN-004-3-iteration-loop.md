# PLAN-004-3: Iteration Loop, Feedback Formatting & Human Escalation

## Metadata
- **Parent TDD**: TDD-004-review-gates
- **Estimated effort**: 7 days
- **Dependencies**: [PLAN-004-1-rubric-engine, PLAN-004-2-reviewer-agents]
- **Blocked by**: [PLAN-004-1-rubric-engine, PLAN-004-2-reviewer-agents] (requires scoring, approval logic, and reviewer execution)
- **Priority**: P0

## Objective

Build the review iteration loop orchestrator, feedback formatting pipeline, convergence/stagnation tracking, quality regression detection, and human escalation gateway. This plan delivers the top-level `ReviewGateService` that ties together the rubric engine (PLAN-004-1) and reviewer agents (PLAN-004-2) into the complete create-review-revise-re-review lifecycle. It also delivers the human integration path for documents that cannot converge autonomously.

## Scope

### In Scope
- ReviewGateService: top-level orchestrator that receives a document, runs the full gate lifecycle, and returns a `GateOutcome` per TDD section 2.2
- IterationController: max iteration enforcement, iteration counting, outcome decision logic per TDD section 3.5
- Convergence tracking: score trend, finding resolution tracking, finding recurrence detection per TDD section 3.5.3
- Stagnation detection: declining scores, recurring findings, non-decreasing finding counts per TDD section 3.5.3
- Quality regression detection: score drop exceeding margin, rollback recommendation, auto-rollback option per TDD section 3.5.4
- FeedbackFormatter: merging findings from multiple reviewers, deduplication, cross-iteration finding tracking per TDD section 3.7
- Finding deduplication: section+category matching (Phase 1), with interface for embedding-based similarity (Phase 2) per TDD OQ-1
- Cross-iteration finding linking: resolved/recurred status tracking per TDD section 3.7.3
- HumanEscalationGateway: escalation package assembly, recommended action computation per TDD section 3.10
- Trust level system: `full_auto`, `approve_roots`, `approve_phase_1`, `approve_all`, `human_only` per TDD section 3.10.2
- Human decision interface contract: approve, approve with notes, revise, reject, cascade up per TDD section 3.10.4
- Identical revision detection (content hash comparison) per TDD section 5.3
- System failure recovery: crash mid-gate, checkpoint/restore per TDD section 5.2

### Out of Scope
- Rubric definitions and scoring math (PLAN-004-1)
- Reviewer agent execution and prompt assembly (PLAN-004-2)
- Smoke tests (PLAN-004-4)
- Metrics collection (PLAN-004-4, though this plan produces the data metrics consume)
- Human review UI implementation (separate concern; this plan defines the contract and package)
- Backward cascade engine (separate TDD)
- Document authoring/revision (how the author agent responds to feedback)

## Tasks

1. **Implement IterationController** -- Build the component that tracks iteration state and enforces termination conditions.
   - Files to create/modify:
     - `src/review-gate/iteration-controller.ts`
   - Acceptance criteria:
     - Tracks iteration count per gate invocation (starts at 1)
     - Max iterations configurable (default: 3)
     - After max iterations without approval, outcome is `rejected`
     - Stores score history across iterations for trend analysis
     - Stores finding history across iterations for resolution/recurrence tracking
     - Persists iteration state so it can survive crashes (checkpoint interface)
   - Estimated effort: 4 hours

2. **Implement convergence tracking and stagnation detection** -- Add analysis of score trends and finding patterns across iterations.
   - Files to create/modify:
     - `src/review-gate/convergence-tracker.ts`
   - Acceptance criteria:
     - Score trend: computed as difference between consecutive iteration aggregate scores
     - Finding resolution: findings from iteration N not present in N+1 marked `resolved`
     - Finding recurrence: findings marked `resolved` that reappear in a later iteration marked `recurred`
     - Stagnation detected when ANY of: score declines, resolved finding recurs, total finding count does not decrease
     - Stagnation warning added to review summary on first detection
     - Forced `rejected` outcome if stagnation persists for 2 consecutive iterations
     - Finding matching uses (section_id, category_id) pair as the match key
   - Estimated effort: 5 hours

3. **Implement quality regression detection** -- Detect and respond to score drops between iterations.
   - Files to create/modify:
     - `src/review-gate/quality-regression-detector.ts`
   - Acceptance criteria:
     - Configurable regression margin (default: 5 points)
     - Regression flagged when current_score < previous_score - margin
     - Produces `QualityRegression` object with previous score, current score, delta, rollback recommendation
     - `auto_rollback_on_regression` config option: when true, rollback occurs automatically and rolled-back version re-enters loop
     - Regression does not auto-reject -- full review feedback still generated
     - First iteration cannot have regression (no previous score to compare)
   - Estimated effort: 3 hours

4. **Implement FeedbackFormatter** -- Build the pipeline that merges, deduplicates, and structures findings from multiple reviewers.
   - Files to create/modify:
     - `src/review-gate/feedback-formatter.ts`
   - Acceptance criteria:
     - Merges findings from all reviewers into `MergedFinding[]`
     - Deduplication: two findings are duplicates if same `section_id` AND same `category_id` AND descriptions are semantically similar
     - Phase 1 similarity: exact (section_id, category_id) match with keyword overlap heuristic
     - Phase 2 interface: pluggable similarity function for embedding-based cosine similarity (>0.85 threshold)
     - Merged finding uses highest severity among duplicates
     - Merged `suggested_resolution` uses highest-severity resolution; if tied, longest text
     - `reported_by` lists all contributing reviewer IDs
     - Findings organized by section in the output
   - Estimated effort: 5 hours

5. **Implement cross-iteration finding tracking** -- Link findings across iterations to track resolution and recurrence.
   - Files to create/modify:
     - `src/review-gate/finding-tracker.ts`
   - Acceptance criteria:
     - Compares findings from iteration N against iteration N-1
     - Finding `resolved` if no matching (section_id, category_id) in current iteration
     - Finding `recurred` if it matches a previously resolved finding
     - `prior_finding_id` field links to the original finding ID
     - Recurred findings contribute to stagnation detection (integration with convergence tracker)
   - Estimated effort: 3 hours

6. **Implement HumanEscalationGateway** -- Build the gateway that packages escalation context and delivers it to the human review interface.
   - Files to create/modify:
     - `src/review-gate/human-escalation-gateway.ts`
   - Acceptance criteria:
     - Assembles `EscalationPackage` per TDD section 3.10.3: all versions, all feedback, diffs, score trend, unresolved/recurred findings, parent document, traceability context
     - `recommended_action` computed heuristically:
       - `approve_override`: latest score within 3 points of threshold AND no critical findings
       - `manual_revision`: specific findings unresolved but document fundamentally sound
       - `reject_and_restart`: critical findings OR stagnation OR declining scores
     - Escalation triggered by: max iterations exhausted, `critical:reject` finding, stagnation for 2+ iterations, trust level requirement, backward cascade depth exceeded
     - Package includes version diffs between consecutive document versions
   - Estimated effort: 5 hours

7. **Implement trust level system** -- Build the configurable trust levels that determine when human approval is required.
   - Files to create/modify:
     - `src/review-gate/trust-level-manager.ts`
   - Acceptance criteria:
     - 5 trust levels implemented: `full_auto`, `approve_roots`, `approve_phase_1`, `approve_all`, `human_only`
     - Default: `approve_roots`
     - `full_auto`: AI decisions final, humans only on escalation
     - `approve_roots`: PRDs require human approval after AI approval; downstream autonomous
     - `approve_phase_1`: PRD and TDD require human approval; Plan/Spec/Code autonomous
     - `approve_all`: every document requires human approval after AI approval
     - `human_only`: AI review skipped entirely, all docs go to human
     - Trust level evaluated after AI review outcome is determined, before gate finalizes
   - Estimated effort: 3 hours

8. **Implement human decision interface contract** -- Define the interface for human decisions on escalated documents.
   - Files to create/modify:
     - `src/review-gate/human-decision-handler.ts`
   - Acceptance criteria:
     - 5 actions supported: approve, approve_with_notes, revise, reject, cascade_up
     - `approve`: document marked approved, findings noted as "accepted by human override"
     - `approve_with_notes`: same as approve, human notes attached as findings for downstream awareness
     - `revise`: document re-enters authoring phase with human guidance, iteration counter resets
     - `reject`: document marked rejected, pipeline subtree halts
     - `cascade_up`: human confirms issue is in parent, initiates backward cascade
     - Every human action recorded with operator identity and rationale (audit)
   - Estimated effort: 3 hours

9. **Implement ReviewGateService** -- Build the top-level orchestrator that wires everything together.
   - Files to create/modify:
     - `src/review-gate/review-gate-service.ts`
   - Acceptance criteria:
     - Receives a document, runs the full gate lifecycle, returns a `GateOutcome`
     - Sequence: PreReviewValidator -> PanelAssembly -> BlindFilter -> ParallelReview -> ScoreAggregation -> DisagreementDetection -> ApprovalEvaluation -> IterationDecision
     - On `changes_requested`: produces `GateReviewResult` with structured feedback for author
     - On `approved`: signals document ready for decomposition or next phase
     - On `rejected`: triggers human escalation via HumanEscalationGateway
     - Evaluates trust level after AI decision
     - Identical revision detection via content hash comparison: auto-fails with `critical:blocking` finding
     - Crash recovery: checkpoints state after each reviewer completes; restores from last checkpoint on restart
   - Estimated effort: 6 hours

10. **Integration tests for the full gate lifecycle** -- End-to-end tests covering all major paths through the review gate.
    - Files to create/modify:
      - `tests/review-gate/review-gate-service.test.ts`
      - `tests/review-gate/iteration-controller.test.ts`
      - `tests/review-gate/convergence-tracker.test.ts`
      - `tests/review-gate/feedback-formatter.test.ts`
      - `tests/review-gate/human-escalation-gateway.test.ts`
    - Acceptance criteria:
      - Happy path: well-formed doc submitted, reviewed, approved on first pass
      - Revision loop: doc fails, feedback returned, revised doc submitted, approved on second pass
      - Max iteration escalation: doc never passes, verify escalation after 3 iterations with correct package
      - Critical finding reject: `critical:reject` finding causes immediate rejection, no further iterations
      - Quality regression: revision scores lower, regression flagged, rollback recommended
      - Stagnation: score declines across 2 iterations, forced rejection
      - Identical revision: same content hash detected, auto-fail
      - Trust levels: each level tested with appropriate document types
      - Finding tracking: resolved findings verified, recurred findings detected and flagged
    - Estimated effort: 8 hours

## Dependencies & Integration Points

- **Upstream**: PLAN-004-1 provides `ScoreAggregator`, `ApprovalEvaluator`, `PreReviewValidator`, and all data types. PLAN-004-2 provides `PanelAssemblyService`, `ReviewerExecutor`, `BlindScoringContextFilter`, `DisagreementDetector`.
- **Downstream**: PLAN-004-4 (metrics) hooks into `ReviewGateService` events to collect per-gate and per-reviewer metrics.
- **External**: The document store (separate TDD) provides document versioning and content retrieval. The authoring agent interface receives `GateReviewResult` and produces revised documents. The pipeline orchestrator (separate TDD) sequences gates across phases.

## Testing Strategy

- **Unit tests**: IterationController tested with mocked review outcomes across 1, 2, 3+ iterations. ConvergenceTracker tested with synthetic score/finding histories. FeedbackFormatter tested with overlapping findings from multiple reviewers. HumanEscalationGateway tested with various escalation triggers.
- **Integration tests**: Full gate lifecycle tested end-to-end with mocked reviewer agents that return predetermined scores. Multiple iteration paths exercised. Trust levels tested by configuring each level and verifying gate behavior for different document types.
- **Scenario tests**: Complex multi-iteration scenarios: pass on iteration 2, stagnation then rejection, regression then rollback then pass, critical finding on iteration 1, trust level override after AI approval.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Stagnation detection false positives (legitimate revision scores slightly lower due to AI variance) | Medium | Medium | Stagnation requires 2 consecutive detections before forced rejection. Single-iteration dips only produce a warning. Configurable margin allows tuning. |
| Finding deduplication is too aggressive (merges distinct issues) or too loose (reports same issue multiple times) | Medium | Medium | Phase 1 uses conservative (section_id, category_id) match. Phase 2 adds embedding similarity for finer deduplication. Authors can still see `reported_by` to understand reviewer consensus. |
| Human escalation packages are too large for human reviewers to process effectively | Medium | Low | Recommended action provides a starting point. Unresolved findings are prioritized by severity. Score trend gives a quick health signal. |
| Content hash comparison for identical revisions can be fooled by trivial whitespace changes | Low | Low | Normalize whitespace before hashing. Consider structural content comparison as a fallback. |
| Crash recovery checkpoint/restore adds complexity and may have edge cases | Medium | High | Checkpoint after each major stage (validation, each reviewer completion, aggregation). Integration test specifically tests crash-and-restore scenario. |

## Definition of Done

- [ ] ReviewGateService orchestrates the complete lifecycle: validate -> assemble -> review -> aggregate -> decide -> iterate/escalate
- [ ] IterationController enforces max iterations (default 3) and produces correct outcomes
- [ ] Convergence tracker detects stagnation from declining scores, recurring findings, non-decreasing finding counts
- [ ] Quality regression detector flags score drops > 5 points with rollback recommendation
- [ ] FeedbackFormatter merges and deduplicates findings from multiple reviewers
- [ ] Cross-iteration finding tracking marks findings as resolved/recurred
- [ ] HumanEscalationGateway produces complete escalation packages with correct recommended actions
- [ ] Trust level system correctly gates document types per all 5 trust levels
- [ ] Human decision handler supports all 5 actions with audit logging
- [ ] Identical revision detection prevents no-change resubmissions
- [ ] All integration tests pass covering happy path, revision loop, max iteration, critical finding, regression, stagnation, and trust level scenarios
- [ ] >90% line coverage on all modules
