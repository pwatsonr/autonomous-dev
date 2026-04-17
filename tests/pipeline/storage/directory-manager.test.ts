import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DirectoryManager } from '../../../src/pipeline/storage/directory-manager';
import { DocumentType } from '../../../src/pipeline/types/document-type';

describe('DirectoryManager', () => {
  const rootDir = '/test/root/.autonomous-dev/pipelines';
  const pipelineId = 'PIPE-2026-0408-001';
  const documentId = 'DOC-001';
  let dm: DirectoryManager;

  beforeEach(() => {
    dm = new DirectoryManager(rootDir);
  });

  describe('path computation', () => {
    it('getPipelineDir returns {rootDir}/{pipelineId}', () => {
      expect(dm.getPipelineDir(pipelineId)).toBe(
        path.join(rootDir, pipelineId),
      );
    });

    it('getDocumentDir returns correct nested path for each type', () => {
      for (const type of Object.values(DocumentType)) {
        const expected = path.join(rootDir, pipelineId, 'documents', type, documentId);
        expect(dm.getDocumentDir(pipelineId, type, documentId)).toBe(expected);
      }
    });

    it('getVersionFilePath returns {docDir}/v{version}.md', () => {
      const expected = path.join(
        rootDir, pipelineId, 'documents', 'PRD', documentId, 'v1.0.md',
      );
      expect(dm.getVersionFilePath(pipelineId, DocumentType.PRD, documentId, '1.0')).toBe(expected);
    });

    it('getCurrentSymlinkPath returns {docDir}/current.md', () => {
      const expected = path.join(
        rootDir, pipelineId, 'documents', 'PRD', documentId, 'current.md',
      );
      expect(dm.getCurrentSymlinkPath(pipelineId, DocumentType.PRD, documentId)).toBe(expected);
    });

    it('getReviewsDir returns {docDir}/reviews', () => {
      const expected = path.join(
        rootDir, pipelineId, 'documents', 'TDD', documentId, 'reviews',
      );
      expect(dm.getReviewsDir(pipelineId, DocumentType.TDD, documentId)).toBe(expected);
    });

    it('getDiffsDir returns {docDir}/diffs', () => {
      const expected = path.join(
        rootDir, pipelineId, 'documents', 'SPEC', documentId, 'diffs',
      );
      expect(dm.getDiffsDir(pipelineId, DocumentType.SPEC, documentId)).toBe(expected);
    });

    it('getPipelineYamlPath returns {pipeDir}/pipeline.yaml', () => {
      expect(dm.getPipelineYamlPath(pipelineId)).toBe(
        path.join(rootDir, pipelineId, 'pipeline.yaml'),
      );
    });

    it('getAuditLogPath returns {pipeDir}/audit.log', () => {
      expect(dm.getAuditLogPath(pipelineId)).toBe(
        path.join(rootDir, pipelineId, 'audit.log'),
      );
    });
  });

  describe('directory creation', () => {
    let tmpDir: string;
    let realDm: DirectoryManager;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dir-manager-test-'));
      realDm = new DirectoryManager(tmpDir);
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('createDocumentDirs creates document dir and subdirectories', async () => {
      await realDm.createDocumentDirs(pipelineId, DocumentType.PRD, documentId);

      const docDir = realDm.getDocumentDir(pipelineId, DocumentType.PRD, documentId);
      const reviewsDir = path.join(docDir, 'reviews');
      const diffsDir = path.join(docDir, 'diffs');

      // All three directories should exist
      const docStat = await fs.stat(docDir);
      expect(docStat.isDirectory()).toBe(true);

      const reviewsStat = await fs.stat(reviewsDir);
      expect(reviewsStat.isDirectory()).toBe(true);

      const diffsStat = await fs.stat(diffsDir);
      expect(diffsStat.isDirectory()).toBe(true);
    });

    it('createPipelineDirs creates pipeline dir and subdirectories', async () => {
      await realDm.createPipelineDirs(pipelineId);

      const pipeDir = realDm.getPipelineDir(pipelineId);
      const documentsDir = path.join(pipeDir, 'documents');
      const decompositionDir = path.join(pipeDir, 'decomposition');

      const pipeStat = await fs.stat(pipeDir);
      expect(pipeStat.isDirectory()).toBe(true);

      const docsStat = await fs.stat(documentsDir);
      expect(docsStat.isDirectory()).toBe(true);

      const decompStat = await fs.stat(decompositionDir);
      expect(decompStat.isDirectory()).toBe(true);
    });
  });
});
