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
