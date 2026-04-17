import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DirectoryManager } from '../../../src/pipeline/storage/directory-manager';
import { TemplateEngine } from '../../../src/pipeline/template-engine/template-engine';
import { InMemoryIdCounter } from '../../../src/pipeline/frontmatter/id-generator';
import { DocumentType } from '../../../src/pipeline/types/document-type';
import { createDocument, CreateDocumentRequest } from '../../../src/pipeline/storage/document-creator';
import {
  readDocument,
  readVersion,
  DocumentNotFoundError,
} from '../../../src/pipeline/storage/document-reader';

describe('document-reader', () => {
  let tmpDir: string;
  let dm: DirectoryManager;
  let templateEngine: TemplateEngine;
  let idCounter: InMemoryIdCounter;
  const pipelineId = 'PIPE-2026-0408-001';

  function makeRequest(overrides?: Partial<CreateDocumentRequest>): CreateDocumentRequest {
    return {
      pipelineId,
      type: DocumentType.PRD,
      title: 'Test PRD',
      authorAgent: 'agent-prd-writer',
      parentId: null,
      tracesFrom: [],
      depth: 0,
      siblingIndex: 0,
      siblingCount: 1,
      dependsOn: [],
      dependencyType: [],
      executionMode: 'sequential',
      priority: 'normal',
      ...overrides,
    };
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-reader-test-'));
    dm = new DirectoryManager(tmpDir);
    templateEngine = new TemplateEngine();
    idCounter = new InMemoryIdCounter();
    await dm.createPipelineDirs(pipelineId);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('readDocument', () => {
    it('returns content from current.md symlink', async () => {
      const handle = await createDocument(makeRequest(), dm, templateEngine, idCounter);

      const content = await readDocument(pipelineId, DocumentType.PRD, handle.documentId, dm);

      expect(content.rawContent).toBeDefined();
      expect(content.rawContent.length).toBeGreaterThan(0);
    });

    it('returns parsed frontmatter and body', async () => {
      const handle = await createDocument(makeRequest(), dm, templateEngine, idCounter);

      const content = await readDocument(pipelineId, DocumentType.PRD, handle.documentId, dm);

      expect(content.frontmatter).toBeDefined();
      expect(content.frontmatter.id).toBe(handle.documentId);
      expect(content.frontmatter.title).toBe('Test PRD');
      expect(content.body).toBeDefined();
      expect(typeof content.body).toBe('string');
    });

    it('throws DocumentNotFoundError for missing document', async () => {
      await expect(
        readDocument(pipelineId, DocumentType.PRD, 'nonexistent-doc', dm),
      ).rejects.toThrow(DocumentNotFoundError);
    });

    it('resolves symlink to actual file path', async () => {
      const handle = await createDocument(makeRequest(), dm, templateEngine, idCounter);

      const content = await readDocument(pipelineId, DocumentType.PRD, handle.documentId, dm);

      expect(content.filePath).toBe(handle.filePath);
      expect(content.filePath).toContain('v1.0.md');
      expect(content.filePath).not.toContain('current.md');
    });
  });

  describe('readVersion', () => {
    it('returns content from specific version file', async () => {
      const handle = await createDocument(makeRequest(), dm, templateEngine, idCounter);

      const content = await readVersion(
        pipelineId,
        DocumentType.PRD,
        handle.documentId,
        '1.0',
        dm,
      );

      expect(content.rawContent).toBeDefined();
      expect(content.rawContent.length).toBeGreaterThan(0);
      expect(content.version).toBe('1.0');
      expect(content.frontmatter.id).toBe(handle.documentId);
    });

    it('throws DocumentNotFoundError for missing version', async () => {
      const handle = await createDocument(makeRequest(), dm, templateEngine, idCounter);

      await expect(
        readVersion(pipelineId, DocumentType.PRD, handle.documentId, '99.0', dm),
      ).rejects.toThrow(DocumentNotFoundError);
    });
  });
});
