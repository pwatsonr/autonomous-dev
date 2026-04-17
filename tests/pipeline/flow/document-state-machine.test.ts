import {
  validateTransition,
  getValidTransitions,
  isTerminalState,
  InvalidTransitionError,
} from '../../../src/pipeline/flow/document-state-machine';
import { DocumentStatus } from '../../../src/pipeline/types/frontmatter';

describe('validateTransition', () => {
  // Valid transitions
  it('draft -> in-review: valid', () => {
    expect(validateTransition('draft', 'in-review')).toBe('in-review');
  });

  it('in-review -> approved: valid', () => {
    expect(validateTransition('in-review', 'approved')).toBe('approved');
  });

  it('in-review -> revision-requested: valid', () => {
    expect(validateTransition('in-review', 'revision-requested')).toBe('revision-requested');
  });

  it('in-review -> rejected: valid', () => {
    expect(validateTransition('in-review', 'rejected')).toBe('rejected');
  });

  it('revision-requested -> in-review: valid', () => {
    expect(validateTransition('revision-requested', 'in-review')).toBe('in-review');
  });

  it('approved -> stale: valid', () => {
    expect(validateTransition('approved', 'stale')).toBe('stale');
  });

  it('stale -> approved: valid', () => {
    expect(validateTransition('stale', 'approved')).toBe('approved');
  });

  it('stale -> revision-requested: valid', () => {
    expect(validateTransition('stale', 'revision-requested')).toBe('revision-requested');
  });

  // Any state -> cancelled (except already cancelled)
  it('draft -> cancelled: valid', () => {
    expect(validateTransition('draft', 'cancelled')).toBe('cancelled');
  });

  it('in-review -> cancelled: valid', () => {
    expect(validateTransition('in-review', 'cancelled')).toBe('cancelled');
  });

  it('approved -> cancelled: valid', () => {
    expect(validateTransition('approved', 'cancelled')).toBe('cancelled');
  });

  it('rejected -> cancelled: valid', () => {
    expect(validateTransition('rejected', 'cancelled')).toBe('cancelled');
  });

  // Invalid transitions
  it('approved -> draft: INVALID', () => {
    expect(() => validateTransition('approved', 'draft')).toThrow(InvalidTransitionError);
    expect(() => validateTransition('approved', 'draft')).toThrow(
      'Invalid state transition: approved -> draft',
    );
  });

  it('rejected -> in-review: INVALID', () => {
    expect(() => validateTransition('rejected', 'in-review')).toThrow(InvalidTransitionError);
    expect(() => validateTransition('rejected', 'in-review')).toThrow(
      'Invalid state transition: rejected -> in-review',
    );
  });

  it('draft -> approved: INVALID (cannot skip review)', () => {
    expect(() => validateTransition('draft', 'approved')).toThrow(InvalidTransitionError);
    expect(() => validateTransition('draft', 'approved')).toThrow(
      'Invalid state transition: draft -> approved',
    );
  });

  it('cancelled -> anything: INVALID', () => {
    const allStatuses: DocumentStatus[] = [
      'draft',
      'in-review',
      'approved',
      'revision-requested',
      'rejected',
      'stale',
    ];

    for (const target of allStatuses) {
      expect(() => validateTransition('cancelled', target)).toThrow(InvalidTransitionError);
    }
  });

  it('InvalidTransitionError has from and to properties', () => {
    try {
      validateTransition('approved', 'draft');
      fail('Expected InvalidTransitionError');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      const transErr = err as InvalidTransitionError;
      expect(transErr.from).toBe('approved');
      expect(transErr.to).toBe('draft');
      expect(transErr.name).toBe('InvalidTransitionError');
    }
  });
});

describe('getValidTransitions', () => {
  it('draft returns [in-review, cancelled]', () => {
    const transitions = getValidTransitions('draft');
    expect(transitions).toContain('in-review');
    expect(transitions).toContain('cancelled');
    expect(transitions).toHaveLength(2);
  });

  it('in-review returns [approved, revision-requested, rejected, cancelled]', () => {
    const transitions = getValidTransitions('in-review');
    expect(transitions).toContain('approved');
    expect(transitions).toContain('revision-requested');
    expect(transitions).toContain('rejected');
    expect(transitions).toContain('cancelled');
    expect(transitions).toHaveLength(4);
  });

  it('revision-requested returns [in-review, cancelled]', () => {
    const transitions = getValidTransitions('revision-requested');
    expect(transitions).toContain('in-review');
    expect(transitions).toContain('cancelled');
    expect(transitions).toHaveLength(2);
  });

  it('approved returns [stale, cancelled]', () => {
    const transitions = getValidTransitions('approved');
    expect(transitions).toContain('stale');
    expect(transitions).toContain('cancelled');
    expect(transitions).toHaveLength(2);
  });

  it('rejected returns [cancelled]', () => {
    const transitions = getValidTransitions('rejected');
    expect(transitions).toContain('cancelled');
    expect(transitions).toHaveLength(1);
  });

  it('stale returns [approved, revision-requested, cancelled]', () => {
    const transitions = getValidTransitions('stale');
    expect(transitions).toContain('approved');
    expect(transitions).toContain('revision-requested');
    expect(transitions).toContain('cancelled');
    expect(transitions).toHaveLength(3);
  });

  it('cancelled returns empty array', () => {
    const transitions = getValidTransitions('cancelled');
    expect(transitions).toHaveLength(0);
  });
});

describe('isTerminalState', () => {
  it('rejected is terminal', () => {
    expect(isTerminalState('rejected')).toBe(true);
  });

  it('cancelled is terminal', () => {
    expect(isTerminalState('cancelled')).toBe(true);
  });

  it('approved is NOT terminal', () => {
    expect(isTerminalState('approved')).toBe(false);
  });

  it('draft is NOT terminal', () => {
    expect(isTerminalState('draft')).toBe(false);
  });

  it('in-review is NOT terminal', () => {
    expect(isTerminalState('in-review')).toBe(false);
  });

  it('revision-requested is NOT terminal', () => {
    expect(isTerminalState('revision-requested')).toBe(false);
  });

  it('stale is NOT terminal', () => {
    expect(isTerminalState('stale')).toBe(false);
  });
});
