import { DocumentType, getDepth } from '../../../src/pipeline/types/document-type';
import { PipelineConfig, DEFAULT_PIPELINE_CONFIG } from '../../../src/pipeline/types/config';
import { DocumentStorage } from '../../../src/pipeline/storage/document-storage';
import { DocumentContent } from '../../../src/pipeline/storage/document-reader';
import { DocumentHandle } from '../../../src/pipeline/storage/document-creator';
import {
  DecompositionTree,
  DecompositionNode,
} from '../../../src/pipeline/decomposition/decomposition-tree';
import {
  decompose,
  DecompositionRequest,
  DecompositionError,
} from '../../../src/pipeline/decomposition/decomposition-engine';
import { ProposedChild, SmokeTestResult } from '../../../src/pipeline/decomposition/decomposition-record-io';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeConfig(overrides?: Partial<PipelineConfig['decomposition']>): PipelineConfig {
  return {
    ...DEFAULT_PIPELINE_CONFIG,
    decomposition: {
      ...DEFAULT_PIPELINE_CONFIG.decomposition,
      ...overrides,
    },
  };
}

function makeChild(overrides: Partial<ProposedChild> & { id: string }): ProposedChild {
  return {
    title: `Child ${overrides.id}`,
    tracesFrom: [],
    executionMode: 'parallel',
    dependsOn: [],
    ...overrides,
  };
}

/**
 * Builds a parent document content response with configurable status and priority.
 */
function makeParentContent(overrides?: {
  status?: string;
  priority?: string;
  type?: DocumentType;
}): DocumentContent {
  const status = overrides?.status ?? 'approved';
  const priority = overrides?.priority ?? 'normal';
  const type = overrides?.type ?? DocumentType.PRD;
  return {
    frontmatter: {
      id: 'PRD-001',
      title: 'Test PRD',
      pipeline_id: 'pipeline-1',
      type,
      status: status as any,
      version: '1.0',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      author_agent: 'agent-prd-writer',
      parent_id: null,
      traces_from: [],
      traces_to: [],
      depth: getDepth(type),
      sibling_index: 0,
      sibling_count: 1,
      depends_on: [],
      dependency_type: [],
      execution_mode: 'sequential',
      priority: priority as any,
    },
    body: '## Overview\nSome content\n\n## Requirements\nSome requirements',
    rawContent: '---\nid: PRD-001\nstatus: ' + status + '\n---\n## Overview\nSome content\n\n## Requirements\nSome requirements',
    version: '1.0',
    filePath: '/mock/PRD-001/v1.0.md',
  };
}

/**
 * Builds a passing SmokeTestResult.
 */
function passingSmokeTestResult(): SmokeTestResult {
  return {
    passed: true,
    coverageComplete: true,
    uncoveredParentSections: [],
    scopeCreep: false,
    scopeCreepDetails: [],
    contradictions: false,
    contradictionDetails: [],
  };
}

/**
 * Builds a failing SmokeTestResult.
 */
function failingSmokeTestResult(): SmokeTestResult {
  return {
    passed: false,
    coverageComplete: false,
    uncoveredParentSections: ['overview'],
    scopeCreep: false,
    scopeCreepDetails: [],
    contradictions: false,
    contradictionDetails: [],
  };
}

let createDocumentCallCount = 0;

/**
 * Creates a mock DocumentStorage.
 */
function mockStorage(opts?: {
  parentContent?: DocumentContent | null;
  readDocumentFn?: jest.Mock;
  createDocumentFn?: jest.Mock;
  smokeTestResult?: SmokeTestResult;
}): DocumentStorage {
  createDocumentCallCount = 0;

  const readDocumentFn = opts?.readDocumentFn ?? jest.fn().mockImplementation(
    async (_pipelineId: string, _type: DocumentType, _docId: string) => {
      if (opts?.parentContent === null) {
        throw new Error('Document not found');
      }
      return opts?.parentContent ?? makeParentContent();
    },
  );

  const createDocumentFn = opts?.createDocumentFn ?? jest.fn().mockImplementation(
    async (req: any): Promise<DocumentHandle> => {
      createDocumentCallCount++;
      const docId = `${req.type}-001-${String(createDocumentCallCount).padStart(2, '0')}`;
      return {
        documentId: docId,
        pipelineId: req.pipelineId,
        type: req.type,
        version: '1.0',
        filePath: `/mock/${docId}/v1.0.md`,
        symlinkPath: `/mock/${docId}/current.md`,
        documentDir: `/mock/${docId}`,
      };
    },
  );

  return {
    readDocument: readDocumentFn,
    createDocument: createDocumentFn,
    getDirectoryManager: jest.fn().mockReturnValue({
      getDecompositionDir: jest.fn().mockReturnValue('/mock/decomposition'),
    }),
    listDocuments: jest.fn().mockResolvedValue([]),
  } as unknown as DocumentStorage;
}

// Mock writeDecompositionRecord
jest.mock('../../../src/pipeline/decomposition/decomposition-record-io', () => {
  const actual = jest.requireActual('../../../src/pipeline/decomposition/decomposition-record-io');
  return {
    ...actual,
    writeDecompositionRecord: jest.fn().mockResolvedValue('/mock/decomposition/PRD-001-decomposition.yaml'),
  };
});

// Mock smokeTest
jest.mock('../../../src/pipeline/decomposition/smoke-test', () => ({
  smokeTest: jest.fn(),
}));

import { smokeTest } from '../../../src/pipeline/decomposition/smoke-test';
import { writeDecompositionRecord } from '../../../src/pipeline/decomposition/decomposition-record-io';

const mockedSmokeTest = smokeTest as jest.MockedFunction<typeof smokeTest>;
const mockedWriteRecord = writeDecompositionRecord as jest.MockedFunction<typeof writeDecompositionRecord>;

function makeRequest(overrides?: Partial<DecompositionRequest>): DecompositionRequest {
  return {
    pipelineId: 'pipeline-1',
    parentId: 'PRD-001',
    parentType: DocumentType.PRD,
    proposedChildren: [
      makeChild({ id: 'TDD-001-01', title: 'TDD Alpha', tracesFrom: ['overview'] }),
      makeChild({ id: 'TDD-001-02', title: 'TDD Beta', tracesFrom: ['requirements'] }),
    ],
    decompositionAgent: 'agent-decomposer',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Decomposition Engine', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createDocumentCallCount = 0;
    mockedSmokeTest.mockResolvedValue(passingSmokeTestResult());
  });

  // --- Rejection cases ---

  test('rejects when parent is not approved', async () => {
    const storage = mockStorage({
      parentContent: makeParentContent({ status: 'draft' }),
    });
    const config = makeConfig();
    const tree = makeTreeWithNodeCount(1);

    await expect(
      decompose(makeRequest(), storage, config, tree),
    ).rejects.toThrow(DecompositionError);

    try {
      await decompose(makeRequest(), storage, config, tree);
    } catch (err) {
      expect(err).toBeInstanceOf(DecompositionError);
      expect((err as DecompositionError).type).toBe('PARENT_NOT_APPROVED');
      expect((err as DecompositionError).message).toContain('PRD-001');
      expect((err as DecompositionError).message).toContain('draft');
    }
  });

  test('rejects when parent does not exist', async () => {
    const storage = mockStorage({ parentContent: null });
    const config = makeConfig();
    const tree = makeTreeWithNodeCount(1);

    await expect(
      decompose(makeRequest(), storage, config, tree),
    ).rejects.toThrow(DecompositionError);

    try {
      await decompose(makeRequest(), storage, config, tree);
    } catch (err) {
      expect(err).toBeInstanceOf(DecompositionError);
      expect((err as DecompositionError).type).toBe('INVALID_PARENT');
    }
  });

  test('rejects when parent is CODE (no child type)', async () => {
    const storage = mockStorage({
      parentContent: makeParentContent({ status: 'approved', type: DocumentType.CODE }),
    });
    const config = makeConfig();
    const tree = makeTreeWithNodeCount(1);

    await expect(
      decompose(
        makeRequest({ parentType: DocumentType.CODE, parentId: 'CODE-001' }),
        storage,
        config,
        tree,
      ),
    ).rejects.toThrow(DecompositionError);

    try {
      await decompose(
        makeRequest({ parentType: DocumentType.CODE, parentId: 'CODE-001' }),
        storage,
        config,
        tree,
      );
    } catch (err) {
      expect(err).toBeInstanceOf(DecompositionError);
      expect((err as DecompositionError).type).toBe('NO_CHILD_TYPE');
    }
  });

  test('rejects when child limit exceeded', async () => {
    const storage = mockStorage();
    const config = makeConfig({ maxChildrenPerDecomposition: 2 });
    const tree = makeTreeWithNodeCount(1);

    // Propose 3 children with limit of 2
    const children = [
      makeChild({ id: 'TDD-001-01', title: 'A', tracesFrom: ['overview'] }),
      makeChild({ id: 'TDD-001-02', title: 'B', tracesFrom: ['requirements'] }),
      makeChild({ id: 'TDD-001-03', title: 'C', tracesFrom: ['nfr'] }),
    ];

    await expect(
      decompose(
        makeRequest({ proposedChildren: children }),
        storage,
        config,
        tree,
      ),
    ).rejects.toThrow(DecompositionError);

    try {
      await decompose(makeRequest({ proposedChildren: children }), storage, config, tree);
    } catch (err) {
      expect((err as DecompositionError).type).toBe('LIMIT_EXCEEDED');
    }
  });

  test('rejects when depth limit exceeded', async () => {
    const storage = mockStorage({
      parentContent: makeParentContent({ status: 'approved', type: DocumentType.CODE }),
    });
    const config = makeConfig();
    const tree = makeTreeWithNodeCount(1);

    // CODE is at depth 4; trying to decompose further would go to depth 5
    await expect(
      decompose(
        makeRequest({ parentType: DocumentType.CODE }),
        storage,
        config,
        tree,
      ),
    ).rejects.toThrow(DecompositionError);
  });

  test('rejects when total node limit exceeded', async () => {
    const storage = mockStorage();
    const config = makeConfig({ maxTotalNodes: 5 });
    const tree = makeTreeWithNodeCount(4);

    // 4 existing + 2 proposed = 6 > limit 5
    await expect(
      decompose(makeRequest(), storage, config, tree),
    ).rejects.toThrow(DecompositionError);

    try {
      await decompose(makeRequest(), storage, config, tree);
    } catch (err) {
      expect((err as DecompositionError).type).toBe('LIMIT_EXCEEDED');
    }
  });

  test('rejects when smoke test fails', async () => {
    const storage = mockStorage();
    const config = makeConfig({ smokeTestRequired: true });
    const tree = makeTreeWithNodeCount(1);

    mockedSmokeTest.mockResolvedValue(failingSmokeTestResult());

    await expect(
      decompose(makeRequest(), storage, config, tree),
    ).rejects.toThrow(DecompositionError);

    try {
      await decompose(makeRequest(), storage, config, tree);
    } catch (err) {
      expect((err as DecompositionError).type).toBe('SMOKE_TEST_FAILED');
      expect((err as DecompositionError).details).toBeDefined();
    }
  });

  // --- Success cases ---

  test('creates correct number of child documents', async () => {
    const storage = mockStorage();
    const config = makeConfig();
    const tree = makeTreeWithNodeCount(1);

    const result = await decompose(makeRequest(), storage, config, tree);

    expect(result.success).toBe(true);
    expect(result.createdChildren).toHaveLength(2);
    expect(storage.createDocument).toHaveBeenCalledTimes(2);
  });

  test('child documents have correct type (one level deeper)', async () => {
    const storage = mockStorage();
    const config = makeConfig();
    const tree = makeTreeWithNodeCount(1);

    await decompose(makeRequest(), storage, config, tree);

    const calls = (storage.createDocument as jest.Mock).mock.calls;
    for (const [req] of calls) {
      expect(req.type).toBe(DocumentType.TDD); // PRD -> TDD
    }
  });

  test('child documents have correct depth', async () => {
    const storage = mockStorage();
    const config = makeConfig();
    const tree = makeTreeWithNodeCount(1);

    await decompose(makeRequest(), storage, config, tree);

    const calls = (storage.createDocument as jest.Mock).mock.calls;
    for (const [req] of calls) {
      expect(req.depth).toBe(1); // PRD depth 0 + 1
    }
  });

  test('child documents have correct sibling_index and sibling_count', async () => {
    const storage = mockStorage();
    const config = makeConfig();
    const tree = makeTreeWithNodeCount(1);

    await decompose(makeRequest(), storage, config, tree);

    const calls = (storage.createDocument as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);

    expect(calls[0][0].siblingIndex).toBe(0);
    expect(calls[0][0].siblingCount).toBe(2);
    expect(calls[1][0].siblingIndex).toBe(1);
    expect(calls[1][0].siblingCount).toBe(2);
  });

  test('child documents have correct traces_from from proposal', async () => {
    const storage = mockStorage();
    const config = makeConfig();
    const tree = makeTreeWithNodeCount(1);

    await decompose(makeRequest(), storage, config, tree);

    const calls = (storage.createDocument as jest.Mock).mock.calls;
    expect(calls[0][0].tracesFrom).toEqual(['overview']);
    expect(calls[1][0].tracesFrom).toEqual(['requirements']);
  });

  test('child documents have correct depends_on from proposal', async () => {
    const storage = mockStorage();
    const config = makeConfig();
    const tree = makeTreeWithNodeCount(1);

    const children = [
      makeChild({ id: 'TDD-001-01', title: 'A', tracesFrom: ['overview'], dependsOn: [] }),
      makeChild({ id: 'TDD-001-02', title: 'B', tracesFrom: ['requirements'], dependsOn: ['TDD-001-01'] }),
    ];

    await decompose(makeRequest({ proposedChildren: children }), storage, config, tree);

    const calls = (storage.createDocument as jest.Mock).mock.calls;
    expect(calls[0][0].dependsOn).toEqual([]);
    expect(calls[1][0].dependsOn).toEqual(['TDD-001-01']);
  });

  test('child documents inherit parent priority', async () => {
    const storage = mockStorage({
      parentContent: makeParentContent({ status: 'approved', priority: 'critical' }),
    });
    const config = makeConfig();
    const tree = makeTreeWithNodeCount(1);

    await decompose(makeRequest(), storage, config, tree);

    const calls = (storage.createDocument as jest.Mock).mock.calls;
    for (const [req] of calls) {
      expect(req.priority).toBe('critical');
    }
  });

  test('coverage matrix maps parent sections to child IDs correctly', async () => {
    const storage = mockStorage();
    const config = makeConfig();
    const tree = makeTreeWithNodeCount(1);

    const children = [
      makeChild({ id: 'TDD-001-01', title: 'A', tracesFrom: ['overview', 'requirements'] }),
      makeChild({ id: 'TDD-001-02', title: 'B', tracesFrom: ['requirements'] }),
    ];

    const result = await decompose(
      makeRequest({ proposedChildren: children }),
      storage,
      config,
      tree,
    );

    const overviewEntry = result.record.coverageMatrix.find(
      e => e.parentSection === 'overview',
    );
    expect(overviewEntry).toBeDefined();
    expect(overviewEntry!.coveredBy).toHaveLength(1);

    const requirementsEntry = result.record.coverageMatrix.find(
      e => e.parentSection === 'requirements',
    );
    expect(requirementsEntry).toBeDefined();
    expect(requirementsEntry!.coveredBy).toHaveLength(2);
  });

  test('decomposition record written with correct schema', async () => {
    const storage = mockStorage();
    const config = makeConfig();
    const tree = makeTreeWithNodeCount(1);

    const result = await decompose(makeRequest(), storage, config, tree);

    expect(mockedWriteRecord).toHaveBeenCalledTimes(1);
    const record = result.record;
    expect(record.parentId).toBe('PRD-001');
    expect(record.parentType).toBe(DocumentType.PRD);
    expect(record.parentVersion).toBe('1.0');
    expect(record.childType).toBe(DocumentType.TDD);
    expect(record.strategy).toBe('domain');
    expect(record.children).toHaveLength(2);
    expect(record.decompositionAgent).toBe('agent-decomposer');
    expect(record.createdAt).toBeDefined();
    expect(record.coverageMatrix).toBeDefined();
  });

  test('returns explosionWarning when threshold exceeded', async () => {
    const storage = mockStorage();
    // maxTotalNodes=100, explosionThresholdPercent=75 -> threshold at 75
    // tree has 74 nodes, proposing 2 -> 76 total > 75 threshold, <= 100 limit
    const config = makeConfig();
    const tree = makeTreeWithNodeCount(74);

    const result = await decompose(makeRequest(), storage, config, tree);

    expect(result.explosionWarning).toBe(true);
    expect(result.success).toBe(true);
  });

  test('skips smoke test when config allows and skipSmokeTest is true', async () => {
    const storage = mockStorage();
    const config = makeConfig({ smokeTestRequired: false });
    const tree = makeTreeWithNodeCount(1);

    const result = await decompose(
      makeRequest({ skipSmokeTest: true }),
      storage,
      config,
      tree,
    );

    expect(result.success).toBe(true);
    expect(result.smokeTestResult).toBeNull();
    expect(mockedSmokeTest).not.toHaveBeenCalled();
  });

  test('DecompositionError has correct name and properties', () => {
    const error = new DecompositionError(
      'PARENT_NOT_APPROVED',
      'test message',
      { extra: true },
    );
    expect(error.name).toBe('DecompositionError');
    expect(error.type).toBe('PARENT_NOT_APPROVED');
    expect(error.message).toBe('test message');
    expect(error.details).toEqual({ extra: true });
    expect(error).toBeInstanceOf(Error);
  });
});
