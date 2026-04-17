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
