import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DirectoryManager } from '../../../src/pipeline/storage/directory-manager';
import { TemplateEngine } from '../../../src/pipeline/template-engine/template-engine';
import { InMemoryIdCounter } from '../../../src/pipeline/frontmatter/id-generator';
import { parseFrontmatter } from '../../../src/pipeline/frontmatter/parser';
import { DocumentType } from '../../../src/pipeline/types/document-type';
import {
  createDocument,
  CreateDocumentRequest,
} from '../../../src/pipeline/storage/document-creator';

describe('createDocument', () => {
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
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-creator-test-'));
    dm = new DirectoryManager(tmpDir);
    templateEngine = new TemplateEngine();
    idCounter = new InMemoryIdCounter();

    // Create pipeline directories so document creation has a parent
    await dm.createPipelineDirs(pipelineId);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates document directory with reviews/ and diffs/ subdirectories', async () => {
    const handle = await createDocument(makeRequest(), dm, templateEngine, idCounter);

    const reviewsDir = path.join(handle.documentDir, 'reviews');
    const diffsDir = path.join(handle.documentDir, 'diffs');

    const reviewsStat = await fs.stat(reviewsDir);
    expect(reviewsStat.isDirectory()).toBe(true);

    const diffsStat = await fs.stat(diffsDir);
    expect(diffsStat.isDirectory()).toBe(true);
  });

  it('writes v1.0.md with correct frontmatter', async () => {
    const handle = await createDocument(makeRequest(), dm, templateEngine, idCounter);

    const content = await fs.readFile(handle.filePath, 'utf-8');
    const parsed = parseFrontmatter(content);

    expect(parsed.frontmatter.id).toBe(handle.documentId);
    expect(parsed.frontmatter.title).toBe('Test PRD');
    expect(parsed.frontmatter.pipeline_id).toBe(pipelineId);
    expect(parsed.frontmatter.type).toBe(DocumentType.PRD);
    expect(parsed.frontmatter.author_agent).toBe('agent-prd-writer');
  });

  it('creates current.md symlink pointing to v1.0.md', async () => {
    const handle = await createDocument(makeRequest(), dm, templateEngine, idCounter);

    const symlinkTarget = await fs.readlink(handle.symlinkPath);
    expect(symlinkTarget).toBe('v1.0.md');

    // Verify symlink resolves to the same file
    const realPath = await fs.realpath(handle.symlinkPath);
    expect(realPath).toBe(handle.filePath);
  });

  it('returns DocumentHandle with correct fields', async () => {
    const handle = await createDocument(makeRequest(), dm, templateEngine, idCounter);

    expect(handle.pipelineId).toBe(pipelineId);
    expect(handle.type).toBe(DocumentType.PRD);
    expect(handle.version).toBe('1.0');
    expect(handle.documentId).toBeDefined();
    expect(handle.filePath).toContain('v1.0.md');
    expect(handle.symlinkPath).toContain('current.md');
    expect(handle.documentDir).toBeDefined();
  });

  it('frontmatter.status is draft', async () => {
    const handle = await createDocument(makeRequest(), dm, templateEngine, idCounter);

    const content = await fs.readFile(handle.filePath, 'utf-8');
    const parsed = parseFrontmatter(content);

    expect(parsed.frontmatter.status).toBe('draft');
  });

  it('frontmatter.version is 1.0', async () => {
    const handle = await createDocument(makeRequest(), dm, templateEngine, idCounter);

    const content = await fs.readFile(handle.filePath, 'utf-8');
    const parsed = parseFrontmatter(content);

    // Version is stored as string "1.0" but the YAML parser may parse it as number 1
    const version = String(parsed.frontmatter.version);
    expect(version === '1.0' || version === '1').toBe(true);
  });

  it('frontmatter.id matches generated document ID', async () => {
    const handle = await createDocument(makeRequest(), dm, templateEngine, idCounter);

    const content = await fs.readFile(handle.filePath, 'utf-8');
    const parsed = parseFrontmatter(content);

    expect(parsed.frontmatter.id).toBe(handle.documentId);
  });

  it('frontmatter.parent_id is null for root PRD', async () => {
    const handle = await createDocument(makeRequest(), dm, templateEngine, idCounter);

    const content = await fs.readFile(handle.filePath, 'utf-8');
    const parsed = parseFrontmatter(content);

    expect(parsed.frontmatter.parent_id).toBeNull();
  });

  it('frontmatter.traces_from is non-empty for child documents', async () => {
    // First create a PRD (root)
    const prdHandle = await createDocument(makeRequest(), dm, templateEngine, idCounter);

    // Now create a TDD (child) that traces from the PRD
    const tddRequest = makeRequest({
      type: DocumentType.TDD,
      title: 'Test TDD',
      authorAgent: 'agent-tdd-writer',
      parentId: prdHandle.documentId,
      tracesFrom: ['section-1', 'section-2'],
      depth: 1,
    });

    const tddHandle = await createDocument(tddRequest, dm, templateEngine, idCounter);

    const content = await fs.readFile(tddHandle.filePath, 'utf-8');
    const parsed = parseFrontmatter(content);

    expect(parsed.frontmatter.traces_from).toBeDefined();
    expect(Array.isArray(parsed.frontmatter.traces_from)).toBe(true);
    expect((parsed.frontmatter.traces_from as string[]).length).toBeGreaterThan(0);
  });
});
