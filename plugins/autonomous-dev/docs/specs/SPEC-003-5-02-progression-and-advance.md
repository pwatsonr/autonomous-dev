# SPEC-003-5-02: Phase Progression Rules Engine and Pipeline Advance Handler

## Metadata
- **Parent Plan**: PLAN-003-5
- **Tasks Covered**: Task 4, Task 5
- **Estimated effort**: 14 hours

## Description
Implement the phase progression rules engine (enforces no-skipping, gate-required, parallel/sequential sibling execution, and phase completion detection) and the pipeline advance handler that processes `AdvanceAction` events (submit_for_review, review_completed, decompose, revision_submitted) to transition the pipeline to its next state.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/flow/progression-rules.ts` | Create |
| `src/pipeline/flow/advance-handler.ts` | Create |

## Implementation Details

### Task 4: `src/pipeline/flow/progression-rules.ts`

```typescript
import { DocumentType, getDepth } from '../types/document-type';
import { PipelineState, DocumentState } from './pipeline-state';

export type ProgressionViolation =
  | 'SKIP_VIOLATION'
  | 'GATE_VIOLATION'
  | 'DEPENDENCY_NOT_MET'
  | 'PHASE_INCOMPLETE';

export class ProgressionError extends Error {
  constructor(
    public readonly violation: ProgressionViolation,
    message: string,
  ) {
    super(message);
    this.name = 'ProgressionError';
  }
}

/**
 * Rule 1: No Skipping.
 * Cannot create a depth N document without an approved depth N-1 parent.
 *
 * @throws ProgressionError with SKIP_VIOLATION
 */
export function checkNoSkipping(
  childType: DocumentType,
  parentId: string | null,
  pipelineState: PipelineState,
): void {
  const childDepth = getDepth(childType);
  if (childDepth === 0) return; // PRD has no parent

  if (!parentId) {
    throw new ProgressionError(
      'SKIP_VIOLATION',
      `${childType} document requires a parent but none provided`,
    );
  }

  const parentState = pipelineState.documentStates[parentId];
  if (!parentState) {
    throw new ProgressionError(
      'SKIP_VIOLATION',
      `Parent ${parentId} not found in pipeline state`,
    );
  }

  if (parentState.status !== 'approved') {
    throw new ProgressionError(
      'SKIP_VIOLATION',
      `Parent ${parentId} has status "${parentState.status}", must be "approved" to create ${childType} children`,
    );
  }
}

/**
 * Rule 2: Gate Required.
 * Cannot decompose a document that has not passed its review gate.
 * Document must be in "approved" status.
 *
 * @throws ProgressionError with GATE_VIOLATION
 */
export function checkGateRequired(
  documentId: string,
  pipelineState: PipelineState,
): void {
  const docState = pipelineState.documentStates[documentId];
  if (!docState) {
    throw new ProgressionError('GATE_VIOLATION', `Document ${documentId} not found`);
  }
  if (docState.status !== 'approved') {
    throw new ProgressionError(
      'GATE_VIOLATION',
      `Document ${documentId} must be approved before decomposition (current: ${docState.status})`,
    );
  }
}

/**
 * Rule 3: Parallel Siblings.
 * Siblings with execution_mode=parallel and no interdependencies
 * can proceed concurrently. Returns the set of document IDs
 * that are ready to proceed.
 */
export function getReadyParallelSiblings(
  siblingIds: string[],
  pipelineState: PipelineState,
): string[] {
  return siblingIds.filter(id => {
    const state = pipelineState.documentStates[id];
    if (!state) return false;
    if (state.status !== 'draft') return false; // Only draft docs can be started

    // Check all blocking dependencies are approved
    return state.blockedBy.every(blockerId => {
      const blockerState = pipelineState.documentStates[blockerId];
      return blockerState && blockerState.status === 'approved';
    });
  });
}

/**
 * Rule 4: Sequential Dependencies.
 * A document with dependencies waits until all dependencies are approved.
 *
 * @returns true if all dependencies are met
 */
export function areDependenciesMet(
  documentId: string,
  pipelineState: PipelineState,
): boolean {
  const docState = pipelineState.documentStates[documentId];
  if (!docState) return false;

  return docState.blockedBy.every(blockerId => {
    const blockerState = pipelineState.documentStates[blockerId];
    return blockerState && blockerState.status === 'approved';
  });
}

/**
 * Rule 5: Phase Completion Detection.
 * Detects when all documents at a given depth within a subtree are approved.
 * This signals readiness for decomposition of those approved documents.
 *
 * @param parentId The parent document to check children for
 * @param pipelineState Current pipeline state
 * @returns true if all children of parentId are approved
 */
export function isPhaseComplete(
  parentId: string,
  pipelineState: PipelineState,
): boolean {
  const parentState = pipelineState.documentStates[parentId];
  if (!parentState) return false;

  if (parentState.children.length === 0) return false; // No children yet

  return parentState.children.every(childId => {
    const childState = pipelineState.documentStates[childId];
    return childState && childState.status === 'approved';
  });
}
```

### Task 5: `src/pipeline/flow/advance-handler.ts`

```typescript
import { DocumentType } from '../types/document-type';
import { PipelineState, DocumentState } from './pipeline-state';
import { readPipelineState, writePipelineState } from './pipeline-state-io';
import { validateTransition } from './document-state-machine';
import { checkNoSkipping, checkGateRequired } from './progression-rules';
import { DirectoryManager } from '../storage/directory-manager';
import { DocumentStorage } from '../storage/document-storage';
import { VersioningEngine } from '../versioning/versioning-engine';

export type AdvanceAction =
  | 'submit_for_review'
  | 'review_completed'
  | 'decompose'
  | 'revision_submitted';

export type ReviewOutcome = 'approved' | 'changes_requested' | 'rejected';

export interface AdvanceRequest {
  pipelineId: string;
  action: AdvanceAction;
  documentId: string;
  /** Required for review_completed */
  reviewOutcome?: ReviewOutcome;
  /** Required for review_completed */
  reviewScore?: number;
  /** Required for review_completed */
  reviewIteration?: number;
  /** Actor performing the action */
  actorId: string;
}

export interface AdvanceResult {
  success: boolean;
  previousStatus: string;
  newStatus: string;
  pipelineState: PipelineState;
  events: string[];
}

/**
 * Processes an advance action on a pipeline.
 *
 * Flow per action:
 *
 * submit_for_review:
 *   1. Validate document is in "draft" or "revision-requested" status.
 *   2. Transition to "in-review".
 *   3. Update pipeline state, write pipeline.yaml.
 *   4. Emit "document_submitted_for_review" event.
 *
 * review_completed:
 *   1. Validate document is in "in-review" status.
 *   2. Based on reviewOutcome:
 *      - approved: transition to "approved".
 *        Check regression via versioning engine.
 *        If regression: rollback_suggested (but proceed with approval for now).
 *      - changes_requested: transition to "revision-requested".
 *      - rejected: transition to "rejected".
 *   3. Update reviewIteration and lastReviewScore in document state.
 *   4. Update pipeline state, write pipeline.yaml.
 *   5. Emit "review_completed" event.
 *
 * decompose:
 *   1. Validate document is "approved" (gate required).
 *   2. Call decomposition engine (PLAN-003-4).
 *   3. Add child document states to pipeline state.
 *   4. Update parent's children list.
 *   5. Write pipeline.yaml.
 *   6. Emit "document_decomposed" event.
 *
 * revision_submitted:
 *   1. Validate document is in "revision-requested" status.
 *   2. Transition to "in-review".
 *   3. Create new version via versioning engine.
 *   4. Write pipeline.yaml.
 *   5. Emit "revision_submitted" event.
 *
 * All actions:
 *   - Read-validate-write pipeline.yaml as a single atomic operation.
 *   - Emit events to audit log.
 */
export async function advancePipeline(
  request: AdvanceRequest,
  storage: DocumentStorage,
  versioningEngine: VersioningEngine,
  directoryManager: DirectoryManager,
): Promise<AdvanceResult> {
  // 1. Read current state
  const state = await readPipelineState(request.pipelineId, directoryManager);
  if (!state) throw new Error(`Pipeline ${request.pipelineId} not found`);

  const docState = state.documentStates[request.documentId];
  if (!docState) throw new Error(`Document ${request.documentId} not found in pipeline`);

  const previousStatus = docState.status;
  const events: string[] = [];

  switch (request.action) {
    case 'submit_for_review': {
      validateTransition(docState.status, 'in-review');
      docState.status = 'in-review';
      events.push('document_submitted_for_review');
      break;
    }

    case 'review_completed': {
      if (!request.reviewOutcome) throw new Error('reviewOutcome required');
      const newStatus = mapReviewOutcome(request.reviewOutcome);
      validateTransition(docState.status, newStatus);
      docState.status = newStatus;
      docState.reviewIteration = request.reviewIteration ?? docState.reviewIteration + 1;
      docState.lastReviewScore = request.reviewScore ?? null;
      state.metrics.totalReviews++;
      events.push('review_completed');
      break;
    }

    case 'decompose': {
      checkGateRequired(request.documentId, state);
      events.push('decomposition_requested');
      // Actual decomposition delegated to caller; this just validates preconditions
      break;
    }

    case 'revision_submitted': {
      validateTransition(docState.status, 'in-review');
      docState.status = 'in-review';
      events.push('revision_submitted');
      break;
    }
  }

  // Update metrics
  updateMetrics(state);

  // Write state atomically
  await writePipelineState(state, directoryManager);

  return {
    success: true,
    previousStatus,
    newStatus: docState.status,
    pipelineState: state,
    events,
  };
}

function mapReviewOutcome(outcome: ReviewOutcome): import('../types/frontmatter').DocumentStatus {
  switch (outcome) {
    case 'approved': return 'approved';
    case 'changes_requested': return 'revision-requested';
    case 'rejected': return 'rejected';
  }
}

function updateMetrics(state: PipelineState): void {
  const byStatus: Record<string, number> = {};
  for (const doc of Object.values(state.documentStates)) {
    byStatus[doc.status] = (byStatus[doc.status] ?? 0) + 1;
  }
  state.metrics.documentsByStatus = byStatus;
  state.metrics.totalDocuments = Object.keys(state.documentStates).length;
}
```

## Acceptance Criteria
1. `checkNoSkipping` rejects creating a child when parent is not approved.
2. `checkNoSkipping` allows creating a PRD (depth 0, no parent needed).
3. `checkGateRequired` rejects decomposition of non-approved documents.
4. `getReadyParallelSiblings` returns only siblings in "draft" with all blockers approved.
5. `areDependenciesMet` returns true when all blockers are approved.
6. `isPhaseComplete` returns true when all children of a parent are approved.
7. `isPhaseComplete` returns false when parent has no children.
8. `advancePipeline('submit_for_review')` transitions draft -> in-review.
9. `advancePipeline('review_completed', approved)` transitions in-review -> approved.
10. `advancePipeline('review_completed', changes_requested)` transitions in-review -> revision-requested.
11. `advancePipeline('review_completed', rejected)` transitions in-review -> rejected.
12. `advancePipeline('decompose')` validates gate before proceeding.
13. `advancePipeline('revision_submitted')` transitions revision-requested -> in-review.
14. All advance actions write pipeline.yaml atomically.
15. All advance actions emit events to audit log.

## Test Cases

### Unit Tests: `tests/pipeline/flow/progression-rules.test.ts`
- `checkNoSkipping: allows PRD creation (no parent)`
- `checkNoSkipping: allows TDD when parent PRD is approved`
- `checkNoSkipping: rejects TDD when parent PRD is draft`
- `checkNoSkipping: rejects when parent not found in state`
- `checkGateRequired: allows decomposition of approved document`
- `checkGateRequired: rejects decomposition of draft document`
- `getReadyParallelSiblings: returns draft siblings with met dependencies`
- `getReadyParallelSiblings: excludes siblings with unmet dependencies`
- `getReadyParallelSiblings: excludes non-draft siblings`
- `areDependenciesMet: returns true when no blockers`
- `areDependenciesMet: returns true when all blockers approved`
- `areDependenciesMet: returns false when any blocker not approved`
- `isPhaseComplete: returns true when all children approved`
- `isPhaseComplete: returns false when any child not approved`
- `isPhaseComplete: returns false when parent has no children`

### Unit Tests: `tests/pipeline/flow/advance-handler.test.ts`
- `submit_for_review: draft -> in-review`
- `submit_for_review: rejects if document is approved`
- `review_completed approved: in-review -> approved`
- `review_completed changes_requested: in-review -> revision-requested`
- `review_completed rejected: in-review -> rejected`
- `review_completed: updates reviewIteration and lastReviewScore`
- `review_completed: increments totalReviews metric`
- `decompose: validates gate (approved required)`
- `decompose: rejects draft document`
- `revision_submitted: revision-requested -> in-review`
- `all actions: write pipeline.yaml after state change`
- `all actions: emit at least one event`
- `metrics updated correctly after state change`
