import { PipelineState } from './pipeline-state';
import { readPipelineState, writePipelineState } from './pipeline-state-io';
import { DirectoryManager } from '../storage/directory-manager';

export interface PauseResult {
  success: boolean;
  wasAlreadyPaused: boolean;
  pausedAt: string | null;
}

export interface ResumeResult {
  success: boolean;
  wasAlreadyActive: boolean;
  /** Document IDs that are ready to proceed after resume */
  readyDocuments: string[];
}

/**
 * Pauses a pipeline.
 *
 * Behavior per TDD Section 3.9.4:
 *   - Sets status to PAUSED.
 *   - Records paused_at timestamp.
 *   - Documents retain their current state (no status changes).
 *   - In-review documents are NOT interrupted mid-review.
 *   - Pausing an already-paused pipeline is a no-op.
 *   - Writes pipeline.yaml atomically.
 *   - Emits "pipeline_paused" event.
 */
export async function pausePipeline(
  pipelineId: string,
  directoryManager: DirectoryManager,
  actorId: string,
): Promise<PauseResult> {
  const state = await readPipelineState(pipelineId, directoryManager);
  if (!state) throw new Error(`Pipeline ${pipelineId} not found`);

  if (state.status === 'PAUSED') {
    return { success: true, wasAlreadyPaused: true, pausedAt: state.pausedAt };
  }

  if (state.status !== 'ACTIVE') {
    throw new Error(`Cannot pause pipeline in ${state.status} state`);
  }

  state.status = 'PAUSED';
  state.pausedAt = new Date().toISOString();
  await writePipelineState(state, directoryManager);

  return { success: true, wasAlreadyPaused: false, pausedAt: state.pausedAt };
}

/**
 * Resumes a paused pipeline.
 *
 * Behavior per TDD Section 3.9.4:
 *   - Sets status to ACTIVE.
 *   - Clears paused_at.
 *   - Re-evaluates all documents:
 *     - draft documents with met dependencies: ready to assign
 *     - in-review documents: continue review (already in progress)
 *     - revision-requested documents: ready to assign for revision
 *   - Resuming a non-paused pipeline is a no-op.
 *   - Writes pipeline.yaml atomically.
 *   - Emits "pipeline_resumed" event.
 */
export async function resumePipeline(
  pipelineId: string,
  directoryManager: DirectoryManager,
  actorId: string,
): Promise<ResumeResult> {
  const state = await readPipelineState(pipelineId, directoryManager);
  if (!state) throw new Error(`Pipeline ${pipelineId} not found`);

  if (state.status !== 'PAUSED') {
    return { success: true, wasAlreadyActive: true, readyDocuments: [] };
  }

  state.status = 'ACTIVE';
  state.pausedAt = null;

  // Identify documents ready to proceed
  const readyDocuments: string[] = [];
  for (const [docId, docState] of Object.entries(state.documentStates)) {
    if (docState.status === 'draft' || docState.status === 'revision-requested') {
      const depsApproved = docState.blockedBy.every(bid =>
        state.documentStates[bid]?.status === 'approved',
      );
      if (depsApproved) readyDocuments.push(docId);
    }
  }

  await writePipelineState(state, directoryManager);

  return { success: true, wasAlreadyActive: false, readyDocuments };
}
