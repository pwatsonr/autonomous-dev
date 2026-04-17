import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DirectoryManager } from '../../../src/pipeline/storage/directory-manager';
import { TemplateEngine } from '../../../src/pipeline/template-engine/template-engine';
import { InMemoryIdCounter } from '../../../src/pipeline/frontmatter/id-generator';
import { DocumentType } from '../../../src/pipeline/types/document-type';
import {
  createDocument,
  CreateDocumentRequest,
} from '../../../src/pipeline/storage/document-creator';
import { readDocument, readVersion } from '../../../src/pipeline/storage/document-reader';
import { listDocuments } from '../../../src/pipeline/storage/document-lister';

describe('Document Lifecycle Integration', () => {
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
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-lifecycle-integ-'));
    dm = new DirectoryManager(tmpDir);
    templateEngine = new TemplateEngine();
    idCounter = new InMemoryIdCounter();
    await dm.createPipelineDirs(pipelineId);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('create document -> read back -> content matches', async () => {
    const handle = await createDocument(makeRequest(), dm, templateEngine, idCounter);

    const content = await readDocument(
      pipelineId,
      DocumentType.PRD,
      handle.documentId,
      dm,
    );

    // Verify the read content matches what was written
    expect(content.frontmatter.id).toBe(handle.documentId);
    expect(content.frontmatter.title).toBe('Test PRD');
    expect(content.frontmatter.pipeline_id).toBe(pipelineId);
    expect(content.frontmatter.type).toBe(DocumentType.PRD);
    expect(content.frontmatter.status).toBe('draft');
    expect(content.frontmatter.author_agent).toBe('agent-prd-writer');
    expect(content.filePath).toBe(handle.filePath);
    expect(content.body).toBeDefined();
    expect(content.rawContent.length).toBeGreaterThan(0);
  });

  it('create document -> read specific version v1.0 -> content matches', async () => {
    const handle = await createDocument(makeRequest(), dm, templateEngine, idCounter);

    const content = await readVersion(
      pipelineId,
      DocumentType.PRD,
      handle.documentId,
      '1.0',
      dm,
    );

    expect(content.frontmatter.id).toBe(handle.documentId);
    expect(content.frontmatter.title).toBe('Test PRD');
    expect(content.version).toBe('1.0');
    expect(content.filePath).toBe(handle.filePath);
  });

  it('create 3 documents -> list all -> returns 3 sorted by ID', async () => {
    await createDocument(
      makeRequest({ title: 'PRD 1' }),
      dm, templateEngine, idCounter,
    );
    await createDocument(
      makeRequest({ type: DocumentType.TDD, title: 'TDD 1', depth: 1 }),
      dm, templateEngine, idCounter,
    );
    await createDocument(
      makeRequest({ type: DocumentType.PLAN, title: 'Plan 1', depth: 2 }),
      dm, templateEngine, idCounter,
    );

    const results = await listDocuments(pipelineId, dm);

    expect(results.length).toBe(3);

    // Verify sorted by document ID
    for (let i = 1; i < results.length; i++) {
      expect(
        results[i - 1].documentId.localeCompare(results[i].documentId),
      ).toBeLessThanOrEqual(0);
    }
  });

  it('create PRD + 2 TDDs -> list with type=TDD -> returns 2', async () => {
    await createDocument(
      makeRequest({ title: 'Root PRD' }),
      dm, templateEngine, idCounter,
    );
    await createDocument(
      makeRequest({ type: DocumentType.TDD, title: 'TDD Alpha', depth: 1 }),
      dm, templateEngine, idCounter,
    );
    await createDocument(
      makeRequest({ type: DocumentType.TDD, title: 'TDD Beta', depth: 1 }),
      dm, templateEngine, idCounter,
    );

    const results = await listDocuments(pipelineId, dm, {
      type: DocumentType.TDD,
    });

    expect(results.length).toBe(2);
    for (const handle of results) {
      expect(handle.type).toBe(DocumentType.TDD);
    }
  });

  it('create PRD + 2 TDDs -> list with parentId=PRD_ID -> returns 2', async () => {
    const prdHandle = await createDocument(
      makeRequest({ title: 'Root PRD' }),
      dm, templateEngine, idCounter,
    );
    await createDocument(
      makeRequest({
        type: DocumentType.TDD,
        title: 'TDD Alpha',
        depth: 1,
        parentId: prdHandle.documentId,
      }),
      dm, templateEngine, idCounter,
    );
    await createDocument(
      makeRequest({
        type: DocumentType.TDD,
        title: 'TDD Beta',
        depth: 1,
        parentId: prdHandle.documentId,
      }),
      dm, templateEngine, idCounter,
    );

    const results = await listDocuments(pipelineId, dm, {
      parentId: prdHandle.documentId,
    });

    expect(results.length).toBe(2);
    for (const handle of results) {
      expect(handle.parentId).toBe(prdHandle.documentId);
    }
  });
});
