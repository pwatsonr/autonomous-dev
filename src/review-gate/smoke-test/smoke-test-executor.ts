/**
 * Smoke test executor -- orchestrates coverage, scope containment, and
 * contradiction detection checks for decomposition validation.
 *
 * The smoke test validates that a decomposition's children collectively and
 * accurately cover the parent document, catching gaps, scope creep, and
 * contradictions before children enter their own review gates.
 *
 * The executor does NOT manage its own iteration loop internally. It returns
 * the result and the caller (typically the pipeline orchestrator or
 * ReviewGateService) decides whether to request a re-decomposition.
 * The `iteration` and `max_iterations` fields on SmokeTestResult are set
 * by the caller.
 *
 * Based on SPEC-004-4-1 section 5.
 */

import { CoverageChecker } from './coverage-checker';
import { ScopeContainmentChecker } from './scope-containment-checker';
import { ContradictionDetector } from './contradiction-detector';
import {
  ParentDocument,
  ChildDocument,
  SmokeTestConfig,
  SmokeTestResult,
} from './types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: SmokeTestConfig = {
  max_iterations: 2,
  scope_creep_threshold: 20,
};

// ---------------------------------------------------------------------------
// SmokeTestExecutor
// ---------------------------------------------------------------------------

export class SmokeTestExecutor {
  private coverageChecker: CoverageChecker;
  private scopeContainmentChecker: ScopeContainmentChecker;
  private contradictionDetector: ContradictionDetector;

  constructor(
    coverageChecker?: CoverageChecker,
    scopeContainmentChecker?: ScopeContainmentChecker,
    contradictionDetector?: ContradictionDetector
  ) {
    this.coverageChecker = coverageChecker ?? new CoverageChecker();
    this.scopeContainmentChecker = scopeContainmentChecker ?? new ScopeContainmentChecker();
    this.contradictionDetector = contradictionDetector ?? new ContradictionDetector();
  }

  /**
   * Executes all three smoke test checks and assembles the result.
   *
   * overall_pass = coverage.pass AND contradictions.pass
   * Scope containment does NOT block -- it is a warning.
   *
   * The `iteration` and `max_iterations` fields default to 1 and
   * config.max_iterations respectively. The caller should override
   * these on subsequent iterations.
   */
  async execute(
    parent: ParentDocument,
    children: ChildDocument[],
    parentVersion: string,
    config?: Partial<SmokeTestConfig>
  ): Promise<SmokeTestResult> {
    const mergedConfig: SmokeTestConfig = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    // Run all three checks
    const coverage = this.coverageChecker.check(parent, children);
    const scopeContainment = this.scopeContainmentChecker.check(parent, children, {
      creep_threshold_percentage: mergedConfig.scope_creep_threshold,
    });
    const contradictionDetection = await this.contradictionDetector.detect(children);

    // overall_pass = coverage.pass AND contradictions.pass
    // Scope containment does NOT block
    const overallPass = coverage.pass && contradictionDetection.pass;

    const result: SmokeTestResult = {
      smoke_test_id: `smoke-${parent.id}-${Date.now()}`,
      parent_document_id: parent.id,
      parent_document_version: parentVersion,
      child_document_ids: children.map((c) => c.id),
      timestamp: new Date().toISOString(),
      coverage,
      scope_containment: scopeContainment,
      contradiction_detection: contradictionDetection,
      overall_pass: overallPass,
      iteration: 1,
      max_iterations: mergedConfig.max_iterations,
    };

    return result;
  }

  /**
   * Convenience method to determine whether a failed smoke test should
   * be retried.
   *
   * Returns true when the test failed and the current iteration has not
   * yet reached max_iterations.
   */
  shouldRetry(result: SmokeTestResult): boolean {
    return !result.overall_pass && result.iteration < result.max_iterations;
  }
}
