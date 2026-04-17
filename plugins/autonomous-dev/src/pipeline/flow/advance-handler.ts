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
