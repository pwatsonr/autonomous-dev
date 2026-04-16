export { decompose, type DecompositionRequest, type DecompositionResult, DecompositionError } from './decomposition-engine';
export { reconstructTree } from './tree-reconstructor';
export { getStrategy, getAllStrategies, type DecompositionStrategy } from './strategy-registry';
export { DecompositionTree, type DecompositionNode } from './decomposition-tree';
export { smokeTest } from './smoke-test';
export { checkDecompositionLimits, type LimitsCheckResult, DecompositionLimitError } from './limits-checker';
export {
  writeDecompositionRecord,
  readDecompositionRecord,
  readAllDecompositionRecords,
  type DecompositionRecord,
  type ProposedChild,
  type SmokeTestResult,
  type CoverageMatrixEntry,
} from './decomposition-record-io';
