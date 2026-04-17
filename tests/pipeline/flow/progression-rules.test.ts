import {
  checkNoSkipping,
  checkGateRequired,
  getReadyParallelSiblings,
  areDependenciesMet,
  isPhaseComplete,
  ProgressionError,
} from '../../../src/pipeline/flow/progression-rules';
import { createInitialPipelineState, PipelineState, DocumentState } from '../../../src/pipeline/flow/pipeline-state';
import { DocumentType } from '../../../src/pipeline/types/document-type';

function makeDocState(overrides: Partial<DocumentState> & { documentId: string }): DocumentState {
  return {
    type: DocumentType.PRD,
    status: 'draft',
    version: '1.0',
    reviewIteration: 0,
    lastReviewScore: null,
    assignedAgent: null,
    parentId: null,
    children: [],
    blockedBy: [],
    blocking: [],
    ...overrides,
  };
}

function makeState(docs: DocumentState[]): PipelineState {
  const state = createInitialPipelineState('PIPE-TEST-001', 'Test Pipeline');
  for (const doc of docs) {
    state.documentStates[doc.documentId] = doc;
  }
  return state;
}

describe('checkNoSkipping', () => {
  it('allows PRD creation (no parent)', () => {
    const state = makeState([]);
    expect(() => checkNoSkipping(DocumentType.PRD, null, state)).not.toThrow();
  });

  it('allows TDD when parent PRD is approved', () => {
    const state = makeState([
      makeDocState({ documentId: 'PRD-001', type: DocumentType.PRD, status: 'approved' }),
    ]);
    expect(() => checkNoSkipping(DocumentType.TDD, 'PRD-001', state)).not.toThrow();
  });

  it('rejects TDD when parent PRD is draft', () => {
    const state = makeState([
      makeDocState({ documentId: 'PRD-001', type: DocumentType.PRD, status: 'draft' }),
    ]);
    expect(() => checkNoSkipping(DocumentType.TDD, 'PRD-001', state)).toThrow(ProgressionError);
    expect(() => checkNoSkipping(DocumentType.TDD, 'PRD-001', state)).toThrow(
      /must be "approved"/,
    );
  });

  it('rejects when parent not found in state', () => {
    const state = makeState([]);
    expect(() => checkNoSkipping(DocumentType.TDD, 'PRD-MISSING', state)).toThrow(ProgressionError);
    expect(() => checkNoSkipping(DocumentType.TDD, 'PRD-MISSING', state)).toThrow(
      /not found in pipeline state/,
    );
  });

  it('rejects TDD when no parent provided', () => {
    const state = makeState([]);
    expect(() => checkNoSkipping(DocumentType.TDD, null, state)).toThrow(ProgressionError);
    expect(() => checkNoSkipping(DocumentType.TDD, null, state)).toThrow(
      /requires a parent but none provided/,
    );
  });

  it('ProgressionError has SKIP_VIOLATION violation type', () => {
    const state = makeState([
      makeDocState({ documentId: 'PRD-001', type: DocumentType.PRD, status: 'draft' }),
    ]);
    try {
      checkNoSkipping(DocumentType.TDD, 'PRD-001', state);
      fail('Expected ProgressionError');
    } catch (err) {
      expect(err).toBeInstanceOf(ProgressionError);
      expect((err as ProgressionError).violation).toBe('SKIP_VIOLATION');
      expect((err as ProgressionError).name).toBe('ProgressionError');
    }
  });

  it('allows PLAN when parent TDD is approved', () => {
    const state = makeState([
      makeDocState({ documentId: 'TDD-001', type: DocumentType.TDD, status: 'approved' }),
    ]);
    expect(() => checkNoSkipping(DocumentType.PLAN, 'TDD-001', state)).not.toThrow();
  });

  it('rejects SPEC when parent PLAN is in-review', () => {
    const state = makeState([
      makeDocState({ documentId: 'PLAN-001', type: DocumentType.PLAN, status: 'in-review' }),
    ]);
    expect(() => checkNoSkipping(DocumentType.SPEC, 'PLAN-001', state)).toThrow(ProgressionError);
  });
});

describe('checkGateRequired', () => {
  it('allows decomposition of approved document', () => {
    const state = makeState([
      makeDocState({ documentId: 'PRD-001', type: DocumentType.PRD, status: 'approved' }),
    ]);
    expect(() => checkGateRequired('PRD-001', state)).not.toThrow();
  });

  it('rejects decomposition of draft document', () => {
    const state = makeState([
      makeDocState({ documentId: 'PRD-001', type: DocumentType.PRD, status: 'draft' }),
    ]);
    expect(() => checkGateRequired('PRD-001', state)).toThrow(ProgressionError);
    expect(() => checkGateRequired('PRD-001', state)).toThrow(
      /must be approved before decomposition/,
    );
  });

  it('rejects decomposition of in-review document', () => {
    const state = makeState([
      makeDocState({ documentId: 'PRD-001', type: DocumentType.PRD, status: 'in-review' }),
    ]);
    expect(() => checkGateRequired('PRD-001', state)).toThrow(ProgressionError);
  });

  it('rejects when document not found', () => {
    const state = makeState([]);
    expect(() => checkGateRequired('PRD-MISSING', state)).toThrow(ProgressionError);
    expect(() => checkGateRequired('PRD-MISSING', state)).toThrow(/not found/);
  });

  it('ProgressionError has GATE_VIOLATION violation type', () => {
    const state = makeState([
      makeDocState({ documentId: 'PRD-001', type: DocumentType.PRD, status: 'draft' }),
    ]);
    try {
      checkGateRequired('PRD-001', state);
      fail('Expected ProgressionError');
    } catch (err) {
      expect(err).toBeInstanceOf(ProgressionError);
      expect((err as ProgressionError).violation).toBe('GATE_VIOLATION');
    }
  });
});

describe('getReadyParallelSiblings', () => {
  it('returns draft siblings with met dependencies', () => {
    const state = makeState([
      makeDocState({ documentId: 'TDD-001', type: DocumentType.TDD, status: 'draft', blockedBy: [] }),
      makeDocState({ documentId: 'TDD-002', type: DocumentType.TDD, status: 'draft', blockedBy: [] }),
    ]);
    const ready = getReadyParallelSiblings(['TDD-001', 'TDD-002'], state);
    expect(ready).toEqual(['TDD-001', 'TDD-002']);
  });

  it('excludes siblings with unmet dependencies', () => {
    const state = makeState([
      makeDocState({ documentId: 'TDD-001', type: DocumentType.TDD, status: 'draft', blockedBy: [] }),
      makeDocState({ documentId: 'TDD-002', type: DocumentType.TDD, status: 'draft', blockedBy: ['TDD-001'] }),
    ]);
    const ready = getReadyParallelSiblings(['TDD-001', 'TDD-002'], state);
    expect(ready).toEqual(['TDD-001']);
  });

  it('includes siblings whose blockers are approved', () => {
    const state = makeState([
      makeDocState({ documentId: 'TDD-001', type: DocumentType.TDD, status: 'approved', blockedBy: [] }),
      makeDocState({ documentId: 'TDD-002', type: DocumentType.TDD, status: 'draft', blockedBy: ['TDD-001'] }),
    ]);
    const ready = getReadyParallelSiblings(['TDD-001', 'TDD-002'], state);
    // TDD-001 is approved (not draft), so excluded; TDD-002 blocker is approved, so included
    expect(ready).toEqual(['TDD-002']);
  });

  it('excludes non-draft siblings', () => {
    const state = makeState([
      makeDocState({ documentId: 'TDD-001', type: DocumentType.TDD, status: 'in-review', blockedBy: [] }),
      makeDocState({ documentId: 'TDD-002', type: DocumentType.TDD, status: 'approved', blockedBy: [] }),
      makeDocState({ documentId: 'TDD-003', type: DocumentType.TDD, status: 'draft', blockedBy: [] }),
    ]);
    const ready = getReadyParallelSiblings(['TDD-001', 'TDD-002', 'TDD-003'], state);
    expect(ready).toEqual(['TDD-003']);
  });

  it('returns empty array when no siblings are ready', () => {
    const state = makeState([
      makeDocState({ documentId: 'TDD-001', type: DocumentType.TDD, status: 'in-review', blockedBy: [] }),
    ]);
    const ready = getReadyParallelSiblings(['TDD-001'], state);
    expect(ready).toEqual([]);
  });

  it('excludes siblings not found in state', () => {
    const state = makeState([]);
    const ready = getReadyParallelSiblings(['TDD-MISSING'], state);
    expect(ready).toEqual([]);
  });
});

describe('areDependenciesMet', () => {
  it('returns true when no blockers', () => {
    const state = makeState([
      makeDocState({ documentId: 'TDD-001', type: DocumentType.TDD, status: 'draft', blockedBy: [] }),
    ]);
    expect(areDependenciesMet('TDD-001', state)).toBe(true);
  });

  it('returns true when all blockers approved', () => {
    const state = makeState([
      makeDocState({ documentId: 'PRD-001', type: DocumentType.PRD, status: 'approved' }),
      makeDocState({ documentId: 'PRD-002', type: DocumentType.PRD, status: 'approved' }),
      makeDocState({ documentId: 'TDD-001', type: DocumentType.TDD, status: 'draft', blockedBy: ['PRD-001', 'PRD-002'] }),
    ]);
    expect(areDependenciesMet('TDD-001', state)).toBe(true);
  });

  it('returns false when any blocker not approved', () => {
    const state = makeState([
      makeDocState({ documentId: 'PRD-001', type: DocumentType.PRD, status: 'approved' }),
      makeDocState({ documentId: 'PRD-002', type: DocumentType.PRD, status: 'draft' }),
      makeDocState({ documentId: 'TDD-001', type: DocumentType.TDD, status: 'draft', blockedBy: ['PRD-001', 'PRD-002'] }),
    ]);
    expect(areDependenciesMet('TDD-001', state)).toBe(false);
  });

  it('returns false when document not found in state', () => {
    const state = makeState([]);
    expect(areDependenciesMet('TDD-MISSING', state)).toBe(false);
  });

  it('returns false when blocker not found in state', () => {
    const state = makeState([
      makeDocState({ documentId: 'TDD-001', type: DocumentType.TDD, status: 'draft', blockedBy: ['PRD-MISSING'] }),
    ]);
    expect(areDependenciesMet('TDD-001', state)).toBe(false);
  });
});

describe('isPhaseComplete', () => {
  it('returns true when all children approved', () => {
    const state = makeState([
      makeDocState({
        documentId: 'PRD-001',
        type: DocumentType.PRD,
        status: 'approved',
        children: ['TDD-001', 'TDD-002'],
      }),
      makeDocState({ documentId: 'TDD-001', type: DocumentType.TDD, status: 'approved' }),
      makeDocState({ documentId: 'TDD-002', type: DocumentType.TDD, status: 'approved' }),
    ]);
    expect(isPhaseComplete('PRD-001', state)).toBe(true);
  });

  it('returns false when any child not approved', () => {
    const state = makeState([
      makeDocState({
        documentId: 'PRD-001',
        type: DocumentType.PRD,
        status: 'approved',
        children: ['TDD-001', 'TDD-002'],
      }),
      makeDocState({ documentId: 'TDD-001', type: DocumentType.TDD, status: 'approved' }),
      makeDocState({ documentId: 'TDD-002', type: DocumentType.TDD, status: 'in-review' }),
    ]);
    expect(isPhaseComplete('PRD-001', state)).toBe(false);
  });

  it('returns false when parent has no children', () => {
    const state = makeState([
      makeDocState({
        documentId: 'PRD-001',
        type: DocumentType.PRD,
        status: 'approved',
        children: [],
      }),
    ]);
    expect(isPhaseComplete('PRD-001', state)).toBe(false);
  });

  it('returns false when parent not found in state', () => {
    const state = makeState([]);
    expect(isPhaseComplete('PRD-MISSING', state)).toBe(false);
  });

  it('returns false when child not found in state', () => {
    const state = makeState([
      makeDocState({
        documentId: 'PRD-001',
        type: DocumentType.PRD,
        status: 'approved',
        children: ['TDD-MISSING'],
      }),
    ]);
    expect(isPhaseComplete('PRD-001', state)).toBe(false);
  });
});
