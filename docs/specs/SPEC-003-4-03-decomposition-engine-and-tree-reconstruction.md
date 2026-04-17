# SPEC-003-4-03: Decomposition Engine Orchestrator and Tree Reconstruction

## Metadata
- **Parent Plan**: PLAN-003-4
- **Tasks Covered**: Task 6, Task 7
- **Estimated effort**: 12 hours

## Description
Implement the decomposition engine orchestrator that coordinates the full decomposition flow (validate parent, check limits, run smoke test, create child documents, write decomposition record, update parent's `traces_to`), and the tree reconstructor that rebuilds the full `DecompositionTree` from stored decomposition records and document frontmatter.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/decomposition/decomposition-engine.ts` | Create |
| `src/pipeline/decomposition/tree-reconstructor.ts` | Create |

## Implementation Details

### Task 6: `src/pipeline/decomposition/decomposition-engine.ts`

```typescript
import { DocumentType, getChildType, getDepth } from '../types/document-type';
import { PipelineConfig } from '../types/config';
import { DocumentStorage } from '../storage/document-storage';
import { CreateDocumentRequest } from '../storage/document-creator';
import { VersioningEngine } from '../versioning/versioning-engine';
import { ProposedChild, SmokeTestResult, DecompositionRecord, writeDecompositionRecord, CoverageMatrixEntry } from './decomposition-record-io';
import { checkDecompositionLimits } from './limits-checker';
import { smokeTest } from './smoke-test';
import { getStrategy } from './strategy-registry';
import { DecompositionTree } from './decomposition-tree';

export type DecompositionErrorType =
  | 'PARENT_NOT_APPROVED'
  | 'INVALID_PARENT'
  | 'NO_CHILD_TYPE'
  | 'SMOKE_TEST_FAILED'
  | 'LIMIT_EXCEEDED'
  | 'CIRCULAR_DEPENDENCY';

export class DecompositionError extends Error {
  constructor(
    public readonly type: DecompositionErrorType,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DecompositionError';
  }
}

export interface DecompositionRequest {
  /** Pipeline ID */
  pipelineId: string;
  /** Parent document ID to decompose */
  parentId: string;
  /** Parent document type */
  parentType: DocumentType;
  /** Proposed children from the decomposition agent */
  proposedChildren: ProposedChild[];
  /** Agent performing the decomposition */
  decompositionAgent: string;
  /** Skip smoke test (only allowed when config.decomposition.smokeTestRequired is false) */
  skipSmokeTest?: boolean;
}

export interface DecompositionResult {
  /** Whether decomposition succeeded */
  success: boolean;
  /** Created child document IDs */
  createdChildren: string[];
  /** Smoke test result (null if skipped) */
  smokeTestResult: SmokeTestResult | null;
  /** Decomposition record */
  record: DecompositionRecord;
  /** Explosion warning triggered */
  explosionWarning: boolean;
}

/**
 * Coordinates the full decomposition flow.
 *
 * Steps (TDD Section 5.4):
 *   1. Validate parent exists and is in "approved" status.
 *   2. Validate parent type has a child type (CODE cannot decompose).
 *   3. Get the decomposition strategy for this transition.
 *   4. Reconstruct current tree and check limits.
 *   5. Validate dependency graph is a DAG (no cycles).
 *   6. Run smoke test (unless skipped).
 *   7. Create all child documents via storage layer.
 *   8. Update parent's traces_to frontmatter with child IDs.
 *   9. Write decomposition record.
 *  10. Return DecompositionResult.
 */
export async function decompose(
  request: DecompositionRequest,
  storage: DocumentStorage,
  config: PipelineConfig,
  currentTree: DecompositionTree,
): Promise<DecompositionResult> {
  // 1. Validate parent exists
  let parentDoc;
  try {
    parentDoc = await storage.readDocument(
      request.pipelineId, request.parentType, request.parentId,
    );
  } catch {
    throw new DecompositionError('INVALID_PARENT', `Parent ${request.parentId} not found`);
  }

  // Validate parent is approved
  if (parentDoc.frontmatter.status !== 'approved') {
    throw new DecompositionError(
      'PARENT_NOT_APPROVED',
      `Parent ${request.parentId} has status "${parentDoc.frontmatter.status}", expected "approved"`,
    );
  }

  // 2. Validate child type exists
  const childType = getChildType(request.parentType);
  if (!childType) {
    throw new DecompositionError(
      'NO_CHILD_TYPE',
      `${request.parentType} documents cannot be decomposed`,
    );
  }

  // 3. Get strategy
  const strategy = getStrategy(request.parentType, childType);

  // 4. Check limits
  const parentDepth = getDepth(request.parentType);
  const limitsResult = checkDecompositionLimits(
    request.proposedChildren.length,
    parentDepth,
    currentTree,
    config,
  );
  if (!limitsResult.passed) {
    throw new DecompositionError(
      'LIMIT_EXCEEDED',
      limitsResult.errors.map(e => e.message).join('; '),
      limitsResult.errors,
    );
  }

  // 5. Validate dependency DAG (build temp tree with proposed children)
  // ... check for cycles among proposed children's dependsOn

  // 6. Run smoke test
  let smokeTestResult: SmokeTestResult | null = null;
  if (!request.skipSmokeTest || config.decomposition.smokeTestRequired) {
    smokeTestResult = await smokeTest(
      request.parentId,
      request.parentType,
      request.pipelineId,
      request.proposedChildren,
      storage,
    );
    if (!smokeTestResult.passed) {
      throw new DecompositionError(
        'SMOKE_TEST_FAILED',
        'Coverage smoke test failed',
        smokeTestResult,
      );
    }
  }

  // 7. Create child documents
  const childDepth = parentDepth + 1;
  const childCount = request.proposedChildren.length;
  const createdChildren: string[] = [];

  for (let i = 0; i < childCount; i++) {
    const proposed = request.proposedChildren[i];
    const createRequest: CreateDocumentRequest = {
      pipelineId: request.pipelineId,
      type: childType,
      title: proposed.title,
      authorAgent: request.decompositionAgent,
      parentId: request.parentId,
      tracesFrom: proposed.tracesFrom,
      depth: childDepth,
      siblingIndex: i,
      siblingCount: childCount,
      dependsOn: proposed.dependsOn,
      dependencyType: proposed.dependsOn.map(() => 'blocks' as const),
      executionMode: proposed.executionMode,
      priority: parentDoc.frontmatter.priority ?? 'normal',
    };

    const handle = await storage.createDocument(createRequest);
    createdChildren.push(handle.documentId);
  }

  // 8. Update parent's traces_to (would need a version update to persist)
  // This is handled by creating a new minor version of the parent
  // with updated traces_to in the frontmatter

  // 9. Build coverage matrix
  const coverageMatrix: CoverageMatrixEntry[] = buildCoverageMatrix(
    request.proposedChildren,
    createdChildren,
  );

  // 10. Write decomposition record
  const record: DecompositionRecord = {
    parentId: request.parentId,
    parentType: request.parentType,
    parentVersion: parentDoc.version,
    childType,
    strategy: strategy.id,
    children: request.proposedChildren.map((p, i) => ({
      ...p,
      id: createdChildren[i],
    })),
    coverageMatrix,
    smokeTestResult,
    createdAt: new Date().toISOString(),
    decompositionAgent: request.decompositionAgent,
  };

  await writeDecompositionRecord(record, request.pipelineId, storage.getDirectoryManager());

  return {
    success: true,
    createdChildren,
    smokeTestResult,
    record,
    explosionWarning: limitsResult.explosionWarning,
  };
}

/**
 * Builds the coverage matrix from proposed children and their created IDs.
 */
function buildCoverageMatrix(
  proposed: ProposedChild[],
  createdIds: string[],
): CoverageMatrixEntry[] {
  const sectionToChildren = new Map<string, string[]>();
  for (let i = 0; i < proposed.length; i++) {
    for (const section of proposed[i].tracesFrom) {
      const list = sectionToChildren.get(section) ?? [];
      list.push(createdIds[i]);
      sectionToChildren.set(section, list);
    }
  }
  return Array.from(sectionToChildren.entries()).map(([section, children]) => ({
    parentSection: section,
    coveredBy: children,
  }));
}
```

### Task 7: `src/pipeline/decomposition/tree-reconstructor.ts`

```typescript
import { DocumentType, PIPELINE_ORDER } from '../types/document-type';
import { DocumentStorage } from '../storage/document-storage';
import { DecompositionTree, DecompositionNode } from './decomposition-tree';
import { readAllDecompositionRecords } from './decomposition-record-io';

/**
 * Rebuilds the full DecompositionTree for a pipeline by reading
 * all decomposition records and document frontmatter.
 *
 * Algorithm:
 *   1. Read all decomposition records from decomposition/ directory.
 *   2. List all documents in the pipeline.
 *   3. For each document: read frontmatter from current.md to get
 *      status, version, depth, parentId, childIds, dependsOn, executionMode.
 *   4. Build DecompositionNode for each document.
 *   5. Add all nodes to the tree.
 *   6. Validate parent-child relationships match decomposition records.
 *
 * @param pipelineId Pipeline ID
 * @param storage Document storage layer
 * @returns Complete DecompositionTree
 */
export async function reconstructTree(
  pipelineId: string,
  storage: DocumentStorage,
): Promise<DecompositionTree> {
  const tree = new DecompositionTree();

  // 1. Read all decomposition records
  const records = await readAllDecompositionRecords(
    pipelineId,
    storage.getDirectoryManager(),
  );

  // 2. Build parent->children map from records
  const parentToChildren = new Map<string, string[]>();
  for (const record of records) {
    parentToChildren.set(
      record.parentId,
      record.children.map(c => c.id),
    );
  }

  // 3. List all documents and build nodes
  const allDocs = await storage.listDocuments(pipelineId);

  for (const doc of allDocs) {
    const childIds = parentToChildren.get(doc.documentId) ?? [];

    const node: DecompositionNode = {
      documentId: doc.documentId,
      type: doc.type,
      status: doc.status,
      version: doc.version,
      depth: doc.depth,
      parentId: doc.parentId,
      childIds,
      dependsOn: [], // will be populated from frontmatter
      executionMode: 'parallel', // will be populated from frontmatter
      siblingIndex: 0,
      siblingCount: 1,
    };

    // Enrich from full document read if needed
    try {
      const fullDoc = await storage.readDocument(pipelineId, doc.type, doc.documentId);
      node.dependsOn = (fullDoc.frontmatter.depends_on as string[]) ?? [];
      node.executionMode = (fullDoc.frontmatter.execution_mode as 'parallel' | 'sequential') ?? 'parallel';
      node.siblingIndex = (fullDoc.frontmatter.sibling_index as number) ?? 0;
      node.siblingCount = (fullDoc.frontmatter.sibling_count as number) ?? 1;
    } catch {
      // If document cannot be read, use defaults from lister
    }

    tree.addNode(node);
  }

  return tree;
}
```

## Acceptance Criteria
1. `decompose` rejects with `PARENT_NOT_APPROVED` if parent status is not "approved".
2. `decompose` rejects with `INVALID_PARENT` if parent document does not exist.
3. `decompose` rejects with `NO_CHILD_TYPE` for CODE documents.
4. `decompose` rejects with `LIMIT_EXCEEDED` when any limit check fails.
5. `decompose` rejects with `SMOKE_TEST_FAILED` when smoke test fails (and is required).
6. `decompose` creates all child documents with correct frontmatter: type, depth, sibling_index, sibling_count, depends_on, traces_from, parent_id, execution_mode, priority.
7. `decompose` writes a decomposition record with correct schema.
8. `decompose` returns `DecompositionResult` with created child IDs, smoke test result, record, and explosion warning.
9. Coverage matrix correctly maps parent sections to child document IDs.
10. `reconstructTree` builds a complete tree from stored records and document frontmatter.
11. `reconstructTree` correctly populates all node fields (type, status, version, depth, parentId, childIds, dependsOn, executionMode).

## Test Cases

### Unit Tests: `tests/pipeline/decomposition/decomposition-engine.test.ts`
- `rejects when parent is not approved`
- `rejects when parent does not exist`
- `rejects when parent is CODE (no child type)`
- `rejects when child limit exceeded`
- `rejects when depth limit exceeded`
- `rejects when total node limit exceeded`
- `rejects when smoke test fails`
- `creates correct number of child documents`
- `child documents have correct type (one level deeper)`
- `child documents have correct depth`
- `child documents have correct sibling_index and sibling_count`
- `child documents have correct traces_from from proposal`
- `child documents have correct depends_on from proposal`
- `child documents inherit parent's priority`
- `coverage matrix maps parent sections to child IDs correctly`
- `decomposition record written with correct schema`
- `returns explosionWarning when threshold exceeded`
- `skips smoke test when config allows and skipSmokeTest is true`

### Unit Tests: `tests/pipeline/decomposition/tree-reconstructor.test.ts`
- `reconstructs tree with single PRD (root only)`
- `reconstructs tree with PRD + 3 TDDs`
- `reconstructs tree with PRD + TDDs + Plans (3 levels)`
- `nodes have correct parent-child relationships`
- `nodes have correct status and version from frontmatter`
- `nodes have correct dependsOn and executionMode`
- `handles empty pipeline (no documents)`
- `handles pipeline with no decomposition records (single root document)`

### Integration Test: `tests/pipeline/decomposition/decomposition.integration.test.ts`
- `create PRD -> approve -> decompose to 3 TDDs -> verify directory structure, decomposition record, tree`
- `decompose with 11 children -> LIMIT_EXCEEDED rejection`
- `decompose with missing coverage -> SMOKE_TEST_FAILED rejection`
- `decompose PRD -> decompose TDD -> reconstruct tree -> tree has 2 levels`
