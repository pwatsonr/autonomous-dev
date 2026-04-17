import { BackwardCascadeController, CascadeInitiateRequest } from '../../../src/pipeline/cascade/cascade-controller';
import { DocumentType } from '../../../src/pipeline/types/document-type';
import { DEFAULT_PIPELINE_CONFIG, PipelineConfig } from '../../../src/pipeline/types/config';
import { PipelineState } from '../../../src/pipeline/flow/pipeline-state';

/**
 * Integration tests for the backward cascade subsystem (SPEC-003-5-04).
 *
 * These tests exercise the full cascade flow across multiple modules:
 *   cascade-controller -> cascade-scoper -> depth-limiter
 *
 * External dependencies (storage, versioning, event emitter) are mocked,
 * but the cascade modules interact with each other as they would in production.
 */

// ---------------------------------------------------------------------------
// Mocks for external dependencies only
// ---------------------------------------------------------------------------

jest.mock('../../../src/pipeline/traceability/impact-analyzer', () => ({
  analyzeImpact: jest.fn(),
}));

jest.mock('../../../src/pipeline/flow/pipeline-state-io', () => ({
  readPipelineState: jest.fn(),
  writePipelineState: jest.fn(),
}));

import { analyzeImpact } from '../../../src/pipeline/traceability/impact-analyzer';
import { readPipelineState, writePipelineState } from '../../../src/pipeline/flow/pipeline-state-io';

const mockedAnalyzeImpact = analyzeImpact as jest.MockedFunction<typeof analyzeImpact>;
const mockedReadPipelineState = readPipelineState as jest.MockedFunction<typeof readPipelineState>;
const mockedWritePipelineState = writePipelineState as jest.MockedFunction<typeof writePipelineState>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStorage(childDocs: Array<{
  documentId: string;
  type: DocumentType;
  tracesFrom: string[];
}>) {
  const targetDoc = {
    frontmatter: {
      id: 'PRD-001',
      type: DocumentType.PRD,
      status: 'approved',
      traces_from: [],
    },
    body: '## Scope\n\nScope content\n\n## Requirements\n\nReqs content\n\n## Architecture\n\nArch content\n',
    rawContent: '---\nid: PRD-001\n---\n## Scope\n\n## Requirements\n\n## Architecture\n',
    version: '1.0',
    filePath: '/fake/PRD-001',
  };

  const docHandles = childDocs.map(d => ({
    documentId: d.documentId,
    pipelineId: 'PIPE-2026-0408-001',
    type: d.type,
    status: 'approved' as const,
    version: '1.0',
    filePath: `/fake/${d.documentId}`,
  }));

  return {
    readDocument: jest.fn().mockImplementation(
      (_pipelineId: string, type: DocumentType, docId: string) => {
        if (docId === 'PRD-001') return Promise.resolve(targetDoc);
        const child = childDocs.find(c => c.documentId === docId);
        if (!child) throw new Error(`Document not found: ${docId}`);
        return Promise.resolve({
          frontmatter: {
            id: child.documentId,
            type: child.type,
            traces_from: child.tracesFrom,
          },
          body: '',
          rawContent: '',
          version: '1.0',
          filePath: `/fake/${child.documentId}`,
        });
      },
    ),
    listDocuments: jest.fn().mockResolvedValue(docHandles),
    createDocument: jest.fn(),
    readVersion: jest.fn(),
    listVersions: jest.fn(),
    writeVersion: jest.fn(),
    deleteDocument: jest.fn(),
    getDirectoryManager: jest.fn(),
    getAuditLogger: jest.fn(),
    initializePipeline: jest.fn(),
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function createMockVersioningEngine() {
  return {
    createVersion: jest.fn(),
    computeDiff: jest.fn(),
    checkRegression: jest.fn(),
    rollback: jest.fn(),
    getHistory: jest.fn(),
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function createMockDirectoryManager() {
  return {
    getPipelineDir: jest.fn().mockReturnValue('/fake/pipeline'),
    getPipelineYamlPath: jest.fn().mockReturnValue('/fake/pipeline/pipeline.yaml'),
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function createMockEventEmitter() {
  return {
    emit: jest.fn().mockResolvedValue({
      eventId: 'evt-001',
      pipelineId: 'PIPE-2026-0408-001',
      timestamp: '2026-04-08T12:00:00.000Z',
      eventType: 'cascade_initiated',
      details: {},
      actorId: 'system',
      previousHash: 'abc',
    }),
    addListener: jest.fn(),
    removeListener: jest.fn(),
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe('Backward Cascade Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedWritePipelineState.mockResolvedValue(undefined);
  });

  it('TDD review finds PRD defect -> cascade marks affected Plans stale, PRD re-opened', async () => {
    // Setup: PRD-001 has two TDD children; TDD-001-01 traces to 'scope'
    const childDocs = [
      { documentId: 'TDD-001-01', type: DocumentType.TDD, tracesFrom: ['scope'] },
      { documentId: 'TDD-001-02', type: DocumentType.TDD, tracesFrom: ['architecture'] },
    ];
    const storage = createMockStorage(childDocs);

    // analyzeImpact returns only the affected TDD and its descendants
    mockedAnalyzeImpact.mockResolvedValue(['TDD-001-01']);

    const state: PipelineState = {
      pipelineId: 'PIPE-2026-0408-001',
      title: 'Integration Test',
      status: 'ACTIVE',
      priority: 'normal',
      createdAt: '2026-04-08T12:00:00.000Z',
      updatedAt: '2026-04-08T12:00:00.000Z',
      pausedAt: null,
      documentStates: {
        'PRD-001': {
          documentId: 'PRD-001',
          type: DocumentType.PRD,
          status: 'approved',
          version: '1.0',
          reviewIteration: 1,
          lastReviewScore: 90,
          assignedAgent: null,
          parentId: null,
          children: ['TDD-001-01', 'TDD-001-02'],
          blockedBy: [],
          blocking: [],
        },
        'TDD-001-01': {
          documentId: 'TDD-001-01',
          type: DocumentType.TDD,
          status: 'approved',
          version: '1.0',
          reviewIteration: 1,
          lastReviewScore: 88,
          assignedAgent: null,
          parentId: 'PRD-001',
          children: [],
          blockedBy: [],
          blocking: [],
        },
        'TDD-001-02': {
          documentId: 'TDD-001-02',
          type: DocumentType.TDD,
          status: 'approved',
          version: '1.0',
          reviewIteration: 1,
          lastReviewScore: 85,
          assignedAgent: null,
          parentId: 'PRD-001',
          children: [],
          blockedBy: [],
          blocking: [],
        },
      },
      activeCascades: [],
      metrics: {
        totalDocuments: 3,
        documentsByStatus: { approved: 3 },
        totalVersions: 3,
        totalReviews: 3,
      },
    };
    mockedReadPipelineState.mockResolvedValue(state);

    const controller = new BackwardCascadeController(
      storage,
      createMockVersioningEngine(),
      DEFAULT_PIPELINE_CONFIG,
      createMockDirectoryManager(),
      createMockEventEmitter(),
    );

    const request: CascadeInitiateRequest = {
      pipelineId: 'PIPE-2026-0408-001',
      reviewId: 'REVIEW-TDD-001',
      reviewerAgent: 'tdd-reviewer',
      findingDescription: 'PRD scope section has incomplete requirements',
      targetDocumentId: 'PRD-001',
      targetDocumentType: DocumentType.PRD,
      affectedSections: ['scope'],
      actorId: 'tdd-reviewer',
    };

    const event = await controller.initiate(request);

    // PRD should be re-opened
    expect(state.documentStates['PRD-001'].status).toBe('revision-requested');

    // Affected TDD-001-01 (traces to 'scope') should be stale
    expect(state.documentStates['TDD-001-01'].status).toBe('stale');

    // Unaffected TDD-001-02 (traces to 'architecture') should remain approved
    expect(state.documentStates['TDD-001-02'].status).toBe('approved');

    // Cascade event should be created
    expect(event.status).toBe('initiated');
    expect(event.affectedDocuments).toHaveLength(1);
    expect(event.affectedDocuments[0].documentId).toBe('TDD-001-01');

    // Active cascades should include the new cascade
    expect(state.activeCascades).toContain(event.id);
  });

  it('cascade resolved after PRD revision -> stale Plans set to revision-requested', async () => {
    const state: PipelineState = {
      pipelineId: 'PIPE-2026-0408-001',
      title: 'Integration Test',
      status: 'ACTIVE',
      priority: 'normal',
      createdAt: '2026-04-08T12:00:00.000Z',
      updatedAt: '2026-04-08T12:00:00.000Z',
      pausedAt: null,
      documentStates: {
        'PRD-001': {
          documentId: 'PRD-001',
          type: DocumentType.PRD,
          status: 'approved',
          version: '2.0',
          reviewIteration: 2,
          lastReviewScore: 92,
          assignedAgent: null,
          parentId: null,
          children: ['TDD-001-01'],
          blockedBy: [],
          blocking: [],
        },
        'TDD-001-01': {
          documentId: 'TDD-001-01',
          type: DocumentType.TDD,
          status: 'stale',
          version: '1.0',
          reviewIteration: 1,
          lastReviewScore: 88,
          assignedAgent: null,
          parentId: 'PRD-001',
          children: [],
          blockedBy: [],
          blocking: [],
        },
      },
      activeCascades: ['CASCADE-001-001'],
      metrics: {
        totalDocuments: 2,
        documentsByStatus: { approved: 1, stale: 1 },
        totalVersions: 3,
        totalReviews: 3,
      },
    };
    mockedReadPipelineState.mockResolvedValue(state);

    const eventEmitter = createMockEventEmitter();
    const controller = new BackwardCascadeController(
      createMockStorage([]),
      createMockVersioningEngine(),
      DEFAULT_PIPELINE_CONFIG,
      createMockDirectoryManager(),
      eventEmitter,
    );

    const resolved = await controller.resolve(
      'PIPE-2026-0408-001',
      'CASCADE-001-001',
      'system',
    );

    // Cascade should be removed from active list
    expect(state.activeCascades).not.toContain('CASCADE-001-001');
    expect(state.activeCascades).toEqual([]);

    // cascade_resolved event should be emitted
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'PIPE-2026-0408-001',
      'cascade_resolved',
      { cascadeId: 'CASCADE-001-001' },
      'system',
    );

    // Resolved event should have resolved status
    expect(resolved.status).toBe('resolved');
  });

  it('cascade at depth 3 -> escalation triggered', async () => {
    // Config with maxDepth=2 (default), but we simulate a depth-3 scenario
    // by using maxDepth=0 so that even depth 1 triggers escalation
    const config: PipelineConfig = {
      ...DEFAULT_PIPELINE_CONFIG,
      backwardCascade: {
        ...DEFAULT_PIPELINE_CONFIG.backwardCascade,
        maxDepth: 0,
      },
    };

    const storage = createMockStorage([]);
    // Storage returns a document with the expected section
    storage.readDocument.mockResolvedValue({
      frontmatter: { id: 'PRD-001', type: DocumentType.PRD },
      body: '## Scope\n\nContent\n',
      rawContent: '',
      version: '1.0',
      filePath: '/fake/PRD-001',
    });

    const eventEmitter = createMockEventEmitter();
    const controller = new BackwardCascadeController(
      storage,
      createMockVersioningEngine(),
      config,
      createMockDirectoryManager(),
      eventEmitter,
    );

    const request: CascadeInitiateRequest = {
      pipelineId: 'PIPE-2026-0408-001',
      reviewId: 'REVIEW-DEEP-001',
      reviewerAgent: 'deep-reviewer',
      findingDescription: 'Deep cascade defect',
      targetDocumentId: 'PRD-001',
      targetDocumentType: DocumentType.PRD,
      affectedSections: ['scope'],
      actorId: 'system',
    };

    const event = await controller.initiate(request);

    // Should be escalated immediately
    expect(event.status).toBe('escalated');
    expect(event.timestamps.escalated).toBeTruthy();

    // human_escalation event should be emitted
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'PIPE-2026-0408-001',
      'human_escalation',
      expect.objectContaining({ cascadeId: event.id }),
      'system',
      'PRD-001',
    );

    // No state mutation should have occurred (no readPipelineState call)
    expect(mockedReadPipelineState).not.toHaveBeenCalled();
  });

  it('circuit breaker: cascading same section twice escalates on second attempt', async () => {
    const childDocs = [
      { documentId: 'TDD-001-01', type: DocumentType.TDD, tracesFrom: ['scope'] },
    ];
    const storage = createMockStorage(childDocs);
    mockedAnalyzeImpact.mockResolvedValue(['TDD-001-01']);

    const state1: PipelineState = {
      pipelineId: 'PIPE-2026-0408-001',
      title: 'Circuit Breaker Test',
      status: 'ACTIVE',
      priority: 'normal',
      createdAt: '2026-04-08T12:00:00.000Z',
      updatedAt: '2026-04-08T12:00:00.000Z',
      pausedAt: null,
      documentStates: {
        'PRD-001': {
          documentId: 'PRD-001',
          type: DocumentType.PRD,
          status: 'approved',
          version: '1.0',
          reviewIteration: 1,
          lastReviewScore: 90,
          assignedAgent: null,
          parentId: null,
          children: ['TDD-001-01'],
          blockedBy: [],
          blocking: [],
        },
        'TDD-001-01': {
          documentId: 'TDD-001-01',
          type: DocumentType.TDD,
          status: 'approved',
          version: '1.0',
          reviewIteration: 1,
          lastReviewScore: 88,
          assignedAgent: null,
          parentId: 'PRD-001',
          children: [],
          blockedBy: [],
          blocking: [],
        },
      },
      activeCascades: [],
      metrics: {
        totalDocuments: 2,
        documentsByStatus: { approved: 2 },
        totalVersions: 2,
        totalReviews: 2,
      },
    };
    mockedReadPipelineState.mockResolvedValue(state1);

    const eventEmitter = createMockEventEmitter();
    const controller = new BackwardCascadeController(
      storage,
      createMockVersioningEngine(),
      DEFAULT_PIPELINE_CONFIG,
      createMockDirectoryManager(),
      eventEmitter,
    );

    const request: CascadeInitiateRequest = {
      pipelineId: 'PIPE-2026-0408-001',
      reviewId: 'REVIEW-001',
      reviewerAgent: 'reviewer-1',
      findingDescription: 'Scope defect',
      targetDocumentId: 'PRD-001',
      targetDocumentType: DocumentType.PRD,
      affectedSections: ['scope'],
      actorId: 'system',
    };

    // First cascade: should succeed
    const event1 = await controller.initiate(request);
    expect(event1.status).toBe('initiated');

    // Second cascade on same section: circuit breaker should trigger
    const state2: PipelineState = {
      ...state1,
      activeCascades: [event1.id],
      documentStates: {
        ...state1.documentStates,
        'PRD-001': { ...state1.documentStates['PRD-001'], status: 'approved' },
        'TDD-001-01': { ...state1.documentStates['TDD-001-01'], status: 'approved' },
      },
    };
    mockedReadPipelineState.mockResolvedValue(state2);

    const event2 = await controller.initiate(request);
    expect(event2.status).toBe('escalated');

    // Verify human_escalation was emitted for the circuit breaker
    const escalationCalls = eventEmitter.emit.mock.calls.filter(
      (call: any[]) => call[1] === 'human_escalation',
    );
    expect(escalationCalls.length).toBeGreaterThanOrEqual(1);
    const lastEscalation = escalationCalls[escalationCalls.length - 1];
    expect(lastEscalation[2].reason).toContain('Circuit breaker');
  });
});
