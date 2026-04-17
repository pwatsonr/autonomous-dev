import { DocumentType } from '../../../src/pipeline/types/document-type';
import { DocumentStorage } from '../../../src/pipeline/storage/document-storage';
import { DocumentContent } from '../../../src/pipeline/storage/document-reader';
import { DocumentHandle } from '../../../src/pipeline/storage/document-lister';
import { DecompositionRecord } from '../../../src/pipeline/decomposition/decomposition-record-io';
import { reconstructTree } from '../../../src/pipeline/decomposition/tree-reconstructor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a DocumentHandle as returned by listDocuments.
 */
function makeHandle(overrides: Partial<DocumentHandle> & { documentId: string }): DocumentHandle {
  return {
    pipelineId: 'pipeline-1',
    type: DocumentType.PRD,
    status: 'approved',
    version: '1.0',
    depth: 0,
    parentId: null,
    title: `Doc ${overrides.documentId}`,
    ...overrides,
  };
}

/**
 * Builds a DocumentContent as returned by readDocument.
 */
function makeDocContent(overrides?: {
  id?: string;
  type?: DocumentType;
  status?: string;
  depends_on?: string[];
  execution_mode?: string;
  sibling_index?: number;
  sibling_count?: number;
  depth?: number;
  parent_id?: string | null;
}): DocumentContent {
  return {
    frontmatter: {
      id: overrides?.id ?? 'PRD-001',
      title: 'Test Doc',
      pipeline_id: 'pipeline-1',
      type: overrides?.type ?? DocumentType.PRD,
      status: (overrides?.status ?? 'approved') as any,
      version: '1.0',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      author_agent: 'agent-writer',
      parent_id: overrides?.parent_id ?? null,
      traces_from: [],
      traces_to: [],
      depth: overrides?.depth ?? 0,
      sibling_index: overrides?.sibling_index ?? 0,
      sibling_count: overrides?.sibling_count ?? 1,
      depends_on: overrides?.depends_on ?? [],
      dependency_type: [],
      execution_mode: (overrides?.execution_mode ?? 'parallel') as any,
      priority: 'normal',
    },
    body: 'Document body',
    rawContent: '---\nid: PRD-001\n---\nDocument body',
    version: '1.0',
    filePath: '/mock/path.md',
  };
}

/**
 * Builds a DecompositionRecord.
 */
function makeRecord(overrides: Partial<DecompositionRecord> & {
  parentId: string;
  children: Array<{ id: string; title: string; tracesFrom: string[]; executionMode: 'parallel' | 'sequential'; dependsOn: string[] }>;
}): DecompositionRecord {
  return {
    parentType: DocumentType.PRD,
    parentVersion: '1.0',
    childType: DocumentType.TDD,
    strategy: 'domain',
    coverageMatrix: [],
    smokeTestResult: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    decompositionAgent: 'agent-decomposer',
    ...overrides,
  };
}

/**
 * Creates a mock DocumentStorage with configurable handles and records.
 */
function mockStorage(opts: {
  handles: DocumentHandle[];
  records: DecompositionRecord[];
  docContents?: Map<string, DocumentContent>;
}): DocumentStorage {
  const docContents = opts.docContents ?? new Map<string, DocumentContent>();

  return {
    listDocuments: jest.fn().mockResolvedValue(opts.handles),
    readDocument: jest.fn().mockImplementation(
      async (_pipelineId: string, _type: DocumentType, docId: string) => {
        const content = docContents.get(docId);
        if (content) return content;
        // Return a default content
        return makeDocContent({ id: docId });
      },
    ),
    getDirectoryManager: jest.fn().mockReturnValue({
      getDecompositionDir: jest.fn().mockReturnValue('/mock/decomposition'),
    }),
  } as unknown as DocumentStorage;
}

// Mock readAllDecompositionRecords
let mockRecords: DecompositionRecord[] = [];

jest.mock('../../../src/pipeline/decomposition/decomposition-record-io', () => {
  const actual = jest.requireActual('../../../src/pipeline/decomposition/decomposition-record-io');
  return {
    ...actual,
    readAllDecompositionRecords: jest.fn().mockImplementation(async () => mockRecords),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tree Reconstructor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecords = [];
  });

  test('reconstructs tree with single PRD (root only)', async () => {
    const handles = [
      makeHandle({ documentId: 'PRD-001', type: DocumentType.PRD, depth: 0 }),
    ];
    mockRecords = [];
    const storage = mockStorage({ handles, records: [] });

    const tree = await reconstructTree('pipeline-1', storage);

    expect(tree.getTotalNodeCount()).toBe(1);
    expect(tree.getRootId()).toBe('PRD-001');
    expect(tree.hasNode('PRD-001')).toBe(true);

    const root = tree.getNode('PRD-001');
    expect(root.type).toBe(DocumentType.PRD);
    expect(root.depth).toBe(0);
    expect(root.childIds).toEqual([]);
    expect(root.parentId).toBeNull();
  });

  test('reconstructs tree with PRD + 3 TDDs', async () => {
    const handles = [
      makeHandle({ documentId: 'PRD-001', type: DocumentType.PRD, depth: 0 }),
      makeHandle({ documentId: 'TDD-001-01', type: DocumentType.TDD, depth: 1, parentId: 'PRD-001' }),
      makeHandle({ documentId: 'TDD-001-02', type: DocumentType.TDD, depth: 1, parentId: 'PRD-001' }),
      makeHandle({ documentId: 'TDD-001-03', type: DocumentType.TDD, depth: 1, parentId: 'PRD-001' }),
    ];

    mockRecords = [
      makeRecord({
        parentId: 'PRD-001',
        children: [
          { id: 'TDD-001-01', title: 'TDD A', tracesFrom: ['overview'], executionMode: 'parallel', dependsOn: [] },
          { id: 'TDD-001-02', title: 'TDD B', tracesFrom: ['requirements'], executionMode: 'parallel', dependsOn: [] },
          { id: 'TDD-001-03', title: 'TDD C', tracesFrom: ['nfr'], executionMode: 'parallel', dependsOn: [] },
        ],
      }),
    ];

    const docContents = new Map<string, DocumentContent>();
    docContents.set('PRD-001', makeDocContent({ id: 'PRD-001', sibling_count: 1 }));
    docContents.set('TDD-001-01', makeDocContent({
      id: 'TDD-001-01', type: DocumentType.TDD, depth: 1, parent_id: 'PRD-001',
      sibling_index: 0, sibling_count: 3,
    }));
    docContents.set('TDD-001-02', makeDocContent({
      id: 'TDD-001-02', type: DocumentType.TDD, depth: 1, parent_id: 'PRD-001',
      sibling_index: 1, sibling_count: 3,
    }));
    docContents.set('TDD-001-03', makeDocContent({
      id: 'TDD-001-03', type: DocumentType.TDD, depth: 1, parent_id: 'PRD-001',
      sibling_index: 2, sibling_count: 3,
    }));

    const storage = mockStorage({ handles, records: mockRecords, docContents });
    const tree = await reconstructTree('pipeline-1', storage);

    expect(tree.getTotalNodeCount()).toBe(4);
    expect(tree.getRootId()).toBe('PRD-001');

    const root = tree.getNode('PRD-001');
    expect(root.childIds).toHaveLength(3);
    expect(root.childIds).toContain('TDD-001-01');
    expect(root.childIds).toContain('TDD-001-02');
    expect(root.childIds).toContain('TDD-001-03');

    for (const tddId of ['TDD-001-01', 'TDD-001-02', 'TDD-001-03']) {
      const node = tree.getNode(tddId);
      expect(node.type).toBe(DocumentType.TDD);
      expect(node.depth).toBe(1);
      expect(node.parentId).toBe('PRD-001');
    }
  });

  test('reconstructs tree with PRD + TDDs + Plans (3 levels)', async () => {
    const handles = [
      makeHandle({ documentId: 'PRD-001', type: DocumentType.PRD, depth: 0 }),
      makeHandle({ documentId: 'TDD-001-01', type: DocumentType.TDD, depth: 1, parentId: 'PRD-001' }),
      makeHandle({ documentId: 'PLAN-001-01', type: DocumentType.PLAN, depth: 2, parentId: 'TDD-001-01' }),
      makeHandle({ documentId: 'PLAN-001-02', type: DocumentType.PLAN, depth: 2, parentId: 'TDD-001-01' }),
    ];

    mockRecords = [
      makeRecord({
        parentId: 'PRD-001',
        children: [
          { id: 'TDD-001-01', title: 'TDD A', tracesFrom: ['overview'], executionMode: 'parallel', dependsOn: [] },
        ],
      }),
      makeRecord({
        parentId: 'TDD-001-01',
        parentType: DocumentType.TDD,
        childType: DocumentType.PLAN,
        strategy: 'phase',
        children: [
          { id: 'PLAN-001-01', title: 'Plan A', tracesFrom: ['api'], executionMode: 'parallel', dependsOn: [] },
          { id: 'PLAN-001-02', title: 'Plan B', tracesFrom: ['ui'], executionMode: 'sequential', dependsOn: ['PLAN-001-01'] },
        ],
      }),
    ];

    const docContents = new Map<string, DocumentContent>();
    docContents.set('PRD-001', makeDocContent({ id: 'PRD-001' }));
    docContents.set('TDD-001-01', makeDocContent({
      id: 'TDD-001-01', type: DocumentType.TDD, depth: 1, parent_id: 'PRD-001',
    }));
    docContents.set('PLAN-001-01', makeDocContent({
      id: 'PLAN-001-01', type: DocumentType.PLAN, depth: 2, parent_id: 'TDD-001-01',
      sibling_index: 0, sibling_count: 2,
    }));
    docContents.set('PLAN-001-02', makeDocContent({
      id: 'PLAN-001-02', type: DocumentType.PLAN, depth: 2, parent_id: 'TDD-001-01',
      sibling_index: 1, sibling_count: 2, depends_on: ['PLAN-001-01'], execution_mode: 'sequential',
    }));

    const storage = mockStorage({ handles, records: mockRecords, docContents });
    const tree = await reconstructTree('pipeline-1', storage);

    expect(tree.getTotalNodeCount()).toBe(4);
    expect(tree.getMaxDepth()).toBe(2);

    const tddNode = tree.getNode('TDD-001-01');
    expect(tddNode.childIds).toHaveLength(2);
    expect(tddNode.childIds).toContain('PLAN-001-01');
    expect(tddNode.childIds).toContain('PLAN-001-02');

    const plan2 = tree.getNode('PLAN-001-02');
    expect(plan2.dependsOn).toEqual(['PLAN-001-01']);
    expect(plan2.executionMode).toBe('sequential');
  });

  test('nodes have correct parent-child relationships', async () => {
    const handles = [
      makeHandle({ documentId: 'PRD-001', type: DocumentType.PRD, depth: 0 }),
      makeHandle({ documentId: 'TDD-001-01', type: DocumentType.TDD, depth: 1, parentId: 'PRD-001' }),
    ];

    mockRecords = [
      makeRecord({
        parentId: 'PRD-001',
        children: [
          { id: 'TDD-001-01', title: 'TDD A', tracesFrom: ['overview'], executionMode: 'parallel', dependsOn: [] },
        ],
      }),
    ];

    const storage = mockStorage({ handles, records: mockRecords });
    const tree = await reconstructTree('pipeline-1', storage);

    const root = tree.getNode('PRD-001');
    expect(root.childIds).toContain('TDD-001-01');

    const child = tree.getNode('TDD-001-01');
    expect(child.parentId).toBe('PRD-001');
  });

  test('nodes have correct status and version from frontmatter', async () => {
    const handles = [
      makeHandle({
        documentId: 'PRD-001',
        type: DocumentType.PRD,
        depth: 0,
        status: 'approved',
        version: '1.1',
      }),
    ];
    mockRecords = [];

    const docContents = new Map<string, DocumentContent>();
    docContents.set('PRD-001', makeDocContent({ id: 'PRD-001', status: 'approved' }));

    const storage = mockStorage({ handles, records: [], docContents });
    const tree = await reconstructTree('pipeline-1', storage);

    const node = tree.getNode('PRD-001');
    expect(node.status).toBe('approved');
    expect(node.version).toBe('1.1');
  });

  test('nodes have correct dependsOn and executionMode', async () => {
    const handles = [
      makeHandle({ documentId: 'PRD-001', type: DocumentType.PRD, depth: 0 }),
      makeHandle({ documentId: 'TDD-001-01', type: DocumentType.TDD, depth: 1, parentId: 'PRD-001' }),
      makeHandle({ documentId: 'TDD-001-02', type: DocumentType.TDD, depth: 1, parentId: 'PRD-001' }),
    ];

    mockRecords = [
      makeRecord({
        parentId: 'PRD-001',
        children: [
          { id: 'TDD-001-01', title: 'TDD A', tracesFrom: ['overview'], executionMode: 'parallel', dependsOn: [] },
          { id: 'TDD-001-02', title: 'TDD B', tracesFrom: ['requirements'], executionMode: 'sequential', dependsOn: ['TDD-001-01'] },
        ],
      }),
    ];

    const docContents = new Map<string, DocumentContent>();
    docContents.set('PRD-001', makeDocContent({ id: 'PRD-001' }));
    docContents.set('TDD-001-01', makeDocContent({
      id: 'TDD-001-01', type: DocumentType.TDD, depth: 1, parent_id: 'PRD-001',
      execution_mode: 'parallel', depends_on: [],
    }));
    docContents.set('TDD-001-02', makeDocContent({
      id: 'TDD-001-02', type: DocumentType.TDD, depth: 1, parent_id: 'PRD-001',
      execution_mode: 'sequential', depends_on: ['TDD-001-01'],
    }));

    const storage = mockStorage({ handles, records: mockRecords, docContents });
    const tree = await reconstructTree('pipeline-1', storage);

    const node1 = tree.getNode('TDD-001-01');
    expect(node1.dependsOn).toEqual([]);
    expect(node1.executionMode).toBe('parallel');

    const node2 = tree.getNode('TDD-001-02');
    expect(node2.dependsOn).toEqual(['TDD-001-01']);
    expect(node2.executionMode).toBe('sequential');
  });

  test('handles empty pipeline (no documents)', async () => {
    mockRecords = [];
    const storage = mockStorage({ handles: [], records: [] });

    const tree = await reconstructTree('pipeline-1', storage);

    expect(tree.getTotalNodeCount()).toBe(0);
    expect(tree.getRootId()).toBeNull();
    expect(tree.getAllNodes()).toEqual([]);
  });

  test('handles pipeline with no decomposition records (single root document)', async () => {
    const handles = [
      makeHandle({ documentId: 'PRD-001', type: DocumentType.PRD, depth: 0 }),
    ];
    mockRecords = [];
    const storage = mockStorage({ handles, records: [] });

    const tree = await reconstructTree('pipeline-1', storage);

    expect(tree.getTotalNodeCount()).toBe(1);
    expect(tree.getRootId()).toBe('PRD-001');
    const root = tree.getNode('PRD-001');
    expect(root.childIds).toEqual([]);
  });
});
