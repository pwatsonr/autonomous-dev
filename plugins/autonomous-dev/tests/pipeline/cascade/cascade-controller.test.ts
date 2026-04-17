import { BackwardCascadeController, CascadeInitiateRequest } from '../../../src/pipeline/cascade/cascade-controller';
import { DocumentType } from '../../../src/pipeline/types/document-type';
import { DEFAULT_PIPELINE_CONFIG, PipelineConfig } from '../../../src/pipeline/types/config';
import { PipelineState } from '../../../src/pipeline/flow/pipeline-state';

/**
 * Unit tests for cascade-controller (SPEC-003-5-04, Task 13).
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../src/pipeline/cascade/cascade-scoper', () => ({
  scopeCascade: jest.fn(),
}));

jest.mock('../../../src/pipeline/flow/pipeline-state-io', () => ({
  readPipelineState: jest.fn(),
  writePipelineState: jest.fn(),
}));

import { scopeCascade } from '../../../src/pipeline/cascade/cascade-scoper';
import { readPipelineState, writePipelineState } from '../../../src/pipeline/flow/pipeline-state-io';

const mockedScopeCascade = scopeCascade as jest.MockedFunction<typeof scopeCascade>;
const mockedReadPipelineState = readPipelineState as jest.MockedFunction<typeof readPipelineState>;
const mockedWritePipelineState = writePipelineState as jest.MockedFunction<typeof writePipelineState>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStorage() {
  return {
    readDocument: jest.fn().mockResolvedValue({
      frontmatter: {
        id: 'PRD-001',
        type: DocumentType.PRD,
        status: 'approved',
        traces_from: [],
      },
      body: '## Scope\n\nScope content\n\n## Requirements\n\nReqs content\n',
      rawContent: '---\nid: PRD-001\n---\n## Scope\n\nScope content\n\n## Requirements\n\nReqs content\n',
      version: '1.0',
      filePath: '/fake/PRD-001',
    }),
    listDocuments: jest.fn().mockResolvedValue([]),
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

function createDefaultPipelineState(): PipelineState {
  return {
    pipelineId: 'PIPE-2026-0408-001',
    title: 'Test Pipeline',
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
}

function createDefaultRequest(): CascadeInitiateRequest {
  return {
    pipelineId: 'PIPE-2026-0408-001',
    reviewId: 'REVIEW-001',
    reviewerAgent: 'reviewer-agent-1',
    findingDescription: 'Missing scope section detail',
    targetDocumentId: 'PRD-001',
    targetDocumentType: DocumentType.PRD,
    affectedSections: ['scope'],
    actorId: 'system',
  };
}

function createController(overrides?: {
  storage?: any;
  versioningEngine?: any;
  config?: PipelineConfig;
  directoryManager?: any;
  eventEmitter?: any;
}) {
  return new BackwardCascadeController(
    overrides?.storage ?? createMockStorage(),
    overrides?.versioningEngine ?? createMockVersioningEngine(),
    overrides?.config ?? DEFAULT_PIPELINE_CONFIG,
    overrides?.directoryManager ?? createMockDirectoryManager(),
    overrides?.eventEmitter ?? createMockEventEmitter(),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BackwardCascadeController.initiate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedWritePipelineState.mockResolvedValue(undefined);
  });

  it('validates target document exists', async () => {
    const storage = createMockStorage();
    storage.readDocument.mockRejectedValue(new Error('Document not found'));
    const controller = createController({ storage });

    await expect(controller.initiate(createDefaultRequest())).rejects.toThrow('Document not found');
    expect(storage.readDocument).toHaveBeenCalledWith(
      'PIPE-2026-0408-001',
      DocumentType.PRD,
      'PRD-001',
    );
  });

  it('validates affected sections exist in target', async () => {
    const storage = createMockStorage();
    // Document body has no "missing-section" heading
    storage.readDocument.mockResolvedValue({
      frontmatter: { id: 'PRD-001', type: DocumentType.PRD },
      body: '## Scope\n\nContent\n',
      rawContent: '',
      version: '1.0',
      filePath: '/fake/PRD-001',
    });
    const controller = createController({ storage });

    const request = createDefaultRequest();
    request.affectedSections = ['missing-section'];

    await expect(controller.initiate(request)).rejects.toThrow('Affected sections not found');
  });

  it('marks affected children as stale', async () => {
    const state = createDefaultPipelineState();
    mockedReadPipelineState.mockResolvedValue(state);
    mockedScopeCascade.mockResolvedValue({
      affectedChildren: ['TDD-001-01'],
      unaffectedChildren: ['TDD-001-02'],
      allAffectedDocuments: ['TDD-001-01'],
    });

    const controller = createController();
    const event = await controller.initiate(createDefaultRequest());

    // TDD-001-01 should be marked stale
    expect(state.documentStates['TDD-001-01'].status).toBe('stale');
    // TDD-001-02 should remain approved
    expect(state.documentStates['TDD-001-02'].status).toBe('approved');

    expect(event.affectedDocuments).toHaveLength(1);
    expect(event.affectedDocuments[0].documentId).toBe('TDD-001-01');
    expect(event.affectedDocuments[0].previousStatus).toBe('approved');
    expect(event.affectedDocuments[0].newStatus).toBe('stale');
  });

  it('re-opens target for revision', async () => {
    const state = createDefaultPipelineState();
    mockedReadPipelineState.mockResolvedValue(state);
    mockedScopeCascade.mockResolvedValue({
      affectedChildren: [],
      unaffectedChildren: ['TDD-001-01', 'TDD-001-02'],
      allAffectedDocuments: [],
    });

    const controller = createController();
    await controller.initiate(createDefaultRequest());

    expect(state.documentStates['PRD-001'].status).toBe('revision-requested');
  });

  it('creates cascade event with correct fields', async () => {
    const state = createDefaultPipelineState();
    mockedReadPipelineState.mockResolvedValue(state);
    mockedScopeCascade.mockResolvedValue({
      affectedChildren: ['TDD-001-01'],
      unaffectedChildren: ['TDD-001-02'],
      allAffectedDocuments: ['TDD-001-01'],
    });

    const controller = createController();
    const event = await controller.initiate(createDefaultRequest());

    expect(event.id).toMatch(/^CASCADE-/);
    expect(event.pipelineId).toBe('PIPE-2026-0408-001');
    expect(event.triggeredBy.reviewId).toBe('REVIEW-001');
    expect(event.triggeredBy.findingDescription).toBe('Missing scope section detail');
    expect(event.triggeredBy.reviewerAgent).toBe('reviewer-agent-1');
    expect(event.targetDocument.documentId).toBe('PRD-001');
    expect(event.targetDocument.type).toBe(DocumentType.PRD);
    expect(event.targetDocument.affectedSections).toEqual(['scope']);
    expect(event.status).toBe('initiated');
    expect(event.cascadeDepth).toBe(1);
    expect(event.maxDepth).toBe(2);
    expect(event.timestamps.initiated).toBeTruthy();
  });

  it('adds cascade to active list', async () => {
    const state = createDefaultPipelineState();
    mockedReadPipelineState.mockResolvedValue(state);
    mockedScopeCascade.mockResolvedValue({
      affectedChildren: [],
      unaffectedChildren: [],
      allAffectedDocuments: [],
    });

    const controller = createController();
    const event = await controller.initiate(createDefaultRequest());

    expect(state.activeCascades).toContain(event.id);
    expect(mockedWritePipelineState).toHaveBeenCalledWith(state, expect.anything());
  });

  it('emits cascade_initiated event', async () => {
    const state = createDefaultPipelineState();
    mockedReadPipelineState.mockResolvedValue(state);
    mockedScopeCascade.mockResolvedValue({
      affectedChildren: [],
      unaffectedChildren: [],
      allAffectedDocuments: [],
    });

    const eventEmitter = createMockEventEmitter();
    const controller = createController({ eventEmitter });
    await controller.initiate(createDefaultRequest());

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'PIPE-2026-0408-001',
      'cascade_initiated',
      expect.objectContaining({
        targetDocumentId: 'PRD-001',
      }),
      'system',
      'PRD-001',
    );
  });

  it('escalates when depth limit exceeded', async () => {
    // Config with maxDepth 0 so depth 1 triggers escalation
    const config: PipelineConfig = {
      ...DEFAULT_PIPELINE_CONFIG,
      backwardCascade: {
        ...DEFAULT_PIPELINE_CONFIG.backwardCascade,
        maxDepth: 0,
      },
    };

    const eventEmitter = createMockEventEmitter();
    const controller = createController({ config, eventEmitter });
    const event = await controller.initiate(createDefaultRequest());

    expect(event.status).toBe('escalated');
    expect(event.timestamps.escalated).toBeTruthy();
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'PIPE-2026-0408-001',
      'human_escalation',
      expect.objectContaining({
        cascadeId: event.id,
      }),
      'system',
      'PRD-001',
    );
  });

  it('circuit breaker: same section cascaded twice triggers escalation', async () => {
    const state = createDefaultPipelineState();
    mockedReadPipelineState.mockResolvedValue(state);
    mockedScopeCascade.mockResolvedValue({
      affectedChildren: [],
      unaffectedChildren: [],
      allAffectedDocuments: [],
    });

    const eventEmitter = createMockEventEmitter();
    const controller = createController({ eventEmitter });

    // First cascade on 'scope' should succeed
    await controller.initiate(createDefaultRequest());

    // Reset state for second call
    const state2 = createDefaultPipelineState();
    state2.activeCascades = ['CASCADE-001-001'];
    mockedReadPipelineState.mockResolvedValue(state2);

    // Second cascade on same 'scope' section should trigger circuit breaker
    const event2 = await controller.initiate(createDefaultRequest());

    expect(event2.status).toBe('escalated');
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'PIPE-2026-0408-001',
      'human_escalation',
      expect.objectContaining({
        reason: expect.stringContaining('Circuit breaker'),
      }),
      'system',
      'PRD-001',
    );
  });
});

describe('BackwardCascadeController.resolve', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedWritePipelineState.mockResolvedValue(undefined);
  });

  it('removes cascade from active list', async () => {
    const state = createDefaultPipelineState();
    state.activeCascades = ['CASCADE-001-001', 'CASCADE-001-002'];
    mockedReadPipelineState.mockResolvedValue(state);

    const controller = createController();
    await controller.resolve('PIPE-2026-0408-001', 'CASCADE-001-001', 'system');

    expect(state.activeCascades).toEqual(['CASCADE-001-002']);
    expect(mockedWritePipelineState).toHaveBeenCalled();
  });

  it('emits cascade_resolved event', async () => {
    const state = createDefaultPipelineState();
    state.activeCascades = ['CASCADE-001-001'];
    mockedReadPipelineState.mockResolvedValue(state);

    const eventEmitter = createMockEventEmitter();
    const controller = createController({ eventEmitter });
    await controller.resolve('PIPE-2026-0408-001', 'CASCADE-001-001', 'system');

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'PIPE-2026-0408-001',
      'cascade_resolved',
      { cascadeId: 'CASCADE-001-001' },
      'system',
    );
  });

  it('throws if pipeline not found', async () => {
    mockedReadPipelineState.mockResolvedValue(null);

    const controller = createController();
    await expect(
      controller.resolve('PIPE-MISSING', 'CASCADE-001-001', 'system'),
    ).rejects.toThrow('Pipeline PIPE-MISSING not found');
  });
});

describe('BackwardCascadeController.escalate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits human_escalation event', async () => {
    const eventEmitter = createMockEventEmitter();
    const controller = createController({ eventEmitter });

    await controller.escalate(
      'PIPE-2026-0408-001',
      'CASCADE-001-001',
      'Repeated defect in scope section',
      'system',
    );

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'PIPE-2026-0408-001',
      'human_escalation',
      { cascadeId: 'CASCADE-001-001', reason: 'Repeated defect in scope section' },
      'system',
    );
  });
});
