import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DirectoryManager } from '../../../src/pipeline/storage/directory-manager';
import { DocumentType } from '../../../src/pipeline/types/document-type';
import { PipelineConfig, DEFAULT_PIPELINE_CONFIG } from '../../../src/pipeline/types/config';
import { QuotaEnforcer, QuotaExceededError } from '../../../src/pipeline/storage/quota-enforcer';

describe('QuotaEnforcer', () => {
  let tmpDir: string;
  let dm: DirectoryManager;
  const pipelineId = 'PIPE-2026-0408-001';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-enforcer-test-'));
    dm = new DirectoryManager(tmpDir);
    await dm.createPipelineDirs(pipelineId);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(overrides: Partial<PipelineConfig['storage']> = {}): PipelineConfig {
    return {
      ...DEFAULT_PIPELINE_CONFIG,
      storage: {
        ...DEFAULT_PIPELINE_CONFIG.storage,
        ...overrides,
      },
    };
  }

  async function createDocumentDir(type: DocumentType, docId: string): Promise<void> {
    await dm.createDocumentDirs(pipelineId, type, docId);
  }

  async function writeVersionFile(type: DocumentType, docId: string, version: string, content?: string): Promise<void> {
    const filePath = dm.getVersionFilePath(pipelineId, type, docId, version);
    await fs.writeFile(filePath, content ?? 'test content');
  }

  describe('checkDocumentLimit', () => {
    it('allows when under limit', async () => {
      const config = makeConfig({ maxDocumentsPerPipeline: 5 });
      const enforcer = new QuotaEnforcer(config, dm);

      // Create 2 documents (under limit of 5)
      await createDocumentDir(DocumentType.PRD, 'DOC-001');
      await createDocumentDir(DocumentType.PRD, 'DOC-002');

      await expect(enforcer.checkDocumentLimit(pipelineId)).resolves.toBeUndefined();
    });

    it('throws MAX_DOCUMENTS_EXCEEDED at limit', async () => {
      const config = makeConfig({ maxDocumentsPerPipeline: 2 });
      const enforcer = new QuotaEnforcer(config, dm);

      // Create exactly 2 documents (at limit)
      await createDocumentDir(DocumentType.PRD, 'DOC-001');
      await createDocumentDir(DocumentType.TDD, 'DOC-002');

      await expect(enforcer.checkDocumentLimit(pipelineId)).rejects.toThrow(QuotaExceededError);
      try {
        await enforcer.checkDocumentLimit(pipelineId);
      } catch (err) {
        expect(err).toBeInstanceOf(QuotaExceededError);
        expect((err as QuotaExceededError).violation).toBe('MAX_DOCUMENTS_EXCEEDED');
        expect((err as QuotaExceededError).limit).toBe(2);
        expect((err as QuotaExceededError).actual).toBe(2);
      }
    });
  });

  describe('checkVersionLimit', () => {
    it('allows when under limit', async () => {
      const config = makeConfig({ maxVersionsPerDocument: 5 });
      const enforcer = new QuotaEnforcer(config, dm);

      await createDocumentDir(DocumentType.PRD, 'DOC-001');
      await writeVersionFile(DocumentType.PRD, 'DOC-001', '1.0');
      await writeVersionFile(DocumentType.PRD, 'DOC-001', '1.1');

      await expect(
        enforcer.checkVersionLimit(pipelineId, 'PRD', 'DOC-001'),
      ).resolves.toBeUndefined();
    });

    it('throws MAX_VERSIONS_EXCEEDED at limit', async () => {
      const config = makeConfig({ maxVersionsPerDocument: 3 });
      const enforcer = new QuotaEnforcer(config, dm);

      await createDocumentDir(DocumentType.PRD, 'DOC-001');
      await writeVersionFile(DocumentType.PRD, 'DOC-001', '1.0');
      await writeVersionFile(DocumentType.PRD, 'DOC-001', '1.1');
      await writeVersionFile(DocumentType.PRD, 'DOC-001', '1.2');

      await expect(
        enforcer.checkVersionLimit(pipelineId, 'PRD', 'DOC-001'),
      ).rejects.toThrow(QuotaExceededError);
      try {
        await enforcer.checkVersionLimit(pipelineId, 'PRD', 'DOC-001');
      } catch (err) {
        expect(err).toBeInstanceOf(QuotaExceededError);
        expect((err as QuotaExceededError).violation).toBe('MAX_VERSIONS_EXCEEDED');
        expect((err as QuotaExceededError).limit).toBe(3);
        expect((err as QuotaExceededError).actual).toBe(3);
      }
    });
  });

  describe('checkTotalSizeLimit', () => {
    it('allows when under limit', async () => {
      const config = makeConfig({ maxTotalSizeBytes: 10000 });
      const enforcer = new QuotaEnforcer(config, dm);

      // Pipeline dir has minimal files from createPipelineDirs
      await expect(enforcer.checkTotalSizeLimit(pipelineId)).resolves.toBeUndefined();
    });

    it('throws MAX_TOTAL_SIZE_EXCEEDED at limit', async () => {
      const config = makeConfig({ maxTotalSizeBytes: 50 });
      const enforcer = new QuotaEnforcer(config, dm);

      // Write enough data to exceed 50 bytes
      await createDocumentDir(DocumentType.PRD, 'DOC-001');
      await writeVersionFile(DocumentType.PRD, 'DOC-001', '1.0', 'x'.repeat(100));

      await expect(enforcer.checkTotalSizeLimit(pipelineId)).rejects.toThrow(QuotaExceededError);
      try {
        await enforcer.checkTotalSizeLimit(pipelineId);
      } catch (err) {
        expect(err).toBeInstanceOf(QuotaExceededError);
        expect((err as QuotaExceededError).violation).toBe('MAX_TOTAL_SIZE_EXCEEDED');
        expect((err as QuotaExceededError).limit).toBe(50);
      }
    });
  });

  describe('checkDocumentSizeLimit', () => {
    it('allows content under limit', () => {
      const config = makeConfig({ maxDocumentSizeBytes: 1024 });
      const enforcer = new QuotaEnforcer(config, dm);

      expect(() => enforcer.checkDocumentSizeLimit('small content')).not.toThrow();
    });

    it('throws MAX_DOCUMENT_SIZE_EXCEEDED for oversized content', () => {
      const config = makeConfig({ maxDocumentSizeBytes: 10 });
      const enforcer = new QuotaEnforcer(config, dm);

      const bigContent = 'x'.repeat(50);
      expect(() => enforcer.checkDocumentSizeLimit(bigContent)).toThrow(QuotaExceededError);
      try {
        enforcer.checkDocumentSizeLimit(bigContent);
      } catch (err) {
        expect(err).toBeInstanceOf(QuotaExceededError);
        expect((err as QuotaExceededError).violation).toBe('MAX_DOCUMENT_SIZE_EXCEEDED');
        expect((err as QuotaExceededError).limit).toBe(10);
        expect((err as QuotaExceededError).actual).toBe(50);
      }
    });
  });

  describe('uses configured limits, not hardcoded defaults', () => {
    it('uses custom maxDocumentsPerPipeline', async () => {
      const config = makeConfig({ maxDocumentsPerPipeline: 1 });
      const enforcer = new QuotaEnforcer(config, dm);

      await createDocumentDir(DocumentType.PRD, 'DOC-001');
      await expect(enforcer.checkDocumentLimit(pipelineId)).rejects.toThrow(QuotaExceededError);
    });

    it('uses custom maxVersionsPerDocument', async () => {
      const config = makeConfig({ maxVersionsPerDocument: 1 });
      const enforcer = new QuotaEnforcer(config, dm);

      await createDocumentDir(DocumentType.PRD, 'DOC-001');
      await writeVersionFile(DocumentType.PRD, 'DOC-001', '1.0');

      await expect(
        enforcer.checkVersionLimit(pipelineId, 'PRD', 'DOC-001'),
      ).rejects.toThrow(QuotaExceededError);
    });

    it('uses custom maxDocumentSizeBytes', () => {
      const config = makeConfig({ maxDocumentSizeBytes: 5 });
      const enforcer = new QuotaEnforcer(config, dm);

      expect(() => enforcer.checkDocumentSizeLimit('123456')).toThrow(QuotaExceededError);
    });
  });

  describe('checkBeforeDocumentCreate', () => {
    it('runs all 3 relevant checks', async () => {
      // Set tight limits so we can verify each check fires
      const config = makeConfig({
        maxDocumentsPerPipeline: 100,
        maxTotalSizeBytes: 100 * 1024 * 1024,
        maxDocumentSizeBytes: 1024,
      });
      const enforcer = new QuotaEnforcer(config, dm);

      // Should pass when everything is under limit
      await expect(
        enforcer.checkBeforeDocumentCreate(pipelineId, 'small content'),
      ).resolves.toBeUndefined();
    });

    it('fails on document limit', async () => {
      const config = makeConfig({ maxDocumentsPerPipeline: 1 });
      const enforcer = new QuotaEnforcer(config, dm);

      await createDocumentDir(DocumentType.PRD, 'DOC-001');

      await expect(
        enforcer.checkBeforeDocumentCreate(pipelineId, 'content'),
      ).rejects.toThrow(QuotaExceededError);
    });

    it('fails on document size limit', async () => {
      const config = makeConfig({ maxDocumentSizeBytes: 5 });
      const enforcer = new QuotaEnforcer(config, dm);

      await expect(
        enforcer.checkBeforeDocumentCreate(pipelineId, 'this is way too long'),
      ).rejects.toThrow(QuotaExceededError);
    });
  });

  describe('checkBeforeVersionWrite', () => {
    it('runs all 3 relevant checks', async () => {
      const config = makeConfig({
        maxVersionsPerDocument: 100,
        maxTotalSizeBytes: 100 * 1024 * 1024,
        maxDocumentSizeBytes: 1024,
      });
      const enforcer = new QuotaEnforcer(config, dm);

      await createDocumentDir(DocumentType.PRD, 'DOC-001');

      await expect(
        enforcer.checkBeforeVersionWrite(pipelineId, 'PRD', 'DOC-001', 'small'),
      ).resolves.toBeUndefined();
    });

    it('fails on version limit', async () => {
      const config = makeConfig({ maxVersionsPerDocument: 1 });
      const enforcer = new QuotaEnforcer(config, dm);

      await createDocumentDir(DocumentType.PRD, 'DOC-001');
      await writeVersionFile(DocumentType.PRD, 'DOC-001', '1.0');

      await expect(
        enforcer.checkBeforeVersionWrite(pipelineId, 'PRD', 'DOC-001', 'content'),
      ).rejects.toThrow(QuotaExceededError);
    });

    it('fails on document size limit', async () => {
      const config = makeConfig({ maxDocumentSizeBytes: 5 });
      const enforcer = new QuotaEnforcer(config, dm);

      await createDocumentDir(DocumentType.PRD, 'DOC-001');

      await expect(
        enforcer.checkBeforeVersionWrite(pipelineId, 'PRD', 'DOC-001', 'way too long content'),
      ).rejects.toThrow(QuotaExceededError);
    });
  });
});
