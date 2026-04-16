import { PipelineConfig } from '../types/config';

export type DepthLimitAction = 'proceed' | 'proceed_with_warning' | 'escalate';

export interface DepthLimitResult {
  action: DepthLimitAction;
  currentDepth: number;
  maxDepth: number;
  message: string;
}

/**
 * Enforces cascade depth limits.
 *
 * Rules (TDD Section 3.8.4):
 *   Depth 1 (direct parent): automatic, no warning.
 *   Depth 2 (grandparent): automatic with warning logged.
 *   Depth 3+: escalate to human.
 *
 * Default maxDepth: 2 (configurable via backward_cascade.max_depth).
 *
 * @param currentDepth The current cascade depth (1 = direct parent revision)
 * @param config Pipeline configuration
 * @returns DepthLimitResult with action recommendation
 */
export function checkCascadeDepth(
  currentDepth: number,
  config: PipelineConfig,
): DepthLimitResult {
  const maxDepth = config.backwardCascade.maxDepth;

  if (currentDepth > maxDepth) {
    return {
      action: 'escalate',
      currentDepth,
      maxDepth,
      message: `Cascade depth ${currentDepth} exceeds maximum ${maxDepth}. Human escalation required.`,
    };
  }

  if (currentDepth === maxDepth) {
    return {
      action: 'proceed_with_warning',
      currentDepth,
      maxDepth,
      message: `Cascade at maximum depth ${currentDepth}/${maxDepth}. Proceeding with warning.`,
    };
  }

  return {
    action: 'proceed',
    currentDepth,
    maxDepth,
    message: `Cascade depth ${currentDepth} within limits.`,
  };
}
