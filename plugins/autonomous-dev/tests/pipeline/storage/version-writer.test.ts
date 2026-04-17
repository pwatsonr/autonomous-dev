import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import { DirectoryManager } from '../../../src/pipeline/storage/directory-manager';
import { DocumentType } from '../../../src/pipeline/types/document-type';
import { writeVersion, normalizeForHash, WriteVersionRequest } from '../../../src/pipeline/storage/version-writer';

describe('writeVersion', () => {
  let tmpDir: string;
  let dm: DirectoryManager;
  const pipelineId = 'PIPE-2026-0408-001';
  const documentId = 'PRD-001';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'version-writer-test-'));
    dm = new DirectoryManager(tmpDir);
    await dm.createPipelineDirs(pipelineId);
    await dm.createDocumentDirs(pipelineId, DocumentType.PRD, documentId);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeRequest(overrides: Partial<WriteVersionRequest> = {}): WriteVersionRequest {
    return {
      pipelineId,
      type: DocumentType.PRD,
      documentId,
      version: '1.0',
      content: '---\nid: PRD-001\n---\n# Product Requirements\n',
      reason: 'INITIAL',
      authorAgent: 'prd-author',
      ...overrides,
    };
  }

  it('writes version file at correct path', async () => {
    const request = makeRequest();
    const result = await writeVersion(request, dm);

    const expectedPath = dm.getVersionFilePath(pipelineId, DocumentType.PRD, documentId, '1.0');
    expect(result.filePath).toBe(expectedPath);

    const content = await fs.readFile(expectedPath, 'utf-8');
    expect(content).toBe(request.content);
  });

  it('updates current.md symlink to new version', async () => {
    await writeVersion(makeRequest({ version: '1.0' }), dm);
    const symlinkPath = dm.getCurrentSymlinkPath(pipelineId, DocumentType.PRD, documentId);

    const target = await fs.readlink(symlinkPath);
    expect(target).toBe('v1.0.md');

    // Write a second version and verify symlink updates
    await writeVersion(makeRequest({ version: '1.1' }), dm);
    const newTarget = await fs.readlink(symlinkPath);
    expect(newTarget).toBe('v1.1.md');
  });

  it('computes correct SHA-256 hash', async () => {
    const content = '---\nid: PRD-001\n---\n# Hello\n';
    const request = makeRequest({ content });
    const result = await writeVersion(request, dm);

    const normalized = normalizeForHash(content);
    const expected = crypto.createHash('sha256').update(normalized, 'utf-8').digest('hex');
    expect(result.contentHash).toBe(expected);
  });

  it('returns VersionRecord with all fields populated', async () => {
    const request = makeRequest({ version: '2.3', reason: 'REVIEW_REVISION', authorAgent: 'reviewer-1' });
    const result = await writeVersion(request, dm);

    expect(result.version).toBe('2.3');
    expect(result.reason).toBe('REVIEW_REVISION');
    expect(result.author).toBe('reviewer-1');
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.filePath).toBe(
      dm.getVersionFilePath(pipelineId, DocumentType.PRD, documentId, '2.3'),
    );
    // timestamp should be a valid ISO 8601 string
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });
});

describe('normalizeForHash', () => {
  it('strips BOM', () => {
    const withBom = '\uFEFFhello';
    const result = normalizeForHash(withBom);
    expect(result).toBe('hello');
  });

  it('converts CRLF to LF', () => {
    const crlf = 'line1\r\nline2\r\n';
    const result = normalizeForHash(crlf);
    expect(result).toBe('line1\nline2\n');
  });

  it('converts lone CR to LF', () => {
    const cr = 'line1\rline2\r';
    const result = normalizeForHash(cr);
    expect(result).toBe('line1\nline2\n');
  });

  it('trims trailing whitespace per line', () => {
    const content = 'hello   \nworld\t\n';
    const result = normalizeForHash(content);
    expect(result).toBe('hello\nworld\n');
  });

  it('identical content with different line endings produces same hash', () => {
    const lf = 'line1\nline2\nline3\n';
    const crlf = 'line1\r\nline2\r\nline3\r\n';
    const cr = 'line1\rline2\rline3\r';

    const hashLf = crypto.createHash('sha256').update(normalizeForHash(lf), 'utf-8').digest('hex');
    const hashCrlf = crypto.createHash('sha256').update(normalizeForHash(crlf), 'utf-8').digest('hex');
    const hashCr = crypto.createHash('sha256').update(normalizeForHash(cr), 'utf-8').digest('hex');

    expect(hashLf).toBe(hashCrlf);
    expect(hashLf).toBe(hashCr);
  });

  it('identical content with different trailing whitespace produces same hash', () => {
    const clean = 'hello\nworld\n';
    const trailing = 'hello   \nworld\t\t\n';

    const hashClean = crypto.createHash('sha256').update(normalizeForHash(clean), 'utf-8').digest('hex');
    const hashTrailing = crypto.createHash('sha256').update(normalizeForHash(trailing), 'utf-8').digest('hex');

    expect(hashClean).toBe(hashTrailing);
  });
});
