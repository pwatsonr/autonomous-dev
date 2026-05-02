/**
 * PipelinePhase + PhaseOverrideConfig + PHASE_OVERRIDE_MATRIX + helpers
 * (SPEC-018-1-01, Task 2).
 *
 * Encodes the per-RequestType pipeline customization: which phases are
 * skipped, which are enhanced, whether reviews are expedited, what extra
 * gates apply, retry budget, and per-phase timeouts.
 *
 * Canonical source: TDD-018 §5.2. The matrix below MUST match the TDD
 * byte-for-byte. A snapshot test in `__tests__/types/phase-matrix.snapshot.test.ts`
 * locks the shape; intentional changes require updating both the TDD and
 * the snapshot in lockstep.
 *
 * Note: a separate `PipelinePhase` string union exists in
 * `intake/notifications/formatters/cli_formatter.ts` for display/formatting
 * use. That union is for runtime status (`'queued'`, `'paused'`, etc.) and
 * is intentionally distinct from the canonical pipeline-stage enum below
 * (which models the workflow phases the orchestrator drives).
 *
 * @module intake/types/phase-override
 */

import { RequestType } from './request-type';

/**
 * Ordered identifiers for the canonical autonomous-dev pipeline phases.
 * The full feature pipeline runs all 14 in this order. Other request types
 * may skip a subset (see {@link PHASE_OVERRIDE_MATRIX}).
 */
export type PipelinePhase =
  | 'intake'
  | 'prd' | 'prd_review'
  | 'tdd' | 'tdd_review'
  | 'plan' | 'plan_review'
  | 'spec' | 'spec_review'
  | 'code' | 'code_review'
  | 'integration' | 'deploy' | 'monitor';

/** Iteration-friendly array form of {@link PipelinePhase}, in canonical order. */
export const ALL_PIPELINE_PHASES: readonly PipelinePhase[] = [
  'intake',
  'prd', 'prd_review',
  'tdd', 'tdd_review',
  'plan', 'plan_review',
  'spec', 'spec_review',
  'code', 'code_review',
  'integration', 'deploy', 'monitor',
] as const;

/**
 * Per-type pipeline customization. Canonical source: TDD-018 §5.2.
 *
 * `phaseTimeouts` is intentionally `Record<string, number>` (not
 * `Record<PipelinePhase, number>`) per TDD-018 §5.2 to allow non-phase
 * keys that may not be in the canonical phase enum in future revisions.
 */
export interface PhaseOverrideConfig {
  skippedPhases: PipelinePhase[];
  enhancedPhases: PipelinePhase[];
  expeditedReviews: boolean;
  additionalGates: string[];
  maxRetries: number;
  phaseTimeouts: Record<string, number>;
}

/**
 * PHASE_OVERRIDE_MATRIX — canonical per-RequestType pipeline configuration.
 * MUST match TDD-018 §5.2 byte-for-byte. See module-level note on snapshot
 * test enforcement.
 */
export const PHASE_OVERRIDE_MATRIX: Record<RequestType, PhaseOverrideConfig> = {
  [RequestType.FEATURE]: {
    skippedPhases: [],
    enhancedPhases: [],
    expeditedReviews: false,
    additionalGates: [],
    maxRetries: 3,
    phaseTimeouts: {},
  },
  [RequestType.BUG]: {
    skippedPhases: ['prd', 'prd_review'],
    enhancedPhases: ['code', 'code_review'],
    expeditedReviews: true,
    additionalGates: ['regression_test_validation'],
    maxRetries: 5,
    phaseTimeouts: { tdd: 30, code: 60 },
  },
  [RequestType.INFRA]: {
    skippedPhases: [],
    enhancedPhases: ['tdd', 'tdd_review', 'plan', 'plan_review'],
    expeditedReviews: false,
    additionalGates: ['security_review', 'cost_analysis', 'rollback_plan'],
    maxRetries: 2,
    phaseTimeouts: { tdd: 120, plan: 90 },
  },
  [RequestType.REFACTOR]: {
    skippedPhases: ['prd', 'prd_review'],
    enhancedPhases: ['code', 'code_review'],
    expeditedReviews: true,
    additionalGates: ['code_quality_metrics', 'performance_benchmarks'],
    maxRetries: 3,
    phaseTimeouts: { code: 90 },
  },
  [RequestType.HOTFIX]: {
    skippedPhases: ['prd', 'prd_review', 'plan_review'],
    enhancedPhases: ['tdd', 'code'],
    expeditedReviews: true,
    additionalGates: ['incident_correlation', 'rollback_validation'],
    maxRetries: 5,
    phaseTimeouts: { tdd: 15, code: 30, deploy: 10 },
  },
};

/**
 * Resolves the ordered phase list for a given request type.
 *
 * Re-derives order from {@link ALL_PIPELINE_PHASES} (rather than from
 * `Object.keys`) to guarantee deterministic ordering across V8 versions.
 */
export function getPhaseSequence(requestType: RequestType): PipelinePhase[] {
  const skipped = new Set(PHASE_OVERRIDE_MATRIX[requestType].skippedPhases);
  return ALL_PIPELINE_PHASES.filter((p) => !skipped.has(p));
}

/** Whether a phase has enhanced validation gates for the given request type. */
export function isEnhancedPhase(
  requestType: RequestType,
  phase: PipelinePhase,
): boolean {
  return PHASE_OVERRIDE_MATRIX[requestType].enhancedPhases.includes(phase);
}

/**
 * Additional gates required for a request type (e.g., `security_review`).
 * Returns a defensive copy so callers cannot mutate the matrix.
 */
export function getAdditionalGates(requestType: RequestType): string[] {
  return [...PHASE_OVERRIDE_MATRIX[requestType].additionalGates];
}
