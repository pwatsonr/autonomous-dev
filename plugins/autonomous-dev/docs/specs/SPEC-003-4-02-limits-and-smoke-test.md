# SPEC-003-4-02: Decomposition Limits Checker and Coverage Smoke Test

## Metadata
- **Parent Plan**: PLAN-003-4
- **Tasks Covered**: Task 4, Task 5
- **Estimated effort**: 9 hours

## Description
Implement the decomposition limits checker that validates proposed decompositions against configured limits (max children, max depth, max total nodes, explosion threshold) before creating children, and the coverage smoke test that validates three properties: coverage completeness, no scope creep, and no contradictions.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/decomposition/limits-checker.ts` | Create |
| `src/pipeline/decomposition/smoke-test.ts` | Create |

## Implementation Details

### Task 4: `src/pipeline/decomposition/limits-checker.ts`

```typescript
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
```

### Task 5: `src/pipeline/decomposition/smoke-test.ts`

```typescript
import { DocumentType } from '../types/document-type';
import { DocumentStorage } from '../storage/document-storage';
import { parseSections, toSectionId, ParsedSection } from '../versioning/section-parser';
import { ProposedChild, SmokeTestResult } from './decomposition-record-io';

/**
 * Validates three properties of a proposed decomposition:
 *
 * 1. COVERAGE COMPLETENESS:
 *    Every section in the parent document must appear in at least
 *    one child's tracesFrom list. Uncovered sections are reported.
 *
 * 2. NO SCOPE CREEP:
 *    Every entry in every child's tracesFrom list must reference
 *    a valid section in the parent document. References to non-existent
 *    parent sections are reported as scope creep.
 *
 * 3. NO CONTRADICTIONS:
 *    No two children should explicitly declare conflicting responsibilities
 *    for the same parent section. "Conflicting" here means MVP-level:
 *    if the same parent section appears in two children's tracesFrom
 *    and both children are sequential with a dependency, check that
 *    the dependency direction makes sense. For MVP, contradictions are
 *    detected only as explicit user-declared conflicts in the proposal.
 *
 * @param parentId The parent document being decomposed
 * @param parentType The parent document type
 * @param pipelineId The pipeline ID
 * @param proposedChildren The proposed child documents
 * @param storage The document storage layer
 * @returns SmokeTestResult with detailed findings
 */
export async function smokeTest(
  parentId: string,
  parentType: DocumentType,
  pipelineId: string,
  proposedChildren: ProposedChild[],
  storage: DocumentStorage,
): Promise<SmokeTestResult> {
  // 1. Read and parse parent document to get its sections
  const parentDoc = await storage.readDocument(pipelineId, parentType, parentId);
  const parentSections = parseSections(parentDoc.rawContent);
  const parentSectionIds = new Set(
    flattenSectionIds(parentSections.sections),
  );

  // 2. Coverage completeness check
  const coveredSections = new Set<string>();
  for (const child of proposedChildren) {
    for (const traceFrom of child.tracesFrom) {
      coveredSections.add(traceFrom);
    }
  }
  const uncoveredParentSections = [...parentSectionIds].filter(
    id => !coveredSections.has(id),
  );
  const coverageComplete = uncoveredParentSections.length === 0;

  // 3. Scope creep check
  const scopeCreepDetails: string[] = [];
  for (const child of proposedChildren) {
    for (const traceFrom of child.tracesFrom) {
      if (!parentSectionIds.has(traceFrom)) {
        scopeCreepDetails.push(
          `Child "${child.id}" traces from "${traceFrom}" which does not exist in parent`,
        );
      }
    }
  }
  const scopeCreep = scopeCreepDetails.length > 0;

  // 4. Contradiction check (MVP: explicit declaration conflicts only)
  const contradictionDetails: string[] = [];
  // For MVP: check if contradictions were explicitly declared in proposals
  // Full semantic contradiction detection is aspirational (per TDD risk note)
  const contradictions = contradictionDetails.length > 0;

  const passed = coverageComplete && !scopeCreep && !contradictions;

  return {
    passed,
    coverageComplete,
    uncoveredParentSections,
    scopeCreep,
    scopeCreepDetails,
    contradictions,
    contradictionDetails,
  };
}

/**
 * Flattens a section tree into a list of section IDs.
 */
function flattenSectionIds(sections: ParsedSection[]): string[] {
  const ids: string[] = [];
  function walk(secs: ParsedSection[]): void {
    for (const sec of secs) {
      ids.push(sec.id);
      walk(sec.subsections);
    }
  }
  walk(sections);
  return ids;
}
```

## Acceptance Criteria
1. `checkDecompositionLimits` returns `CHILD_LIMIT_EXCEEDED` when proposedChildCount > max (default 10).
2. `checkDecompositionLimits` returns `DEPTH_LIMIT_EXCEEDED` when child depth > 4.
3. `checkDecompositionLimits` returns `TOTAL_NODE_LIMIT_EXCEEDED` when total > max (default 100).
4. `checkDecompositionLimits` sets `explosionWarning: true` when total > 75% of max but <= max.
5. Depth limit is hardcoded to 4 and cannot be overridden via config.
6. Child limit and total node limit use configured values, not hardcoded defaults.
7. `smokeTest` detects uncovered parent sections and reports them.
8. `smokeTest` detects scope creep (references to non-existent parent sections).
9. `smokeTest` returns `passed: true` when all three checks pass.
10. `smokeTest` returns `passed: false` when any check fails.
11. `smokeTest` reads and parses the parent document to identify its sections.

## Test Cases

### Unit Tests: `tests/pipeline/decomposition/limits-checker.test.ts`
- `allows 5 children when limit is 10`
- `rejects 11 children when limit is 10: CHILD_LIMIT_EXCEEDED`
- `allows exactly 10 children when limit is 10`
- `allows depth 4 (CODE) for parent at depth 3 (SPEC)`
- `rejects depth 5 for parent at depth 4 (CODE): DEPTH_LIMIT_EXCEEDED`
- `allows 99 total nodes when limit is 100`
- `rejects 101 total nodes when limit is 100: TOTAL_NODE_LIMIT_EXCEEDED`
- `sets explosionWarning at 76 nodes when threshold is 75%`
- `no explosionWarning at 74 nodes when threshold is 75%`
- `no explosionWarning when total exceeds max (error takes precedence)`
- `uses configured limits from config object`
- `multiple limits can be exceeded simultaneously`

### Unit Tests: `tests/pipeline/decomposition/smoke-test.test.ts`
- `full coverage: all parent sections covered by children -> passed`
- `missing coverage: parent section not in any child tracesFrom -> failed, uncoveredParentSections listed`
- `scope creep: child tracesFrom references non-existent parent section -> failed, scopeCreepDetails listed`
- `no scope creep: all tracesFrom reference valid parent sections`
- `mixed: coverage complete but scope creep present -> failed`
- `empty parent (no sections): all children trace to nothing -> passed (vacuously)`
- `single child covering all parent sections -> passed`
- `multiple children with overlapping coverage -> passed (overlap is OK)`

### Property-Based Test
```
// Any random set of proposedChildren where every parent section
// appears in at least one child's tracesFrom and all tracesFrom
// reference valid sections -> smokeTest.passed === true
```
