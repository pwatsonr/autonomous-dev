# PLAN-003-5: Backward Cascade Controller and Pipeline Flow Controller

## Metadata
- **Parent TDD**: TDD-003-document-pipeline
- **Estimated effort**: 10 days
- **Dependencies**: [PLAN-003-1 (types), PLAN-003-2 (storage), PLAN-003-3 (versioning), PLAN-003-4 (decomposition, traceability)]
- **Blocked by**: [PLAN-003-4]
- **Priority**: P1

## Objective
Deliver the two highest-level orchestration subsystems: the Backward Cascade Controller (upstream defect propagation, scoped child invalidation, depth-limited cascading, and cascade resolution) and the Pipeline Flow Controller (the state machine governing pipeline lifecycle -- phase progression, document state transitions, parallel/sequential sibling execution, pause/resume, cancellation, priority changes, and event emission). After this plan, the system has a fully functional document pipeline that can progress from PRD through Code, handle backward cascades when downstream reviews find upstream defects, and support operational controls (pause, resume, cancel, priority).

## Scope
### In Scope
- TDD Section 3.8: Backward Cascade Controller (cascade flow, data model, scoped cascade logic, cascade depth limiting)
- TDD Section 3.9: Pipeline Flow Controller (pipeline state, state file, phase progression rules, pause/resume, cancellation, priority changes, event emission)
- TDD Section 2.3: Document Lifecycle State Machine (all state transitions: draft, in-review, approved, revision-requested, rejected, cancelled, stale)
- TDD Section 5.6: Backward Cascade Controller API contract (`initiate`, `getStatus`, `resolve`, `escalate`)
- TDD Section 5.7: Pipeline Flow Controller API contract (`createPipeline`, `getState`, `advance`, `pause`, `resume`, `cancel`, `changePriority`, `listPipelines`)
- TDD Section 6: Error Handling & Recovery (failure taxonomy, recovery strategies, circuit breakers)
- TDD Section 3.9.7: Pipeline event types and event emission

### Out of Scope
- Agent scheduling and assignment (the flow controller emits events; agent orchestration is PRD-003/PRD-004)
- Review gate scoring algorithms (separate TDD; the flow controller consumes review outcomes)
- Phase 3 optimizations: configurable templates, observability metrics export, version comparison UI (potential future plan)
- Cross-pipeline traceability (OQ-6, deferred)

## Tasks

1. **Implement document lifecycle state machine** -- Define all valid state transitions per TDD Section 2.3 and enforce them. States: draft, in-review, approved, revision-requested, rejected, cancelled, stale. Transitions must be validated (e.g., cannot go from "approved" directly to "draft").
   - Files to create: `src/pipeline/flow/document-state-machine.ts`
   - Acceptance criteria: All transitions from TDD Section 2.3 diagram are valid and all others are rejected. Transitions: draft->in-review, in-review->approved, in-review->revision-requested, in-review->rejected, revision-requested->in-review (resubmit), approved->stale (backward cascade), stale->approved (re-approved), stale->revision-requested (needs revision), any->cancelled. Returns structured error for invalid transitions.
   - Estimated effort: 4 hours

2. **Implement PipelineState and DocumentState data models** -- Typed representations of the pipeline state and per-document state as defined in TDD Section 3.9.1.
   - Files to create: `src/pipeline/flow/pipeline-state.ts`
   - Acceptance criteria: Interfaces match TDD Section 3.9.1 (`PipelineState`, `PipelineStatus`, `DocumentState`). Pipeline statuses: ACTIVE, PAUSED, COMPLETED, CANCELLED, FAILED. Document state tracks: documentId, type, status, version, reviewIteration, lastReviewScore, assignedAgent, parentId, children, blockedBy, blocking.
   - Estimated effort: 3 hours

3. **Implement pipeline state file I/O** -- Read and write `pipeline.yaml` atomically, supporting the full state schema from TDD Section 3.9.2.
   - Files to create: `src/pipeline/flow/pipeline-state-io.ts`
   - Acceptance criteria: Serializes/deserializes `PipelineState` to/from YAML matching TDD Section 3.9.2 format. Uses atomic write from storage layer. Reads back all fields including nested `document_states` map. Handles missing file (returns null for initial pipeline creation).
   - Estimated effort: 4 hours

4. **Implement phase progression rules engine** -- Enforce the five progression rules from TDD Section 3.9.3: no skipping, gate required, parallel siblings, sequential siblings, and phase completion detection.
   - Files to create: `src/pipeline/flow/progression-rules.ts`
   - Acceptance criteria: Rule 1 (no skipping): rejects creation of depth N document without approved depth N-1 parent. Rule 2 (gate required): blocks decomposition of unapproved documents. Rule 3 (parallel siblings): siblings with `execution_mode: parallel` and no interdependencies proceed concurrently. Rule 4 (sequential siblings): siblings with dependencies wait until dependencies are approved. Rule 5 (phase completion): detects when all documents at a depth in a subtree are approved, signaling readiness for decomposition.
   - Estimated effort: 6 hours

5. **Implement pipeline advance handler** -- Process `AdvanceAction` events (submit_for_review, review_completed, decompose, revision_submitted) and transition the pipeline to the next state.
   - Files to create: `src/pipeline/flow/advance-handler.ts`
   - Acceptance criteria: Handles all four `AdvanceAction` values from TDD Section 5.7. `submit_for_review`: transitions document draft->in-review. `review_completed`: transitions based on review outcome (approved/changes_requested/rejected), updates review iteration and score. `decompose`: calls decomposition engine from PLAN-003-4, creates children, updates parent's children list. `revision_submitted`: transitions revision-requested->in-review (resubmit). Each action validates preconditions, updates pipeline state, writes pipeline.yaml, emits events.
   - Estimated effort: 8 hours

6. **Implement pause and resume** -- Pause halts all in-flight work at the next safe checkpoint; resume re-evaluates all documents and restarts processing.
   - Files to create: `src/pipeline/flow/pause-resume-handler.ts`
   - Acceptance criteria: Pause: sets status to PAUSED, records paused_at, documents retain their current state per TDD Section 3.9.4. Resume: sets status to ACTIVE, clears paused_at, re-evaluates document states (in-review documents are resubmitted, draft documents are re-assigned). Pausing an already-paused pipeline is a no-op. Resuming a non-paused pipeline is a no-op.
   - Estimated effort: 4 hours

7. **Implement cancellation (full and subtree)** -- Full cancellation terminates the entire pipeline. Subtree cancellation terminates a specific document and all its descendants.
   - Files to create: `src/pipeline/flow/cancellation-handler.ts`
   - Acceptance criteria: Full cancellation per TDD Section 3.9.5: sets pipeline status to CANCELLED, marks non-terminal documents as cancelled, preserves approved/rejected terminal states. Subtree cancellation: only affects the specified root and its descendants, siblings unaffected. Traceability matrix updated to reflect cancelled subtree. Both modes log cancellation events and preserve all files for forensic review.
   - Estimated effort: 5 hours

8. **Implement priority change handler** -- Update pipeline priority and propagate to all document frontmatter.
   - Files to create: `src/pipeline/flow/priority-handler.ts`
   - Acceptance criteria: Updates priority in pipeline.yaml and all document frontmatter per TDD Section 3.9.6. Emits `priority_changed` event. Valid priorities: critical, high, normal, low. Invalid priority values rejected.
   - Estimated effort: 2 hours

9. **Implement pipeline event emitter** -- Structured event emission to audit log and optional event bus. Defines all event types from TDD Section 3.9.7.
   - Files to create: `src/pipeline/flow/event-emitter.ts`
   - Acceptance criteria: Emits `PipelineEvent` objects per TDD Section 3.9.7 with: eventId (UUID), pipelineId, timestamp, eventType, documentId (when applicable), details, actorId. All event types defined in `PipelineEventType` enum (25 event types). Events appended to audit log via storage layer. Event bus integration point defined (interface only; implementation is out of scope).
   - Estimated effort: 4 hours

10. **Implement BackwardCascadeEvent data model** -- Typed representation of a backward cascade event per TDD Section 3.8.2.
    - Files to create: `src/pipeline/cascade/cascade-event.ts`
    - Acceptance criteria: Interface matches TDD Section 3.8.2 (`BackwardCascadeEvent`). ID format: `CASCADE-{PIPE_SEQ}-{SEQ}`. Tracks: triggeredBy (review/finding details), target document and sections, affected documents with previous/new status, cascade status (initiated/parent_revised/children_re_evaluated/resolved/escalated), cascade depth, max depth.
    - Estimated effort: 2 hours

11. **Implement scoped cascade logic** -- Determine which children are affected by a parent defect based on their `traces_from` entries referencing affected sections. Unaffected children remain in their current state.
    - Files to create: `src/pipeline/cascade/cascade-scoper.ts`
    - Acceptance criteria: Implements the scoping algorithm from TDD Section 3.8.3. Given a target document, affected sections, and all children: partitions children into affected (traces_from intersects affected sections) and unaffected. Uses the traceability impact analyzer from PLAN-003-4 for transitive impact across multiple levels.
    - Estimated effort: 4 hours

12. **Implement cascade depth limiter** -- Enforce the configurable maximum cascade depth. Depth 1 (parent): automatic. Depth 2 (grandparent): automatic with warning. Depth 3+: escalate to human.
    - Files to create: `src/pipeline/cascade/depth-limiter.ts`
    - Acceptance criteria: Enforces rules from TDD Section 3.8.4. Default max depth: 2. Configurable via `backward_cascade.max_depth` in config.yaml. Returns escalation recommendation when depth exceeds limit. Logs warnings at depth 2.
    - Estimated effort: 3 hours

13. **Implement backward cascade orchestrator** -- Coordinates the full 9-step cascade flow from TDD Section 3.8.1: validate finding, identify affected documents, pause in-flight work, mark children stale, re-open parent, wait for parent revision and review, re-evaluate stale children, resume pipeline.
    - Files to create: `src/pipeline/cascade/cascade-controller.ts`
    - Acceptance criteria: Implements `BackwardCascadeAPI` from TDD Section 5.6 (`initiate`, `getStatus`, `resolve`, `escalate`). Follows all 9 steps from TDD Section 3.8.1. Validates the upstream defect claim (target section exists in target document). Uses traceability impact analyzer to find all affected documents. Marks affected approved children as "stale". Re-opens target document for revision with major version bump (via versioning engine). Re-evaluates stale children after parent revision: unaffected children re-approved, affected children set to revision-requested. Cascade event persisted and tracked. Circuit breaker: same section cascaded twice triggers human escalation per TDD Section 6.3.
    - Estimated effort: 10 hours

14. **Implement pipeline creation** -- Create a new pipeline: generate pipeline ID, initialize directory, create root PRD document, set initial state.
    - Files to create: `src/pipeline/flow/pipeline-creator.ts`
    - Acceptance criteria: Implements `createPipeline(request: CreatePipelineRequest): Promise<PipelineState>` per TDD Section 5.7. Generates pipeline ID in `PIPE-{YYYY}-{MMDD}-{SEQ}` format. Calls storage layer to initialize directory (PLAN-003-2 Task 3). Creates root PRD document. Returns initial pipeline state with status ACTIVE.
    - Estimated effort: 3 hours

15. **Implement pipeline listing and state retrieval** -- List all pipelines with optional filtering; get current state of a specific pipeline.
    - Files to create: `src/pipeline/flow/pipeline-query.ts`
    - Acceptance criteria: Implements `getState(pipelineId)` and `listPipelines(filter?)` per TDD Section 5.7. Filter supports status, priority, date range. Reads pipeline.yaml from each pipeline directory. Returns complete `PipelineState` objects.
    - Estimated effort: 3 hours

16. **Implement crash recovery and state reconciliation** -- Reconstruct pipeline state from document frontmatter and audit log when pipeline.yaml is corrupted or inconsistent.
    - Files to create: `src/pipeline/flow/state-reconciler.ts`
    - Acceptance criteria: Implements the reconciliation process from TDD Section 6.2: scan document directories for frontmatter, read audit log for latest events per document, rebuild pipeline state. Detects inconsistencies between pipeline.yaml and actual document states. Manual operation (not automatic) per TDD design. Produces a reconciliation report listing all corrections made.
    - Estimated effort: 6 hours

17. **Implement circuit breakers** -- Detect and handle runaway conditions: review loops, repeated cascades, decomposition retry exhaustion, and agent failure streaks.
    - Files to create: `src/pipeline/flow/circuit-breakers.ts`
    - Acceptance criteria: Implements all four circuit breakers from TDD Section 6.3. Review loop: same finding recurs after resolution -> escalate. Backward cascade: same section cascaded twice -> escalate. Decomposition retry: 3 consecutive smoke test failures -> escalate. Agent failure: same agent fails 3 consecutive tasks -> remove from rotation. All breakers emit `HUMAN_ESCALATION` event.
    - Estimated effort: 4 hours

18. **Assemble PipelineFlowControllerAPI and BackwardCascadeAPI facades** -- Wire all components into the unified API interfaces.
    - Files to create: `src/pipeline/flow/pipeline-flow-controller.ts`, `src/pipeline/cascade/index.ts`
    - Acceptance criteria: Pipeline Flow Controller implements all methods from TDD Section 5.7. Backward Cascade Controller implements all methods from TDD Section 5.6. Flow controller coordinates all subsystems (storage, versioning, decomposition, traceability, cascade). Every state transition persists to pipeline.yaml and emits an event.
    - Estimated effort: 6 hours

## Dependencies & Integration Points
- **PLAN-003-1**: Uses all type definitions, frontmatter types, document status enums.
- **PLAN-003-2**: All state persistence (pipeline.yaml, audit log, document reads/writes) goes through the storage layer.
- **PLAN-003-3**: Backward cascade triggers major version bumps via versioning engine. Flow controller calls `checkRegression` after reviews.
- **PLAN-003-4**: Flow controller calls `decompose()` after review gate pass. Backward cascade controller calls `analyzeImpact()` to scope cascades. Gap detection runs at review gates.
- **Agent Orchestration** (PRD-003/PRD-004, out of scope): The flow controller emits events that the agent scheduler consumes. The flow controller does not directly manage agents; it manages document and pipeline state.
- **Review Gate Engine** (separate TDD): The flow controller processes review outcomes. It does not run review scoring.

## Testing Strategy
- **Unit tests**:
  - Document state machine: every valid transition, every invalid transition, terminal state enforcement.
  - Phase progression rules: no skipping, gate required, parallel execution, sequential execution, phase completion.
  - Cascade scoper: affected vs. unaffected children, no traces to affected sections, all traces to affected sections.
  - Depth limiter: depth 1 (auto), depth 2 (auto + warning), depth 3 (escalation), configurable limit.
  - Circuit breakers: each breaker triggers at threshold, does not trigger below threshold.
  - Target: 90% coverage for cascade scoping per TDD Section 8.1.
- **Integration tests** (TDD Section 8.2):
  - Full pipeline: PRD to Code -- document at each phase created, reviewed, decomposed correctly.
  - Review loop: 3 iterations then escalation event emitted, document state correct.
  - Backward cascade: TDD review finds defect in PRD -- correct children marked stale, parent revised, children re-evaluated.
  - Decomposition with dependencies: dependency graph respected in execution order.
  - Crash recovery: simulate kill mid-review, verify pipeline resumes correctly from last consistent state.
  - Quality regression rollback: new version created with old content, scores compared correctly.
- **End-to-end tests** (TDD Section 8.3):
  - Happy path: PRD -> 2 TDDs -> 4 Plans -> 8 Specs -> 8 Code deliverables, all approved, traceability complete.
  - Unhappy path: PRD fails review twice, passes third. One TDD triggers backward cascade. Pipeline still completes.
  - Cancellation: cancelled mid-Plan phase, all documents in correct terminal states.
  - Pause/resume: paused at TDD review, resumed, state identical to pre-pause.
- **Performance tests** (TDD Section 8.4):
  - 5 concurrent pipelines, each with 50 documents.
  - State file I/O: atomic write + read cycle under 50ms for maximum-size pipeline.yaml.

## Risks
1. **Backward cascade complexity** -- The cascade flow involves 9 steps with multiple subsystem interactions. A bug at any step can leave the pipeline in an inconsistent state. Mitigation: Every step is idempotent and logged. State reconciliation (Task 16) can repair inconsistencies. Extensive integration tests cover the full flow.
2. **State machine race conditions** -- Multiple agents advancing the same pipeline concurrently could cause conflicting state transitions. Mitigation: Pipeline.yaml writes are atomic. The flow controller serializes state transitions by reading-validating-writing pipeline.yaml in a single atomic operation. For MVP (single-host), file-level atomicity is sufficient.
3. **Cascade loops** -- A backward cascade revision could introduce a new defect that triggers another cascade. Mitigation: Circuit breaker (Task 17) detects repeated cascades on the same section and escalates to human. Max cascade depth limits propagation.
4. **Pause/resume correctness** -- Resuming a paused pipeline must correctly re-evaluate all documents without skipping any or processing them twice. Mitigation: Resume reads the complete pipeline state and recomputes the execution plan from scratch. Documents are idempotent -- re-submitting an already-in-review document is a no-op.
5. **Performance at scale** -- A 100-node pipeline with active cascades could generate many state file writes. Mitigation: Performance test validates state file I/O under 50ms. For MVP, the 100-node limit keeps state files manageable.

## Definition of Done
- [ ] Document lifecycle state machine enforces all valid transitions and rejects invalid ones
- [ ] Pipeline flow controller supports full lifecycle: create, advance, pause, resume, cancel
- [ ] Phase progression rules enforced: no skipping, gate required, parallel/sequential siblings, phase completion
- [ ] Backward cascade controller follows all 9 steps from TDD Section 3.8.1
- [ ] Scoped cascades correctly partition affected and unaffected children
- [ ] Cascade depth limiting enforced with escalation at configured threshold
- [ ] Pipeline state persisted atomically to pipeline.yaml after every transition
- [ ] Event emission for all 25 event types defined in TDD Section 3.9.7
- [ ] Cancellation supports full and subtree modes
- [ ] Pause/resume preserves document states and resumes correctly
- [ ] Circuit breakers detect and escalate runaway conditions
- [ ] State reconciliation can rebuild pipeline.yaml from documents and audit log
- [ ] Both API facades expose all methods from TDD Sections 5.6 and 5.7
- [ ] Integration tests: full pipeline progression, backward cascade, crash recovery all pass
- [ ] End-to-end test: happy path pipeline from PRD to Code completes with full traceability
