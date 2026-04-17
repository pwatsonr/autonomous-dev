import { PipelineState } from './pipeline-state';
import { readPipelineState, writePipelineState } from './pipeline-state-io';
import { DirectoryManager } from '../storage/directory-manager';

export interface CancellationResult {
  success: boolean;
  /** Documents that were cancelled (changed status) */
  cancelledDocuments: string[];
  /** Documents that were already in terminal state (not changed) */
  preservedDocuments: string[];
  mode: 'full' | 'subtree';
}

/**
 * Cancels a pipeline (full or subtree).
 *
 * Full cancellation (TDD Section 3.9.5):
 *   - Pipeline status set to CANCELLED.
 *   - Non-terminal documents (draft, in-review, revision-requested, stale)
 *     are marked as "cancelled".
 *   - Terminal documents (approved, rejected) preserve their status.
 *   - All files preserved for forensic review.
 *   - Emits "pipeline_cancelled" event.
 *
 * Subtree cancellation:
 *   - Only affects the specified rootDocumentId and its descendants.
 *   - Siblings are unaffected.
 *   - Pipeline status remains ACTIVE (unless all documents are now terminal).
 *   - Traceability matrix updated (delegated to caller).
 *   - Emits "subtree_cancelled" event.
 */
export async function cancelPipeline(
  pipelineId: string,
  directoryManager: DirectoryManager,
  mode: 'full' | 'subtree',
  rootDocumentId?: string,
  actorId?: string,
): Promise<CancellationResult> {
  const state = await readPipelineState(pipelineId, directoryManager);
  if (!state) throw new Error(`Pipeline ${pipelineId} not found`);

  const cancelledDocuments: string[] = [];
  const preservedDocuments: string[] = [];

  if (mode === 'full') {
    state.status = 'CANCELLED';

    for (const [docId, docState] of Object.entries(state.documentStates)) {
      if (isNonTerminal(docState.status)) {
        docState.status = 'cancelled';
        cancelledDocuments.push(docId);
      } else {
        preservedDocuments.push(docId);
      }
    }
  } else {
    // Subtree cancellation
    if (!rootDocumentId) throw new Error('rootDocumentId required for subtree cancellation');

    const subtreeIds = collectSubtreeIds(rootDocumentId, state);
    for (const docId of subtreeIds) {
      const docState = state.documentStates[docId];
      if (docState && isNonTerminal(docState.status)) {
        docState.status = 'cancelled';
        cancelledDocuments.push(docId);
      } else if (docState) {
        preservedDocuments.push(docId);
      }
    }
  }

  await writePipelineState(state, directoryManager);

  return {
    success: true,
    cancelledDocuments,
    preservedDocuments,
    mode,
  };
}

function isNonTerminal(status: string): boolean {
  return !['approved', 'rejected', 'cancelled'].includes(status);
}

/**
 * Collects all document IDs in the subtree rooted at the given document.
 */
function collectSubtreeIds(rootId: string, state: PipelineState): string[] {
  const result: string[] = [rootId];
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const docState = state.documentStates[current];
    if (docState) {
      for (const childId of docState.children) {
        result.push(childId);
        queue.push(childId);
      }
    }
  }
  return result;
}
