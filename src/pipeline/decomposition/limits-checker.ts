import { PipelineConfig } from '../types/config';
import { DecompositionTree } from './decomposition-tree';

export type DecompositionErrorCode =
  | 'CHILD_LIMIT_EXCEEDED'
  | 'DEPTH_LIMIT_EXCEEDED'
  | 'EXPLOSION_THRESHOLD'
  | 'TOTAL_NODE_LIMIT_EXCEEDED';

export class DecompositionLimitError extends Error {
  constructor(
    public readonly code: DecompositionErrorCode,
    public readonly limit: number,
    public readonly actual: number,
    message: string,
  ) {
    super(message);
    this.name = 'DecompositionLimitError';
  }
}

export interface LimitsCheckResult {
  passed: boolean;
  errors: DecompositionLimitError[];
  /** True if explosion threshold exceeded (requires human confirmation) */
  explosionWarning: boolean;
}

/**
 * Validates that a proposed decomposition does not exceed configured limits.
 *
 * Checks (TDD Section 3.6.4):
 *   1. CHILD_LIMIT_EXCEEDED: proposedChildCount > config.decomposition.maxChildrenPerDecomposition
 *      Default limit: 10
 *   2. DEPTH_LIMIT_EXCEEDED: parentDepth + 1 >= pipeline maxDepth (hardcoded 4)
 *      Note: depth is 0-based, maxDepth is 4, so depth 4 (CODE) is the max.
 *      A parent at depth 3 (SPEC) can decompose to depth 4 (CODE).
 *      A parent at depth 4 (CODE) CANNOT decompose further.
 *   3. TOTAL_NODE_LIMIT_EXCEEDED: currentTotalNodes + proposedChildCount > config.decomposition.maxTotalNodes
 *      Default limit: 100
 *   4. EXPLOSION_THRESHOLD: currentTotalNodes + proposedChildCount >
 *      config.decomposition.maxTotalNodes * config.decomposition.explosionThresholdPercent / 100
 *      Default: 75% of 100 = 75 nodes. This is a WARNING (requires human confirmation),
 *      not a hard error. But if total exceeds maxTotalNodes, that IS a hard error.
 *
 * @param proposedChildCount Number of children being proposed
 * @param parentDepth Depth of the parent document (0 = PRD)
 * @param currentTree The current decomposition tree (for total node count)
 * @param config Pipeline configuration
 * @returns LimitsCheckResult with errors and explosion warning
 */
export function checkDecompositionLimits(
  proposedChildCount: number,
  parentDepth: number,
  currentTree: DecompositionTree,
  config: PipelineConfig,
): LimitsCheckResult {
  const errors: DecompositionLimitError[] = [];
  let explosionWarning = false;

  // 1. Child limit
  const childLimit = config.decomposition.maxChildrenPerDecomposition;
  if (proposedChildCount > childLimit) {
    errors.push(new DecompositionLimitError(
      'CHILD_LIMIT_EXCEEDED',
      childLimit,
      proposedChildCount,
      `Proposed ${proposedChildCount} children exceeds limit of ${childLimit}`,
    ));
  }

  // 2. Depth limit (hardcoded 4, not configurable)
  const childDepth = parentDepth + 1;
  const maxDepth = 4; // config.pipeline.maxDepth is always 4
  if (childDepth > maxDepth) {
    errors.push(new DecompositionLimitError(
      'DEPTH_LIMIT_EXCEEDED',
      maxDepth,
      childDepth,
      `Child depth ${childDepth} exceeds maximum depth ${maxDepth}`,
    ));
  }

  // 3. Total node limit
  const currentTotal = currentTree.getTotalNodeCount();
  const newTotal = currentTotal + proposedChildCount;
  const nodeLimit = config.decomposition.maxTotalNodes;
  if (newTotal > nodeLimit) {
    errors.push(new DecompositionLimitError(
      'TOTAL_NODE_LIMIT_EXCEEDED',
      nodeLimit,
      newTotal,
      `Total nodes ${newTotal} exceeds limit of ${nodeLimit}`,
    ));
  }

  // 4. Explosion threshold (warning, not error)
  const explosionThreshold = Math.floor(
    nodeLimit * config.decomposition.explosionThresholdPercent / 100,
  );
  if (newTotal > explosionThreshold && newTotal <= nodeLimit) {
    explosionWarning = true;
  }

  return {
    passed: errors.length === 0,
    errors,
    explosionWarning,
  };
}
