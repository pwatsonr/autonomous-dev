/**
 * Unit tests for `intake/types/request-type.ts` and `phase-override.ts`
 * (SPEC-018-1-04, Task 8 — covers SPEC-018-1-01).
 *
 * @module __tests__/types/request-type.test
 */

import {
  DEFAULT_REQUEST_TYPE,
  REQUEST_TYPES,
  RequestType,
  isValidRequestType,
} from '../../types/request-type';
import {
  ALL_PIPELINE_PHASES,
  PHASE_OVERRIDE_MATRIX,
  type PipelinePhase,
  getAdditionalGates,
  getPhaseSequence,
  isEnhancedPhase,
} from '../../types/phase-override';

// ---------------------------------------------------------------------------
// RequestType
// ---------------------------------------------------------------------------

describe('RequestType', () => {
  test('has exactly 5 members with lowercase string values', () => {
    expect(RequestType.FEATURE).toBe('feature');
    expect(RequestType.BUG).toBe('bug');
    expect(RequestType.INFRA).toBe('infra');
    expect(RequestType.REFACTOR).toBe('refactor');
    expect(RequestType.HOTFIX).toBe('hotfix');
    expect(Object.values(RequestType)).toHaveLength(5);
  });

  test('REQUEST_TYPES lists all 5 in declaration order', () => {
    expect(REQUEST_TYPES).toEqual([
      'feature', 'bug', 'infra', 'refactor', 'hotfix',
    ]);
  });

  test('DEFAULT_REQUEST_TYPE === RequestType.FEATURE', () => {
    expect(DEFAULT_REQUEST_TYPE).toBe(RequestType.FEATURE);
  });
});

describe('isValidRequestType()', () => {
  test('returns true for each of the 5 valid string values', () => {
    expect(isValidRequestType('feature')).toBe(true);
    expect(isValidRequestType('bug')).toBe(true);
    expect(isValidRequestType('infra')).toBe(true);
    expect(isValidRequestType('refactor')).toBe(true);
    expect(isValidRequestType('hotfix')).toBe(true);
  });

  test('returns false for unknown / casing-variant / empty strings', () => {
    expect(isValidRequestType('xyz')).toBe(false);
    expect(isValidRequestType('')).toBe(false);
    expect(isValidRequestType('FEATURE')).toBe(false);
    expect(isValidRequestType('Bug')).toBe(false);
    expect(isValidRequestType('feat')).toBe(false);
  });

  test('returns false for non-string runtime values (cast through any)', () => {
    // The signature requires `string`; casting models real-world untyped JSON.
    expect(isValidRequestType(null as unknown as string)).toBe(false);
    expect(isValidRequestType(undefined as unknown as string)).toBe(false);
    expect(isValidRequestType(42 as unknown as string)).toBe(false);
  });

  test('narrows the parameter to RequestType when used as a guard', () => {
    const v: string = 'bug';
    if (isValidRequestType(v)) {
      const narrowed: RequestType = v;
      expect(narrowed).toBe(RequestType.BUG);
    } else {
      throw new Error('expected isValidRequestType to accept "bug"');
    }
  });
});

// ---------------------------------------------------------------------------
// Pipeline phases & PHASE_OVERRIDE_MATRIX
// ---------------------------------------------------------------------------

describe('ALL_PIPELINE_PHASES', () => {
  test('has 14 canonical phases in TDD-018 order', () => {
    expect(ALL_PIPELINE_PHASES).toEqual([
      'intake',
      'prd', 'prd_review',
      'tdd', 'tdd_review',
      'plan', 'plan_review',
      'spec', 'spec_review',
      'code', 'code_review',
      'integration', 'deploy', 'monitor',
    ]);
  });
});

describe('PHASE_OVERRIDE_MATRIX', () => {
  test('has entries for all 5 RequestType values; no extras', () => {
    expect(Object.keys(PHASE_OVERRIDE_MATRIX).sort()).toEqual([
      'bug', 'feature', 'hotfix', 'infra', 'refactor',
    ]);
  });

  test('each entry has the 6 PhaseOverrideConfig fields', () => {
    for (const cfg of Object.values(PHASE_OVERRIDE_MATRIX)) {
      expect(cfg).toEqual(expect.objectContaining({
        skippedPhases: expect.any(Array),
        enhancedPhases: expect.any(Array),
        expeditedReviews: expect.any(Boolean),
        additionalGates: expect.any(Array),
        maxRetries: expect.any(Number),
        phaseTimeouts: expect.any(Object),
      }));
    }
  });
});

// ---------------------------------------------------------------------------
// getPhaseSequence
// ---------------------------------------------------------------------------

describe('getPhaseSequence()', () => {
  test('FEATURE returns all 14 phases in canonical order', () => {
    expect(getPhaseSequence(RequestType.FEATURE)).toEqual([...ALL_PIPELINE_PHASES]);
    expect(getPhaseSequence(RequestType.FEATURE)).toHaveLength(14);
  });

  test('BUG returns 12 phases excluding prd, prd_review', () => {
    const seq = getPhaseSequence(RequestType.BUG);
    expect(seq).toHaveLength(12);
    expect(seq).not.toContain('prd');
    expect(seq).not.toContain('prd_review');
  });

  test('INFRA returns all 14 phases (skips none)', () => {
    expect(getPhaseSequence(RequestType.INFRA)).toHaveLength(14);
  });

  test('REFACTOR returns 12 phases excluding prd, prd_review', () => {
    const seq = getPhaseSequence(RequestType.REFACTOR);
    expect(seq).toHaveLength(12);
    expect(seq).not.toContain('prd');
    expect(seq).not.toContain('prd_review');
  });

  test('HOTFIX returns 11 phases excluding prd, prd_review, plan_review', () => {
    const seq = getPhaseSequence(RequestType.HOTFIX);
    expect(seq).toHaveLength(11);
    expect(seq).not.toContain('prd');
    expect(seq).not.toContain('prd_review');
    expect(seq).not.toContain('plan_review');
  });
});

// ---------------------------------------------------------------------------
// isEnhancedPhase
// ---------------------------------------------------------------------------

describe('isEnhancedPhase()', () => {
  test('positive cases: one per type', () => {
    expect(isEnhancedPhase(RequestType.BUG, 'code')).toBe(true);
    expect(isEnhancedPhase(RequestType.INFRA, 'tdd')).toBe(true);
    expect(isEnhancedPhase(RequestType.REFACTOR, 'code_review')).toBe(true);
    expect(isEnhancedPhase(RequestType.HOTFIX, 'tdd')).toBe(true);
    expect(isEnhancedPhase(RequestType.HOTFIX, 'code')).toBe(true);
  });

  test('FEATURE has no enhanced phases', () => {
    for (const phase of ALL_PIPELINE_PHASES) {
      expect(isEnhancedPhase(RequestType.FEATURE, phase as PipelinePhase)).toBe(false);
    }
  });

  test('negative cases', () => {
    expect(isEnhancedPhase(RequestType.BUG, 'tdd')).toBe(false);
    expect(isEnhancedPhase(RequestType.INFRA, 'code')).toBe(false);
    expect(isEnhancedPhase(RequestType.REFACTOR, 'tdd')).toBe(false);
    expect(isEnhancedPhase(RequestType.HOTFIX, 'plan')).toBe(false);
    expect(isEnhancedPhase(RequestType.FEATURE, 'intake')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAdditionalGates
// ---------------------------------------------------------------------------

describe('getAdditionalGates()', () => {
  test('FEATURE returns []', () => {
    expect(getAdditionalGates(RequestType.FEATURE)).toEqual([]);
  });

  test('BUG returns [regression_test_validation]', () => {
    expect(getAdditionalGates(RequestType.BUG)).toEqual(['regression_test_validation']);
  });

  test('INFRA returns 3 gates in canonical order', () => {
    expect(getAdditionalGates(RequestType.INFRA)).toEqual([
      'security_review', 'cost_analysis', 'rollback_plan',
    ]);
  });

  test('REFACTOR returns [code_quality_metrics, performance_benchmarks]', () => {
    expect(getAdditionalGates(RequestType.REFACTOR)).toEqual([
      'code_quality_metrics', 'performance_benchmarks',
    ]);
  });

  test('HOTFIX returns [incident_correlation, rollback_validation]', () => {
    expect(getAdditionalGates(RequestType.HOTFIX)).toEqual([
      'incident_correlation', 'rollback_validation',
    ]);
  });

  test('returns a defensive copy (caller mutation does not affect matrix)', () => {
    const gates = getAdditionalGates(RequestType.INFRA);
    expect(gates).not.toBe(PHASE_OVERRIDE_MATRIX[RequestType.INFRA].additionalGates);
    gates.push('mutation_attempt');
    expect(PHASE_OVERRIDE_MATRIX[RequestType.INFRA].additionalGates).toEqual([
      'security_review', 'cost_analysis', 'rollback_plan',
    ]);
  });
});
