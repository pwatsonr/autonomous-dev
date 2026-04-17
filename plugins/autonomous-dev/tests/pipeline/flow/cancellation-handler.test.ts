import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { cancelPipeline } from '../../../src/pipeline/flow/cancellation-handler';
import { createInitialPipelineState, DocumentState } from '../../../src/pipeline/flow/pipeline-state';
import { writePipelineState, readPipelineState } from '../../../src/pipeline/flow/pipeline-state-io';
import { DirectoryManager } from '../../../src/pipeline/storage/directory-manager';
import { DocumentType } from '../../../src/pipeline/types/document-type';

describe('cancellation-handler', () => {
  let tmpDir: string;
  let directoryManager: DirectoryManager;
  const pipelineId = 'PIPE-2026-0408-001';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cancellation-test-'));
    directoryManager = new DirectoryManager(tmpDir);
    await directoryManager.createPipelineDirs(pipelineId);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('full cancel', () => {
    it('pipeline status becomes CANCELLED', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      await writePipelineState(state, directoryManager);

      const result = await cancelPipeline(pipelineId, directoryManager, 'full');

      expect(result.success).toBe(true);
      expect(result.mode).toBe('full');

      const readState = await readPipelineState(pipelineId, directoryManager);
      expect(readState!.status).toBe('CANCELLED');
    });

    it('draft documents become cancelled', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      state.documentStates['PRD-001'] = makeDocState('PRD-001', DocumentType.PRD, 'draft');
      await writePipelineState(state, directoryManager);

      const result = await cancelPipeline(pipelineId, directoryManager, 'full');

      expect(result.cancelledDocuments).toContain('PRD-001');

      const readState = await readPipelineState(pipelineId, directoryManager);
      expect(readState!.documentStates['PRD-001'].status).toBe('cancelled');
    });

    it('in-review documents become cancelled', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      state.documentStates['TDD-001'] = makeDocState('TDD-001', DocumentType.TDD, 'in-review');
      await writePipelineState(state, directoryManager);

      const result = await cancelPipeline(pipelineId, directoryManager, 'full');

      expect(result.cancelledDocuments).toContain('TDD-001');

      const readState = await readPipelineState(pipelineId, directoryManager);
      expect(readState!.documentStates['TDD-001'].status).toBe('cancelled');
    });

    it('approved documents preserved', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      state.documentStates['PRD-001'] = makeDocState('PRD-001', DocumentType.PRD, 'approved');
      await writePipelineState(state, directoryManager);

      const result = await cancelPipeline(pipelineId, directoryManager, 'full');

      expect(result.preservedDocuments).toContain('PRD-001');
      expect(result.cancelledDocuments).not.toContain('PRD-001');

      const readState = await readPipelineState(pipelineId, directoryManager);
      expect(readState!.documentStates['PRD-001'].status).toBe('approved');
    });

    it('rejected documents preserved', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      state.documentStates['PRD-001'] = makeDocState('PRD-001', DocumentType.PRD, 'rejected');
      await writePipelineState(state, directoryManager);

      const result = await cancelPipeline(pipelineId, directoryManager, 'full');

      expect(result.preservedDocuments).toContain('PRD-001');

      const readState = await readPipelineState(pipelineId, directoryManager);
      expect(readState!.documentStates['PRD-001'].status).toBe('rejected');
    });

    it('stale and revision-requested documents become cancelled', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      state.documentStates['DOC-001'] = makeDocState('DOC-001', DocumentType.PRD, 'stale');
      state.documentStates['DOC-002'] = makeDocState('DOC-002', DocumentType.TDD, 'revision-requested');
      await writePipelineState(state, directoryManager);

      const result = await cancelPipeline(pipelineId, directoryManager, 'full');

      expect(result.cancelledDocuments).toContain('DOC-001');
      expect(result.cancelledDocuments).toContain('DOC-002');
    });
  });

  describe('subtree cancel', () => {
    it('only root and descendants cancelled', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');

      // Tree: PRD-001 -> TDD-001 -> PLAN-001
      const prd = makeDocState('PRD-001', DocumentType.PRD, 'approved');
      prd.children = ['TDD-001'];
      state.documentStates['PRD-001'] = prd;

      const tdd = makeDocState('TDD-001', DocumentType.TDD, 'draft');
      tdd.parentId = 'PRD-001';
      tdd.children = ['PLAN-001'];
      state.documentStates['TDD-001'] = tdd;

      const plan = makeDocState('PLAN-001', DocumentType.PLAN, 'draft');
      plan.parentId = 'TDD-001';
      state.documentStates['PLAN-001'] = plan;

      await writePipelineState(state, directoryManager);

      const result = await cancelPipeline(pipelineId, directoryManager, 'subtree', 'TDD-001', 'user-1');

      expect(result.cancelledDocuments).toContain('TDD-001');
      expect(result.cancelledDocuments).toContain('PLAN-001');
      // PRD-001 is not in subtree of TDD-001
      expect(result.cancelledDocuments).not.toContain('PRD-001');
    });

    it('siblings unaffected', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');

      const prd = makeDocState('PRD-001', DocumentType.PRD, 'approved');
      prd.children = ['TDD-001', 'TDD-002'];
      state.documentStates['PRD-001'] = prd;

      const tdd1 = makeDocState('TDD-001', DocumentType.TDD, 'draft');
      tdd1.parentId = 'PRD-001';
      state.documentStates['TDD-001'] = tdd1;

      const tdd2 = makeDocState('TDD-002', DocumentType.TDD, 'draft');
      tdd2.parentId = 'PRD-001';
      state.documentStates['TDD-002'] = tdd2;

      await writePipelineState(state, directoryManager);

      const result = await cancelPipeline(pipelineId, directoryManager, 'subtree', 'TDD-001', 'user-1');

      expect(result.cancelledDocuments).toContain('TDD-001');
      expect(result.cancelledDocuments).not.toContain('TDD-002');

      const readState = await readPipelineState(pipelineId, directoryManager);
      expect(readState!.documentStates['TDD-002'].status).toBe('draft');
    });

    it('pipeline status remains ACTIVE', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      state.documentStates['PRD-001'] = makeDocState('PRD-001', DocumentType.PRD, 'draft');
      await writePipelineState(state, directoryManager);

      await cancelPipeline(pipelineId, directoryManager, 'subtree', 'PRD-001', 'user-1');

      const readState = await readPipelineState(pipelineId, directoryManager);
      expect(readState!.status).toBe('ACTIVE');
    });

    it('requires rootDocumentId', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      await writePipelineState(state, directoryManager);

      await expect(
        cancelPipeline(pipelineId, directoryManager, 'subtree'),
      ).rejects.toThrow('rootDocumentId required for subtree cancellation');
    });

    it('preserves terminal documents in subtree', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');

      const prd = makeDocState('PRD-001', DocumentType.PRD, 'draft');
      prd.children = ['TDD-001'];
      state.documentStates['PRD-001'] = prd;

      const tdd = makeDocState('TDD-001', DocumentType.TDD, 'approved');
      tdd.parentId = 'PRD-001';
      state.documentStates['TDD-001'] = tdd;

      await writePipelineState(state, directoryManager);

      const result = await cancelPipeline(pipelineId, directoryManager, 'subtree', 'PRD-001', 'user-1');

      expect(result.cancelledDocuments).toContain('PRD-001');
      expect(result.preservedDocuments).toContain('TDD-001');

      const readState = await readPipelineState(pipelineId, directoryManager);
      expect(readState!.documentStates['TDD-001'].status).toBe('approved');
    });
  });

  it('throws for non-existent pipeline', async () => {
    await expect(
      cancelPipeline('NON-EXISTENT', directoryManager, 'full'),
    ).rejects.toThrow('Pipeline NON-EXISTENT not found');
  });
});

function makeDocState(
  documentId: string,
  type: DocumentType,
  status: string,
): DocumentState {
  return {
    documentId,
    type,
    status: status as DocumentState['status'],
    version: '1.0',
    reviewIteration: 0,
    lastReviewScore: null,
    assignedAgent: null,
    parentId: null,
    children: [],
    blockedBy: [],
    blocking: [],
  };
}
