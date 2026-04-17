import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DirectoryManager } from '../../../src/pipeline/storage/directory-manager';
import { DocumentType } from '../../../src/pipeline/types/document-type';
import { listVersions } from '../../../src/pipeline/storage/version-lister';

describe('listVersions', () => {
  let tmpDir: string;
  let dm: DirectoryManager;
  const pipelineId = 'PIPE-2026-0408-001';
  const documentId = 'PRD-001';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'version-lister-test-'));
    dm = new DirectoryManager(tmpDir);
    await dm.createPipelineDirs(pipelineId);
    await dm.createDocumentDirs(pipelineId, DocumentType.PRD, documentId);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeFrontmatter(opts: {
    versionReason?: string;
    updatedAt?: string;
    authorAgent?: string;
  } = {}): string {
    const reason = opts.versionReason ?? 'INITIAL';
    const updated = opts.updatedAt ?? '2026-04-08T12:00:00.000Z';
    const author = opts.authorAgent ?? 'prd-author';
    return [
      '---',
      'id: PRD-001',
      'title: Test',
      `version_reason: ${reason}`,
      `updated_at: ${updated}`,
      `author_agent: ${author}`,
      '---',
      '# Content',
      '',
    ].join('\n');
  }

  async function writeVersionFile(version: string, content?: string): Promise<void> {
    const filePath = dm.getVersionFilePath(pipelineId, DocumentType.PRD, documentId, version);
    await fs.writeFile(filePath, content ?? makeFrontmatter());
  }

  it('lists all version files in a document directory', async () => {
    await writeVersionFile('1.0');
    await writeVersionFile('1.1');
    await writeVersionFile('1.2');

    const versions = await listVersions(pipelineId, DocumentType.PRD, documentId, dm);
    expect(versions).toHaveLength(3);
    expect(versions.map(v => v.version)).toEqual(['1.0', '1.1', '1.2']);
  });

  it('ignores non-version files (current.md, reviews/, diffs/)', async () => {
    await writeVersionFile('1.0');

    // current.md symlink
    const docDir = dm.getDocumentDir(pipelineId, DocumentType.PRD, documentId);
    await fs.symlink('v1.0.md', path.join(docDir, 'current.md'));

    // A random non-version file
    await fs.writeFile(path.join(docDir, 'notes.txt'), 'some notes');

    // reviews/ and diffs/ dirs already exist from createDocumentDirs

    const versions = await listVersions(pipelineId, DocumentType.PRD, documentId, dm);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe('1.0');
  });

  it('sorts versions: 1.0 before 1.1', async () => {
    // Write in reverse order
    await writeVersionFile('1.1');
    await writeVersionFile('1.0');

    const versions = await listVersions(pipelineId, DocumentType.PRD, documentId, dm);
    expect(versions[0].version).toBe('1.0');
    expect(versions[1].version).toBe('1.1');
  });

  it('sorts versions: 1.9 before 1.10 (not lexicographic)', async () => {
    await writeVersionFile('1.10');
    await writeVersionFile('1.9');
    await writeVersionFile('1.2');

    const versions = await listVersions(pipelineId, DocumentType.PRD, documentId, dm);
    expect(versions.map(v => v.version)).toEqual(['1.2', '1.9', '1.10']);
  });

  it('sorts versions: 1.10 before 2.0', async () => {
    await writeVersionFile('2.0');
    await writeVersionFile('1.10');

    const versions = await listVersions(pipelineId, DocumentType.PRD, documentId, dm);
    expect(versions[0].version).toBe('1.10');
    expect(versions[1].version).toBe('2.0');
  });

  it('returns empty array for document with no versions', async () => {
    const versions = await listVersions(pipelineId, DocumentType.PRD, documentId, dm);
    expect(versions).toEqual([]);
  });

  it('extracts metadata from frontmatter', async () => {
    await writeVersionFile('1.0', makeFrontmatter({
      versionReason: 'REVIEW_REVISION',
      updatedAt: '2026-04-09T10:30:00.000Z',
      authorAgent: 'reviewer-1',
    }));

    const versions = await listVersions(pipelineId, DocumentType.PRD, documentId, dm);
    expect(versions).toHaveLength(1);
    expect(versions[0].reason).toBe('REVIEW_REVISION');
    expect(versions[0].timestamp).toBe('2026-04-09T10:30:00.000Z');
    expect(versions[0].author).toBe('reviewer-1');
  });
});
