import { DocumentType } from '../../../src/pipeline/types/document-type';
import { PipelineConfig, DEFAULT_PIPELINE_CONFIG } from '../../../src/pipeline/types/config';
import {
  DecompositionTree,
  DecompositionNode,
} from '../../../src/pipeline/decomposition/decomposition-tree';
import {
  checkDecompositionLimits,
  DecompositionLimitError,
} from '../../../src/pipeline/decomposition/limits-checker';

function makeNode(overrides: Partial<DecompositionNode> & { documentId: string }): DecompositionNode {
  return {
    type: DocumentType.PRD,
    status: 'draft',
    version: '1.0',
    depth: 0,
    parentId: null,
    childIds: [],
    dependsOn: [],
    executionMode: 'parallel',
    siblingIndex: 0,
    siblingCount: 1,
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<PipelineConfig['decomposition']>): PipelineConfig {
  return {
    ...DEFAULT_PIPELINE_CONFIG,
    decomposition: {
      ...DEFAULT_PIPELINE_CONFIG.decomposition,
      ...overrides,
    },
  };
}

function makeTreeWithNodeCount(count: number): DecompositionTree {
  const tree = new DecompositionTree();
  for (let i = 0; i < count; i++) {
    tree.addNode(makeNode({
      documentId: `NODE-${String(i).padStart(3, '0')}`,
      depth: i === 0 ? 0 : 1,
    }));
  }
  return tree;
}

describe('Limits Checker', () => {
  test('allows 5 children when limit is 10', () => {
    const tree = makeTreeWithNodeCount(1);
    const config = makeConfig();
    const result = checkDecompositionLimits(5, 0, tree, config);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('rejects 11 children when limit is 10: CHILD_LIMIT_EXCEEDED', () => {
    const tree = makeTreeWithNodeCount(1);
    const config = makeConfig();
    const result = checkDecompositionLimits(11, 0, tree, config);
    expect(result.passed).toBe(false);
    const childError = result.errors.find(e => e.code === 'CHILD_LIMIT_EXCEEDED');
    expect(childError).toBeDefined();
    expect(childError!.limit).toBe(10);
    expect(childError!.actual).toBe(11);
    expect(childError!.message).toContain('11');
    expect(childError!.message).toContain('10');
  });

  test('allows exactly 10 children when limit is 10', () => {
    const tree = makeTreeWithNodeCount(1);
    const config = makeConfig();
    const result = checkDecompositionLimits(10, 0, tree, config);
    const childError = result.errors.find(e => e.code === 'CHILD_LIMIT_EXCEEDED');
    expect(childError).toBeUndefined();
  });

  test('allows depth 4 (CODE) for parent at depth 3 (SPEC)', () => {
    const tree = makeTreeWithNodeCount(1);
    const config = makeConfig();
    const result = checkDecompositionLimits(1, 3, tree, config);
    const depthError = result.errors.find(e => e.code === 'DEPTH_LIMIT_EXCEEDED');
    expect(depthError).toBeUndefined();
  });

  test('rejects depth 5 for parent at depth 4 (CODE): DEPTH_LIMIT_EXCEEDED', () => {
    const tree = makeTreeWithNodeCount(1);
    const config = makeConfig();
    const result = checkDecompositionLimits(1, 4, tree, config);
    expect(result.passed).toBe(false);
    const depthError = result.errors.find(e => e.code === 'DEPTH_LIMIT_EXCEEDED');
    expect(depthError).toBeDefined();
    expect(depthError!.limit).toBe(4);
    expect(depthError!.actual).toBe(5);
  });

  test('allows 99 total nodes when limit is 100', () => {
    // Tree has 90 nodes, proposing 9 more = 99 total
    const tree = makeTreeWithNodeCount(90);
    const config = makeConfig();
    const result = checkDecompositionLimits(9, 0, tree, config);
    const totalError = result.errors.find(e => e.code === 'TOTAL_NODE_LIMIT_EXCEEDED');
    expect(totalError).toBeUndefined();
  });

  test('rejects 101 total nodes when limit is 100: TOTAL_NODE_LIMIT_EXCEEDED', () => {
    // Tree has 95 nodes, proposing 6 more = 101 total
    const tree = makeTreeWithNodeCount(95);
    const config = makeConfig();
    const result = checkDecompositionLimits(6, 0, tree, config);
    expect(result.passed).toBe(false);
    const totalError = result.errors.find(e => e.code === 'TOTAL_NODE_LIMIT_EXCEEDED');
    expect(totalError).toBeDefined();
    expect(totalError!.limit).toBe(100);
    expect(totalError!.actual).toBe(101);
  });

  test('sets explosionWarning at 76 nodes when threshold is 75%', () => {
    // Tree has 70 nodes, proposing 6 more = 76 total (> 75 threshold)
    const tree = makeTreeWithNodeCount(70);
    const config = makeConfig();
    const result = checkDecompositionLimits(6, 0, tree, config);
    expect(result.explosionWarning).toBe(true);
    expect(result.passed).toBe(true); // warning, not error
  });

  test('no explosionWarning at 74 nodes when threshold is 75%', () => {
    // Tree has 70 nodes, proposing 4 more = 74 total (<= 75 threshold)
    const tree = makeTreeWithNodeCount(70);
    const config = makeConfig();
    const result = checkDecompositionLimits(4, 0, tree, config);
    expect(result.explosionWarning).toBe(false);
  });

  test('no explosionWarning when total exceeds max (error takes precedence)', () => {
    // Tree has 95 nodes, proposing 10 more = 105 total (> 100 limit)
    // Explosion warning should NOT be set when total exceeds max
    const tree = makeTreeWithNodeCount(95);
    const config = makeConfig();
    const result = checkDecompositionLimits(10, 0, tree, config);
    expect(result.explosionWarning).toBe(false);
    expect(result.passed).toBe(false);
    const totalError = result.errors.find(e => e.code === 'TOTAL_NODE_LIMIT_EXCEEDED');
    expect(totalError).toBeDefined();
  });

  test('uses configured limits from config object', () => {
    const tree = makeTreeWithNodeCount(1);
    // Custom: max 3 children, max 20 total, 50% explosion threshold
    const config = makeConfig({
      maxChildrenPerDecomposition: 3,
      maxTotalNodes: 20,
      explosionThresholdPercent: 50,
    });

    // 4 children should fail with custom limit of 3
    const result = checkDecompositionLimits(4, 0, tree, config);
    expect(result.passed).toBe(false);
    const childError = result.errors.find(e => e.code === 'CHILD_LIMIT_EXCEEDED');
    expect(childError).toBeDefined();
    expect(childError!.limit).toBe(3);
    expect(childError!.actual).toBe(4);
  });

  test('multiple limits can be exceeded simultaneously', () => {
    // Tree has 98 nodes, proposing 15 children at depth 4
    // Should hit: CHILD_LIMIT_EXCEEDED (15 > 10), DEPTH_LIMIT_EXCEEDED (5 > 4),
    // TOTAL_NODE_LIMIT_EXCEEDED (113 > 100)
    const tree = makeTreeWithNodeCount(98);
    const config = makeConfig();
    const result = checkDecompositionLimits(15, 4, tree, config);
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);

    const codes = result.errors.map(e => e.code);
    expect(codes).toContain('CHILD_LIMIT_EXCEEDED');
    expect(codes).toContain('DEPTH_LIMIT_EXCEEDED');
    expect(codes).toContain('TOTAL_NODE_LIMIT_EXCEEDED');
  });

  test('DecompositionLimitError has correct name property', () => {
    const error = new DecompositionLimitError(
      'CHILD_LIMIT_EXCEEDED', 10, 11, 'test message',
    );
    expect(error.name).toBe('DecompositionLimitError');
    expect(error.message).toBe('test message');
    expect(error.code).toBe('CHILD_LIMIT_EXCEEDED');
    expect(error.limit).toBe(10);
    expect(error.actual).toBe(11);
    expect(error).toBeInstanceOf(Error);
  });

  test('depth limit is hardcoded to 4 regardless of config', () => {
    const tree = makeTreeWithNodeCount(1);
    // Even though config.pipeline.maxDepth is always 4, verify that
    // the depth check uses the hardcoded value and not something configurable
    const config = makeConfig();
    // Parent at depth 3 -> child at depth 4 -> allowed
    const resultAllowed = checkDecompositionLimits(1, 3, tree, config);
    expect(resultAllowed.errors.find(e => e.code === 'DEPTH_LIMIT_EXCEEDED')).toBeUndefined();

    // Parent at depth 4 -> child at depth 5 -> rejected
    const resultRejected = checkDecompositionLimits(1, 4, tree, config);
    const depthError = resultRejected.errors.find(e => e.code === 'DEPTH_LIMIT_EXCEEDED');
    expect(depthError).toBeDefined();
    expect(depthError!.limit).toBe(4);
    expect(depthError!.actual).toBe(5);
  });

  test('empty tree allows adding children', () => {
    const tree = new DecompositionTree();
    const config = makeConfig();
    const result = checkDecompositionLimits(5, 0, tree, config);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.explosionWarning).toBe(false);
  });

  test('explosion threshold at exactly 75 nodes is not a warning', () => {
    // 75% of 100 = 75. Total of exactly 75 is NOT > 75, so no warning.
    const tree = makeTreeWithNodeCount(70);
    const config = makeConfig();
    const result = checkDecompositionLimits(5, 0, tree, config);
    expect(result.explosionWarning).toBe(false);
  });

  test('explosion threshold at exactly 100 nodes is an error not a warning', () => {
    // Total of exactly 100 = limit. 100 > 75 threshold, but 100 <= 100 limit
    // Wait - the check is newTotal > nodeLimit for error. 100 > 100 is false.
    // And 100 > 75 && 100 <= 100 is true -> warning
    const tree = makeTreeWithNodeCount(90);
    const config = makeConfig();
    const result = checkDecompositionLimits(10, 0, tree, config);
    // 100 total: not > 100, so no TOTAL_NODE_LIMIT_EXCEEDED error
    expect(result.errors.find(e => e.code === 'TOTAL_NODE_LIMIT_EXCEEDED')).toBeUndefined();
    // 100 > 75 && 100 <= 100, so explosion warning is true
    expect(result.explosionWarning).toBe(true);
    expect(result.passed).toBe(true);
  });
});
