import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { pausePipeline, resumePipeline } from '../../../src/pipeline/flow/pause-resume-handler';
import { createInitialPipelineState, DocumentState } from '../../../src/pipeline/flow/pipeline-state';
import { writePipelineState, readPipelineState } from '../../../src/pipeline/flow/pipeline-state-io';
import { DirectoryManager } from '../../../src/pipeline/storage/directory-manager';
import { DocumentType } from '../../../src/pipeline/types/document-type';

describe('pause-resume-handler', () => {
  let tmpDir: string;
  let directoryManager: DirectoryManager;
  const pipelineId = 'PIPE-2026-0408-001';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pause-resume-test-'));
    directoryManager = new DirectoryManager(tmpDir);
    await directoryManager.createPipelineDirs(pipelineId);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('pausePipeline', () => {
    it('ACTIVE -> PAUSED with timestamp', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      await writePipelineState(state, directoryManager);

      const before = new Date().toISOString();
      const result = await pausePipeline(pipelineId, directoryManager, 'user-1');
      const after = new Date().toISOString();

      expect(result.success).toBe(true);
      expect(result.wasAlreadyPaused).toBe(false);
      expect(result.pausedAt).not.toBeNull();
      expect(result.pausedAt! >= before).toBe(true);
      expect(result.pausedAt! <= after).toBe(true);

      const readState = await readPipelineState(pipelineId, directoryManager);
      expect(readState!.status).toBe('PAUSED');
      expect(readState!.pausedAt).toBe(result.pausedAt);
    });

    it('already PAUSED -> no-op', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      await writePipelineState(state, directoryManager);

      // Pause once
      await pausePipeline(pipelineId, directoryManager, 'user-1');

      // Pause again
      const result = await pausePipeline(pipelineId, directoryManager, 'user-1');
      expect(result.success).toBe(true);
      expect(result.wasAlreadyPaused).toBe(true);
      expect(result.pausedAt).not.toBeNull();
    });

    it('CANCELLED -> throws', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      state.status = 'CANCELLED';
      await writePipelineState(state, directoryManager);

      await expect(pausePipeline(pipelineId, directoryManager, 'user-1')).rejects.toThrow(
        'Cannot pause pipeline in CANCELLED state',
      );
    });

    it('documents retain their status', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      state.documentStates['PRD-001'] = makeDocState('PRD-001', DocumentType.PRD, 'draft');
      state.documentStates['TDD-001'] = makeDocState('TDD-001', DocumentType.TDD, 'in-review');
      state.documentStates['PLAN-001'] = makeDocState('PLAN-001', DocumentType.PLAN, 'approved');
      await writePipelineState(state, directoryManager);

      await pausePipeline(pipelineId, directoryManager, 'user-1');

      const readState = await readPipelineState(pipelineId, directoryManager);
      expect(readState!.documentStates['PRD-001'].status).toBe('draft');
      expect(readState!.documentStates['TDD-001'].status).toBe('in-review');
      expect(readState!.documentStates['PLAN-001'].status).toBe('approved');
    });

    it('throws for non-existent pipeline', async () => {
      await expect(
        pausePipeline('NON-EXISTENT', directoryManager, 'user-1'),
      ).rejects.toThrow('Pipeline NON-EXISTENT not found');
    });
  });

  describe('resumePipeline', () => {
    it('PAUSED -> ACTIVE, clears paused_at', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      await writePipelineState(state, directoryManager);
      await pausePipeline(pipelineId, directoryManager, 'user-1');

      const result = await resumePipeline(pipelineId, directoryManager, 'user-1');

      expect(result.success).toBe(true);
      expect(result.wasAlreadyActive).toBe(false);

      const readState = await readPipelineState(pipelineId, directoryManager);
      expect(readState!.status).toBe('ACTIVE');
      expect(readState!.pausedAt).toBeNull();
    });

    it('not PAUSED -> no-op', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      await writePipelineState(state, directoryManager);

      const result = await resumePipeline(pipelineId, directoryManager, 'user-1');
      expect(result.success).toBe(true);
      expect(result.wasAlreadyActive).toBe(true);
      expect(result.readyDocuments).toEqual([]);
    });

    it('identifies ready documents', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');

      // PRD-001 is approved (dependency met)
      state.documentStates['PRD-001'] = makeDocState('PRD-001', DocumentType.PRD, 'approved');

      // TDD-001 is draft, blocked by PRD-001 (which is approved) -> ready
      const tdd = makeDocState('TDD-001', DocumentType.TDD, 'draft');
      tdd.blockedBy = ['PRD-001'];
      state.documentStates['TDD-001'] = tdd;

      // PLAN-001 is revision-requested, no blockers -> ready
      state.documentStates['PLAN-001'] = makeDocState('PLAN-001', DocumentType.PLAN, 'revision-requested');

      state.status = 'PAUSED';
      state.pausedAt = new Date().toISOString();
      await writePipelineState(state, directoryManager);

      const result = await resumePipeline(pipelineId, directoryManager, 'user-1');

      expect(result.readyDocuments).toContain('TDD-001');
      expect(result.readyDocuments).toContain('PLAN-001');
      expect(result.readyDocuments).not.toContain('PRD-001');
    });

    it('draft with unmet dependency not in readyDocuments', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');

      // PRD-001 is draft (not approved)
      state.documentStates['PRD-001'] = makeDocState('PRD-001', DocumentType.PRD, 'draft');

      // TDD-001 blocked by PRD-001 (which is NOT approved) -> not ready
      const tdd = makeDocState('TDD-001', DocumentType.TDD, 'draft');
      tdd.blockedBy = ['PRD-001'];
      state.documentStates['TDD-001'] = tdd;

      state.status = 'PAUSED';
      state.pausedAt = new Date().toISOString();
      await writePipelineState(state, directoryManager);

      const result = await resumePipeline(pipelineId, directoryManager, 'user-1');

      // PRD-001 is draft with no blockers -> ready
      expect(result.readyDocuments).toContain('PRD-001');
      // TDD-001 has unmet dependency -> not ready
      expect(result.readyDocuments).not.toContain('TDD-001');
    });

    it('throws for non-existent pipeline', async () => {
      await expect(
        resumePipeline('NON-EXISTENT', directoryManager, 'user-1'),
      ).rejects.toThrow('Pipeline NON-EXISTENT not found');
    });
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
