import { checkCascadeDepth, DepthLimitResult } from '../../../src/pipeline/cascade/depth-limiter';
import { PipelineConfig, DEFAULT_PIPELINE_CONFIG } from '../../../src/pipeline/types/config';

/**
 * Unit tests for depth-limiter (SPEC-003-5-04, Task 12).
 */

/** Helper: create a config with a specific maxDepth */
function configWithMaxDepth(maxDepth: number): PipelineConfig {
  return {
    ...DEFAULT_PIPELINE_CONFIG,
    backwardCascade: {
      ...DEFAULT_PIPELINE_CONFIG.backwardCascade,
      maxDepth,
    },
  };
}

describe('checkCascadeDepth', () => {
  it('depth 1, maxDepth 2: proceed', () => {
    const result = checkCascadeDepth(1, configWithMaxDepth(2));
    expect(result.action).toBe('proceed');
    expect(result.currentDepth).toBe(1);
    expect(result.maxDepth).toBe(2);
    expect(result.message).toContain('within limits');
  });

  it('depth 2, maxDepth 2: proceed_with_warning', () => {
    const result = checkCascadeDepth(2, configWithMaxDepth(2));
    expect(result.action).toBe('proceed_with_warning');
    expect(result.currentDepth).toBe(2);
    expect(result.maxDepth).toBe(2);
    expect(result.message).toContain('maximum depth');
  });

  it('depth 3, maxDepth 2: escalate', () => {
    const result = checkCascadeDepth(3, configWithMaxDepth(2));
    expect(result.action).toBe('escalate');
    expect(result.currentDepth).toBe(3);
    expect(result.maxDepth).toBe(2);
    expect(result.message).toContain('exceeds maximum');
    expect(result.message).toContain('Human escalation');
  });

  it('depth 1, maxDepth 1: proceed_with_warning', () => {
    const result = checkCascadeDepth(1, configWithMaxDepth(1));
    expect(result.action).toBe('proceed_with_warning');
    expect(result.currentDepth).toBe(1);
    expect(result.maxDepth).toBe(1);
  });

  it('depth 2, maxDepth 1: escalate', () => {
    const result = checkCascadeDepth(2, configWithMaxDepth(1));
    expect(result.action).toBe('escalate');
    expect(result.currentDepth).toBe(2);
    expect(result.maxDepth).toBe(1);
  });

  it('uses configured maxDepth from config', () => {
    const config5 = configWithMaxDepth(5);
    const result1 = checkCascadeDepth(3, config5);
    expect(result1.action).toBe('proceed');
    expect(result1.maxDepth).toBe(5);

    const result2 = checkCascadeDepth(5, config5);
    expect(result2.action).toBe('proceed_with_warning');
    expect(result2.maxDepth).toBe(5);

    const result3 = checkCascadeDepth(6, config5);
    expect(result3.action).toBe('escalate');
    expect(result3.maxDepth).toBe(5);
  });

  it('returns correct DepthLimitResult shape', () => {
    const result: DepthLimitResult = checkCascadeDepth(1, configWithMaxDepth(2));
    expect(result).toHaveProperty('action');
    expect(result).toHaveProperty('currentDepth');
    expect(result).toHaveProperty('maxDepth');
    expect(result).toHaveProperty('message');
    expect(typeof result.action).toBe('string');
    expect(typeof result.currentDepth).toBe('number');
    expect(typeof result.maxDepth).toBe('number');
    expect(typeof result.message).toBe('string');
  });
});
