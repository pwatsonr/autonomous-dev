import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DirectoryManager } from '../../../src/pipeline/storage/directory-manager';
import { TemplateEngine } from '../../../src/pipeline/template-engine/template-engine';
import { InMemoryIdCounter } from '../../../src/pipeline/frontmatter/id-generator';
import { DocumentType } from '../../../src/pipeline/types/document-type';
import { createDocument, CreateDocumentRequest } from '../../../src/pipeline/storage/document-creator';
import { listDocuments } from '../../../src/pipeline/storage/document-lister';

describe('listDocuments', () => {
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
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-lister-test-'));
    dm = new DirectoryManager(tmpDir);
    templateEngine = new TemplateEngine();
    idCounter = new InMemoryIdCounter();
    await dm.createPipelineDirs(pipelineId);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns all documents in pipeline', async () => {
    await createDocument(makeRequest({ title: 'PRD 1' }), dm, templateEngine, idCounter);
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
  });

  it('returns results sorted by document ID', async () => {
    // Create documents of different types so IDs will have different prefixes
    await createDocument(
      makeRequest({ type: DocumentType.TDD, title: 'TDD 1', depth: 1 }),
      dm, templateEngine, idCounter,
    );
    await createDocument(makeRequest({ title: 'PRD 1' }), dm, templateEngine, idCounter);
    await createDocument(
      makeRequest({ type: DocumentType.PLAN, title: 'Plan 1', depth: 2 }),
      dm, templateEngine, idCounter,
    );

    const results = await listDocuments(pipelineId, dm);

    for (let i = 1; i < results.length; i++) {
      expect(
        results[i - 1].documentId.localeCompare(results[i].documentId),
      ).toBeLessThanOrEqual(0);
    }
  });

  it('with type filter only returns documents of that type', async () => {
    await createDocument(makeRequest({ title: 'PRD 1' }), dm, templateEngine, idCounter);
    await createDocument(
      makeRequest({ type: DocumentType.TDD, title: 'TDD 1', depth: 1 }),
      dm, templateEngine, idCounter,
    );
    await createDocument(
      makeRequest({ type: DocumentType.TDD, title: 'TDD 2', depth: 1 }),
      dm, templateEngine, idCounter,
    );

    const results = await listDocuments(pipelineId, dm, { type: DocumentType.TDD });

    expect(results.length).toBe(2);
    for (const handle of results) {
      expect(handle.type).toBe(DocumentType.TDD);
    }
  });

  it('with status filter only returns matching documents', async () => {
    // All created documents have status 'draft'
    await createDocument(makeRequest({ title: 'PRD 1' }), dm, templateEngine, idCounter);
    await createDocument(
      makeRequest({ type: DocumentType.TDD, title: 'TDD 1', depth: 1 }),
      dm, templateEngine, idCounter,
    );

    const draftResults = await listDocuments(pipelineId, dm, { status: 'draft' });
    expect(draftResults.length).toBe(2);

    const approvedResults = await listDocuments(pipelineId, dm, { status: 'approved' });
    expect(approvedResults.length).toBe(0);
  });

  it('with parentId filter only returns children of that parent', async () => {
    const prdHandle = await createDocument(
      makeRequest({ title: 'PRD 1' }),
      dm, templateEngine, idCounter,
    );

    await createDocument(
      makeRequest({
        type: DocumentType.TDD,
        title: 'TDD 1',
        depth: 1,
        parentId: prdHandle.documentId,
      }),
      dm, templateEngine, idCounter,
    );
    await createDocument(
      makeRequest({
        type: DocumentType.TDD,
        title: 'TDD 2',
        depth: 1,
        parentId: prdHandle.documentId,
      }),
      dm, templateEngine, idCounter,
    );
    await createDocument(
      makeRequest({
        type: DocumentType.TDD,
        title: 'TDD 3 (no parent)',
        depth: 1,
        parentId: null,
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

  it('with minDepth/maxDepth filter narrows by depth', async () => {
    await createDocument(
      makeRequest({ title: 'PRD', depth: 0 }),
      dm, templateEngine, idCounter,
    );
    await createDocument(
      makeRequest({ type: DocumentType.TDD, title: 'TDD', depth: 1 }),
      dm, templateEngine, idCounter,
    );
    await createDocument(
      makeRequest({ type: DocumentType.PLAN, title: 'Plan', depth: 2 }),
      dm, templateEngine, idCounter,
    );

    // minDepth = 1 -> should exclude PRD (depth 0)
    const minResults = await listDocuments(pipelineId, dm, { minDepth: 1 });
    expect(minResults.length).toBe(2);
    for (const h of minResults) {
      expect(h.depth).toBeGreaterThanOrEqual(1);
    }

    // maxDepth = 1 -> should exclude PLAN (depth 2)
    const maxResults = await listDocuments(pipelineId, dm, { maxDepth: 1 });
    expect(maxResults.length).toBe(2);
    for (const h of maxResults) {
      expect(h.depth).toBeLessThanOrEqual(1);
    }

    // minDepth = 1, maxDepth = 1 -> only TDD
    const rangeResults = await listDocuments(pipelineId, dm, { minDepth: 1, maxDepth: 1 });
    expect(rangeResults.length).toBe(1);
    expect(rangeResults[0].type).toBe(DocumentType.TDD);
  });

  it('returns empty array for pipeline with no documents', async () => {
    const results = await listDocuments(pipelineId, dm);
    expect(results).toEqual([]);
  });
});
