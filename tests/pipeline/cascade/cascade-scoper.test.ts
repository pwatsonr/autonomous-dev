import { scopeCascade, CascadeScopeResult } from '../../../src/pipeline/cascade/cascade-scoper';
import { DocumentType } from '../../../src/pipeline/types/document-type';

/**
 * Unit tests for cascade-scoper (SPEC-003-5-04, Task 11).
 *
 * Uses mocked DocumentStorage and analyzeImpact to test scoping logic.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the impact analyzer module
jest.mock('../../../src/pipeline/traceability/impact-analyzer', () => ({
  analyzeImpact: jest.fn(),
}));

import { analyzeImpact } from '../../../src/pipeline/traceability/impact-analyzer';
const mockedAnalyzeImpact = analyzeImpact as jest.MockedFunction<typeof analyzeImpact>;

/**
 * Helper: creates a mock DocumentStorage with configurable children.
 */
function createMockStorage(childDocs: Array<{
  documentId: string;
  type: DocumentType;
  tracesFrom: string[];
}>) {
  const docHandles = childDocs.map(d => ({
    documentId: d.documentId,
    pipelineId: 'PIPE-001',
    type: d.type,
    status: 'approved' as const,
    version: '1.0',
    filePath: `/fake/${d.documentId}`,
  }));

  return {
    listDocuments: jest.fn().mockResolvedValue(docHandles),
    readDocument: jest.fn().mockImplementation(
      (_pipelineId: string, _type: DocumentType, docId: string) => {
        const child = childDocs.find(c => c.documentId === docId);
        return Promise.resolve({
          frontmatter: {
            traces_from: child?.tracesFrom ?? [],
          },
          body: '',
          rawContent: '',
          version: '1.0',
          filePath: `/fake/${docId}`,
        });
      },
    ),
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scopeCascade', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAnalyzeImpact.mockResolvedValue([]);
  });

  it('affected child: traces_from intersects affected sections', async () => {
    const storage = createMockStorage([
      { documentId: 'TDD-001-01', type: DocumentType.TDD, tracesFrom: ['scope', 'goals'] },
      { documentId: 'TDD-001-02', type: DocumentType.TDD, tracesFrom: ['architecture'] },
    ]);
    mockedAnalyzeImpact.mockResolvedValue(['TDD-001-01']);

    const result = await scopeCascade(
      'PIPE-001',
      'PRD-001',
      ['scope'],
      ['TDD-001-01', 'TDD-001-02'],
      storage,
    );

    expect(result.affectedChildren).toEqual(['TDD-001-01']);
    expect(result.unaffectedChildren).toEqual(['TDD-001-02']);
  });

  it('unaffected child: traces_from does not intersect affected sections', async () => {
    const storage = createMockStorage([
      { documentId: 'TDD-001-01', type: DocumentType.TDD, tracesFrom: ['architecture'] },
    ]);
    mockedAnalyzeImpact.mockResolvedValue([]);

    const result = await scopeCascade(
      'PIPE-001',
      'PRD-001',
      ['scope'],
      ['TDD-001-01'],
      storage,
    );

    expect(result.affectedChildren).toEqual([]);
    expect(result.unaffectedChildren).toEqual(['TDD-001-01']);
  });

  it('all children affected: all have matching traces', async () => {
    const storage = createMockStorage([
      { documentId: 'TDD-001-01', type: DocumentType.TDD, tracesFrom: ['scope'] },
      { documentId: 'TDD-001-02', type: DocumentType.TDD, tracesFrom: ['scope', 'goals'] },
      { documentId: 'TDD-001-03', type: DocumentType.TDD, tracesFrom: ['goals'] },
    ]);
    mockedAnalyzeImpact.mockResolvedValue(['TDD-001-01', 'TDD-001-02', 'TDD-001-03']);

    const result = await scopeCascade(
      'PIPE-001',
      'PRD-001',
      ['scope', 'goals'],
      ['TDD-001-01', 'TDD-001-02', 'TDD-001-03'],
      storage,
    );

    expect(result.affectedChildren).toEqual(['TDD-001-01', 'TDD-001-02', 'TDD-001-03']);
    expect(result.unaffectedChildren).toEqual([]);
  });

  it('no children affected: none have matching traces', async () => {
    const storage = createMockStorage([
      { documentId: 'TDD-001-01', type: DocumentType.TDD, tracesFrom: ['architecture'] },
      { documentId: 'TDD-001-02', type: DocumentType.TDD, tracesFrom: ['testing'] },
    ]);
    mockedAnalyzeImpact.mockResolvedValue([]);

    const result = await scopeCascade(
      'PIPE-001',
      'PRD-001',
      ['scope'],
      ['TDD-001-01', 'TDD-001-02'],
      storage,
    );

    expect(result.affectedChildren).toEqual([]);
    expect(result.unaffectedChildren).toEqual(['TDD-001-01', 'TDD-001-02']);
  });

  it('transitive impact: affected child descendants included', async () => {
    const storage = createMockStorage([
      { documentId: 'TDD-001-01', type: DocumentType.TDD, tracesFrom: ['scope'] },
    ]);
    // analyzeImpact returns the child plus its descendants
    mockedAnalyzeImpact.mockResolvedValue(['TDD-001-01', 'PLAN-001-01-01', 'PLAN-001-01-02']);

    const result = await scopeCascade(
      'PIPE-001',
      'PRD-001',
      ['scope'],
      ['TDD-001-01'],
      storage,
    );

    expect(result.affectedChildren).toEqual(['TDD-001-01']);
    expect(result.allAffectedDocuments).toEqual([
      'TDD-001-01',
      'PLAN-001-01-01',
      'PLAN-001-01-02',
    ]);
  });

  it('child with empty traces_from: unaffected', async () => {
    const storage = createMockStorage([
      { documentId: 'TDD-001-01', type: DocumentType.TDD, tracesFrom: [] },
    ]);
    mockedAnalyzeImpact.mockResolvedValue([]);

    const result = await scopeCascade(
      'PIPE-001',
      'PRD-001',
      ['scope'],
      ['TDD-001-01'],
      storage,
    );

    expect(result.affectedChildren).toEqual([]);
    expect(result.unaffectedChildren).toEqual(['TDD-001-01']);
  });

  it('child not found in storage: treated as unaffected', async () => {
    const storage = createMockStorage([]);
    mockedAnalyzeImpact.mockResolvedValue([]);

    const result = await scopeCascade(
      'PIPE-001',
      'PRD-001',
      ['scope'],
      ['TDD-MISSING-001'],
      storage,
    );

    expect(result.affectedChildren).toEqual([]);
    expect(result.unaffectedChildren).toEqual(['TDD-MISSING-001']);
  });
});
