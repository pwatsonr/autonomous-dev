import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import yaml from 'js-yaml';
import { readPipelineState, writePipelineState } from '../../../src/pipeline/flow/pipeline-state-io';
import { createInitialPipelineState, PipelineState, DocumentState } from '../../../src/pipeline/flow/pipeline-state';
import { DirectoryManager } from '../../../src/pipeline/storage/directory-manager';
import { DocumentType } from '../../../src/pipeline/types/document-type';

describe('pipeline-state-io', () => {
  let tmpDir: string;
  let directoryManager: DirectoryManager;
  const pipelineId = 'PIPE-2026-0408-001';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-state-io-test-'));
    directoryManager = new DirectoryManager(tmpDir);
    // Create pipeline directory so pipeline.yaml can be written
    await directoryManager.createPipelineDirs(pipelineId);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('writePipelineState', () => {
    it('writes valid YAML', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      await writePipelineState(state, directoryManager);

      const statePath = directoryManager.getPipelineYamlPath(pipelineId);
      const content = await fs.readFile(statePath, 'utf-8');

      // Should not throw when parsing
      const parsed = yaml.load(content) as Record<string, unknown>;
      expect(parsed).toBeDefined();
      expect(parsed['pipeline_id']).toBe(pipelineId);
    });

    it('uses atomic write', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      await writePipelineState(state, directoryManager);

      // File should exist at the pipeline.yaml path (not a .tmp file)
      const statePath = directoryManager.getPipelineYamlPath(pipelineId);
      const stat = await fs.stat(statePath);
      expect(stat.isFile()).toBe(true);

      // No leftover .tmp files
      const pipeDir = directoryManager.getPipelineDir(pipelineId);
      const files = await fs.readdir(pipeDir);
      const tmpFiles = files.filter(f => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('updates updatedAt timestamp', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      const originalUpdatedAt = state.updatedAt;

      // Small delay to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));
      await writePipelineState(state, directoryManager);

      // The state object should have been mutated with a new updatedAt
      expect(state.updatedAt).not.toBe(originalUpdatedAt);
      expect(new Date(state.updatedAt).getTime()).toBeGreaterThan(
        new Date(originalUpdatedAt).getTime(),
      );
    });

    it('YAML uses snake_case keys (pipeline_id, not pipelineId)', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      await writePipelineState(state, directoryManager);

      const statePath = directoryManager.getPipelineYamlPath(pipelineId);
      const content = await fs.readFile(statePath, 'utf-8');

      // snake_case keys should be present
      expect(content).toContain('pipeline_id:');
      expect(content).toContain('created_at:');
      expect(content).toContain('updated_at:');
      expect(content).toContain('paused_at:');
      expect(content).toContain('document_states:');
      expect(content).toContain('active_cascades:');

      // camelCase keys should NOT be present
      expect(content).not.toContain('pipelineId:');
      expect(content).not.toContain('createdAt:');
      expect(content).not.toContain('updatedAt:');
      expect(content).not.toContain('pausedAt:');
      expect(content).not.toContain('documentStates:');
      expect(content).not.toContain('activeCascades:');
    });
  });

  describe('readPipelineState', () => {
    it('reads back correct state', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X', 'high');
      await writePipelineState(state, directoryManager);

      const readState = await readPipelineState(pipelineId, directoryManager);
      expect(readState).not.toBeNull();
      expect(readState!.pipelineId).toBe(pipelineId);
      expect(readState!.title).toBe('Feature X');
      expect(readState!.status).toBe('ACTIVE');
      expect(readState!.priority).toBe('high');
    });

    it('returns null for non-existent file', async () => {
      const result = await readPipelineState('NON-EXISTENT', directoryManager);
      expect(result).toBeNull();
    });
  });

  describe('round-trip', () => {
    it('write -> read preserves all fields', async () => {
      const state = createInitialPipelineState(pipelineId, 'Feature X', 'critical');

      // Add a document state to test nested serialization
      const docState: DocumentState = {
        documentId: 'PRD-001',
        type: DocumentType.PRD,
        status: 'draft',
        version: '1.0',
        reviewIteration: 0,
        lastReviewScore: null,
        assignedAgent: null,
        parentId: null,
        children: [],
        blockedBy: [],
        blocking: [],
      };
      state.documentStates['PRD-001'] = docState;
      state.metrics.totalDocuments = 1;
      state.metrics.documentsByStatus = { draft: 1 };
      state.metrics.totalVersions = 1;
      state.activeCascades = ['CASCADE-001'];

      await writePipelineState(state, directoryManager);
      const readState = await readPipelineState(pipelineId, directoryManager);

      expect(readState).not.toBeNull();
      expect(readState!.pipelineId).toBe(pipelineId);
      expect(readState!.title).toBe('Feature X');
      expect(readState!.status).toBe('ACTIVE');
      expect(readState!.priority).toBe('critical');
      expect(readState!.pausedAt).toBeNull();
      expect(readState!.activeCascades).toEqual(['CASCADE-001']);

      // Verify timestamps are preserved (updatedAt will be updated by write)
      expect(readState!.createdAt).toBe(state.createdAt);
      expect(readState!.updatedAt).toBe(state.updatedAt);

      // Verify metrics
      expect(readState!.metrics.totalDocuments).toBe(1);
      expect(readState!.metrics.documentsByStatus).toEqual({ draft: 1 });
      expect(readState!.metrics.totalVersions).toBe(1);
      expect(readState!.metrics.totalReviews).toBe(0);

      // Verify document state
      const readDoc = readState!.documentStates['PRD-001'];
      expect(readDoc).toBeDefined();
      expect(readDoc.documentId).toBe('PRD-001');
      expect(readDoc.type).toBe(DocumentType.PRD);
      expect(readDoc.status).toBe('draft');
      expect(readDoc.version).toBe('1.0');
      expect(readDoc.reviewIteration).toBe(0);
      expect(readDoc.lastReviewScore).toBeNull();
      expect(readDoc.assignedAgent).toBeNull();
      expect(readDoc.parentId).toBeNull();
      expect(readDoc.children).toEqual([]);
      expect(readDoc.blockedBy).toEqual([]);
      expect(readDoc.blocking).toEqual([]);
    });

    it('round-trip with populated document state', async () => {
      const state = createInitialPipelineState(pipelineId, 'Complex Pipeline', 'high');

      // Add a document with all fields populated
      const docState: DocumentState = {
        documentId: 'TDD-001-01',
        type: DocumentType.TDD,
        status: 'in-review',
        version: '1.1',
        reviewIteration: 2,
        lastReviewScore: 85.5,
        assignedAgent: 'reviewer-agent',
        parentId: 'PRD-001',
        children: ['PLAN-001-01', 'PLAN-001-02'],
        blockedBy: ['PRD-001'],
        blocking: ['PLAN-001-01'],
      };
      state.documentStates['TDD-001-01'] = docState;

      await writePipelineState(state, directoryManager);
      const readState = await readPipelineState(pipelineId, directoryManager);

      const readDoc = readState!.documentStates['TDD-001-01'];
      expect(readDoc.documentId).toBe('TDD-001-01');
      expect(readDoc.type).toBe(DocumentType.TDD);
      expect(readDoc.status).toBe('in-review');
      expect(readDoc.version).toBe('1.1');
      expect(readDoc.reviewIteration).toBe(2);
      expect(readDoc.lastReviewScore).toBe(85.5);
      expect(readDoc.assignedAgent).toBe('reviewer-agent');
      expect(readDoc.parentId).toBe('PRD-001');
      expect(readDoc.children).toEqual(['PLAN-001-01', 'PLAN-001-02']);
      expect(readDoc.blockedBy).toEqual(['PRD-001']);
      expect(readDoc.blocking).toEqual(['PLAN-001-01']);
    });
  });

  describe('nested document_states deserialized correctly', () => {
    it('multiple documents are deserialized', async () => {
      const state = createInitialPipelineState(pipelineId, 'Multi-doc');

      state.documentStates['PRD-001'] = {
        documentId: 'PRD-001',
        type: DocumentType.PRD,
        status: 'approved',
        version: '1.0',
        reviewIteration: 1,
        lastReviewScore: 92,
        assignedAgent: null,
        parentId: null,
        children: ['TDD-001'],
        blockedBy: [],
        blocking: ['TDD-001'],
      };

      state.documentStates['TDD-001'] = {
        documentId: 'TDD-001',
        type: DocumentType.TDD,
        status: 'draft',
        version: '1.0',
        reviewIteration: 0,
        lastReviewScore: null,
        assignedAgent: 'tdd-writer',
        parentId: 'PRD-001',
        children: [],
        blockedBy: ['PRD-001'],
        blocking: [],
      };

      await writePipelineState(state, directoryManager);
      const readState = await readPipelineState(pipelineId, directoryManager);

      expect(Object.keys(readState!.documentStates)).toHaveLength(2);
      expect(readState!.documentStates['PRD-001']).toBeDefined();
      expect(readState!.documentStates['TDD-001']).toBeDefined();
      expect(readState!.documentStates['PRD-001'].status).toBe('approved');
      expect(readState!.documentStates['TDD-001'].assignedAgent).toBe('tdd-writer');
    });
  });
});
