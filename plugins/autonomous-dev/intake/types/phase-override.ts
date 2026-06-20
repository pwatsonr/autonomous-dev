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
import type { TaskSize } from '../core/task_size_classifier';

// Re-export TaskSize so consumers can import the size vocabulary alongside the
// phase matrices from a single module (#526). The canonical definition lives in
// the pure classifier (`intake/core/task_size_classifier.ts`).
export type { TaskSize } from '../core/task_size_classifier';

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
    // FR-1102: hotfixes skip the full upfront design (PRD + TDD) to reach code
    // fast; the fix itself gets extra scrutiny via enhancedPhases.
    skippedPhases: ['prd', 'prd_review', 'tdd', 'tdd_review'],
    enhancedPhases: ['code'],
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

// ---------------------------------------------------------------------------
// Task-size skip matrix (#526)
// ---------------------------------------------------------------------------

/**
 * TASK_SIZE_SKIP_MATRIX — per-{@link TaskSize} phases to skip, UNIONed with the
 * request type's own `skippedPhases` (see {@link getSkippedPhases}).
 *
 * Conservative first cut (#526):
 *   - `trivial-docs` skips ALL upfront design phases (prd/tdd/plan + their
 *     reviews), leaving intake → spec → spec_review → code → code_review →
 *     integration → deploy → monitor.
 *   - `small` reuses the SAME skip set HOTFIX uses (prd/prd_review/tdd/
 *     tdd_review) so a small change still gets a plan + spec.
 *   - `standard` / `large` skip nothing (no behavior change vs. type-only).
 *
 * This matrix is additive to {@link PHASE_OVERRIDE_MATRIX} and is NOT covered
 * by the phase-matrix snapshot (which locks only the per-type matrix).
 */
export const TASK_SIZE_SKIP_MATRIX: Record<TaskSize, PipelinePhase[]> = {
  'trivial-docs': ['prd', 'prd_review', 'tdd', 'tdd_review', 'plan', 'plan_review'],
  // Mirror HOTFIX's skip set (see PHASE_OVERRIDE_MATRIX[RequestType.HOTFIX]).
  small: ['prd', 'prd_review', 'tdd', 'tdd_review'],
  standard: [],
  large: [],
};

/**
 * Resolve the full set of skipped phases for a (type, size) pair as the UNION
 * of the request type's `skippedPhases` and the task size's skip set (#526).
 *
 * Returns phases in canonical {@link ALL_PIPELINE_PHASES} order, de-duplicated.
 * A defensive new array is returned so callers cannot mutate either matrix.
 *
 * @param type - the request type whose skip set to include.
 * @param size - the task size whose skip set to union in.
 */
export function getSkippedPhases(
  type: RequestType,
  size: TaskSize,
): PipelinePhase[] {
  const union = new Set<PipelinePhase>([
    ...(PHASE_OVERRIDE_MATRIX[type]?.skippedPhases ?? []),
    ...(TASK_SIZE_SKIP_MATRIX[size] ?? []),
  ]);
  // Canonical order, de-duplicated.
  return ALL_PIPELINE_PHASES.filter((p) => union.has(p));
}
