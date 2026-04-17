import { checkRegression, RegressionCheckResult } from '../../../src/pipeline/versioning/regression-detector';
import { PipelineConfig, DEFAULT_PIPELINE_CONFIG } from '../../../src/pipeline/types/config';
import { DocumentType } from '../../../src/pipeline/types/document-type';

/**
 * Unit tests for regression-detector (SPEC-003-3-03, Task 6).
 */

/** Creates a config with a given default margin and optional per-type override. */
function makeConfig(overrides: {
  defaultMargin?: number;
  typeMargins?: Partial<Record<DocumentType, number>>;
} = {}): PipelineConfig {
  const config: PipelineConfig = {
    ...DEFAULT_PIPELINE_CONFIG,
    reviewGates: {
      defaults: {
        ...DEFAULT_PIPELINE_CONFIG.reviewGates.defaults,
        regressionMargin: overrides.defaultMargin ?? 5,
      },
      overrides: {},
    },
  };

  if (overrides.typeMargins) {
    for (const [type, margin] of Object.entries(overrides.typeMargins)) {
      config.reviewGates.overrides[type as DocumentType] = {
        regressionMargin: margin,
      };
    }
  }

  return config;
}

describe('checkRegression', () => {
  it('first review (previousScore null): not regression, recommendation proceed', () => {
    const config = makeConfig();
    const result = checkRegression(70, null, config, DocumentType.PRD);

    expect(result.isRegression).toBe(false);
    expect(result.newScore).toBe(70);
    expect(result.previousScore).toBeNull();
    expect(result.scoreDelta).toBeNull();
    expect(result.recommendation).toBe('proceed');
  });

  it('score improved: not regression (90 -> 95, delta=+5)', () => {
    const config = makeConfig();
    const result = checkRegression(95, 90, config, DocumentType.PRD);

    expect(result.isRegression).toBe(false);
    expect(result.scoreDelta).toBe(5);
    expect(result.recommendation).toBe('proceed');
  });

  it('score same: not regression (90 -> 90, delta=0)', () => {
    const config = makeConfig();
    const result = checkRegression(90, 90, config, DocumentType.PRD);

    expect(result.isRegression).toBe(false);
    expect(result.scoreDelta).toBe(0);
    expect(result.recommendation).toBe('proceed');
  });

  it('score dropped within margin: not regression (90 -> 86, delta=-4, margin=5)', () => {
    const config = makeConfig({ defaultMargin: 5 });
    const result = checkRegression(86, 90, config, DocumentType.PRD);

    expect(result.isRegression).toBe(false);
    expect(result.scoreDelta).toBe(-4);
    expect(result.recommendation).toBe('proceed');
  });

  it('score dropped at exact margin: not regression (90 -> 85, delta=-5, margin=5)', () => {
    const config = makeConfig({ defaultMargin: 5 });
    const result = checkRegression(85, 90, config, DocumentType.PRD);

    expect(result.isRegression).toBe(false);
    expect(result.scoreDelta).toBe(-5);
    expect(result.recommendation).toBe('proceed');
  });

  it('score dropped beyond margin: IS regression (90 -> 84, delta=-6, margin=5)', () => {
    const config = makeConfig({ defaultMargin: 5 });
    const result = checkRegression(84, 90, config, DocumentType.PRD);

    expect(result.isRegression).toBe(true);
    expect(result.scoreDelta).toBe(-6);
    expect(result.recommendation).toBe('rollback_suggested');
  });

  it('regression returns rollback_suggested recommendation', () => {
    const config = makeConfig({ defaultMargin: 5 });
    const result = checkRegression(80, 90, config, DocumentType.PRD);

    expect(result.isRegression).toBe(true);
    expect(result.recommendation).toBe('rollback_suggested');
  });

  it('uses per-type margin override when available', () => {
    const config = makeConfig({
      defaultMargin: 5,
      typeMargins: { [DocumentType.TDD]: 10 },
    });

    // With margin=10, a drop of 8 should NOT be a regression
    const result = checkRegression(82, 90, config, DocumentType.TDD);

    expect(result.isRegression).toBe(false);
    expect(result.regressionMargin).toBe(10);
    expect(result.scoreDelta).toBe(-8);
    expect(result.recommendation).toBe('proceed');
  });

  it('uses default margin when no per-type override', () => {
    const config = makeConfig({
      defaultMargin: 5,
      typeMargins: { [DocumentType.TDD]: 10 },
    });

    // PRD has no override, so uses default margin=5
    // A drop of 6 should be a regression with margin=5
    const result = checkRegression(84, 90, config, DocumentType.PRD);

    expect(result.isRegression).toBe(true);
    expect(result.regressionMargin).toBe(5);
    expect(result.scoreDelta).toBe(-6);
    expect(result.recommendation).toBe('rollback_suggested');
  });

  it('zero previous score: score increase is not regression', () => {
    const config = makeConfig();
    const result = checkRegression(50, 0, config, DocumentType.PRD);

    expect(result.isRegression).toBe(false);
    expect(result.scoreDelta).toBe(50);
    expect(result.recommendation).toBe('proceed');
  });

  it('handles perfect score (100) correctly', () => {
    const config = makeConfig({ defaultMargin: 5 });

    // Perfect score maintained
    const same = checkRegression(100, 100, config, DocumentType.PRD);
    expect(same.isRegression).toBe(false);
    expect(same.scoreDelta).toBe(0);

    // Perfect to 95: delta=-5, at margin, NOT regression
    const atMargin = checkRegression(95, 100, config, DocumentType.PRD);
    expect(atMargin.isRegression).toBe(false);
    expect(atMargin.scoreDelta).toBe(-5);

    // Perfect to 94: delta=-6, beyond margin, IS regression
    const beyondMargin = checkRegression(94, 100, config, DocumentType.PRD);
    expect(beyondMargin.isRegression).toBe(true);
    expect(beyondMargin.scoreDelta).toBe(-6);
  });
});
