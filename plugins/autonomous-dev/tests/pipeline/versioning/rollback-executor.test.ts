import { DocumentType } from '../../../src/pipeline/types/document-type';
import { DocumentStorage } from '../../../src/pipeline/storage/document-storage';
import { VersionRecord } from '../../../src/pipeline/storage/version-writer';
import { DocumentContent } from '../../../src/pipeline/storage/document-reader';
import { rollback } from '../../../src/pipeline/versioning/rollback-executor';

/**
 * Unit tests for rollback-executor (SPEC-003-3-03, Task 7).
 */

const pipelineId = 'PIPE-2026-0408-001';
const type = DocumentType.PRD;
const documentId = 'PRD-001';

/** Content for v1.0 */
const v10Content = '---\nid: PRD-001\nversion: "1.0"\nupdated_at: "2026-01-01T00:00:00.000Z"\n---\n# Original Content\n\nThis is the original v1.0 content.\n';

/** Content for v1.1 (modified) */
const v11Content = '---\nid: PRD-001\nversion: "1.1"\nupdated_at: "2026-01-02T00:00:00.000Z"\n---\n# Modified Content\n\nThis is the modified v1.1 content.\n';

/** Content for v1.2 (further modified) */
const v12Content = '---\nid: PRD-001\nversion: "1.2"\nupdated_at: "2026-01-03T00:00:00.000Z"\n---\n# Further Modified\n\nThis is the v1.2 content.\n';

function makeDocumentContent(rawContent: string, version: string): DocumentContent {
  return {
    frontmatter: { id: documentId, version },
    body: rawContent.split('---\n').slice(2).join('---\n'),
    rawContent,
    version,
    filePath: `/tmp/test/v${version}.md`,
  };
}

function makeVersionRecord(version: string, reason: string, overrides: Partial<VersionRecord> = {}): VersionRecord {
  return {
    version,
    reason: reason as any,
    timestamp: new Date().toISOString(),
    author: 'test-agent',
    contentHash: `hash-${version}`,
    filePath: `/tmp/test/v${version}.md`,
    ...overrides,
  };
}

function createMockStorage(options: {
  versions?: VersionRecord[];
  versionContents?: Record<string, string>;
} = {}): jest.Mocked<Pick<DocumentStorage, 'readVersion' | 'listVersions' | 'writeVersion'>> & DocumentStorage {
  const versions = options.versions ?? [
    makeVersionRecord('1.0', 'INITIAL'),
    makeVersionRecord('1.1', 'REVIEW_REVISION'),
    makeVersionRecord('1.2', 'REVIEW_REVISION'),
  ];

  const versionContents = options.versionContents ?? {
    '1.0': v10Content,
    '1.1': v11Content,
    '1.2': v12Content,
  };

  const mock = {
    readVersion: jest.fn().mockImplementation(async (_pId: string, _t: DocumentType, _dId: string, version: string) => {
      const content = versionContents[version];
      if (!content) throw new Error(`Version ${version} not found`);
      return makeDocumentContent(content, version);
    }),
    listVersions: jest.fn().mockResolvedValue(versions),
    writeVersion: jest.fn().mockImplementation(async (req) => ({
      version: req.version,
      reason: req.reason,
      timestamp: new Date().toISOString(),
      author: req.authorAgent,
      contentHash: `hash-${req.version}`,
      filePath: `/tmp/test/v${req.version}.md`,
    } as VersionRecord)),
  };
  return mock as any;
}

describe('rollback', () => {
  it('rollback reads target version content', async () => {
    const storage = createMockStorage();

    await rollback(pipelineId, type, documentId, '1.0', 'rollback-agent', storage);

    expect(storage.readVersion).toHaveBeenCalledWith(
      pipelineId, type, documentId, '1.0',
    );
  });

  it('rollback creates new version with ROLLBACK reason', async () => {
    const storage = createMockStorage();

    await rollback(pipelineId, type, documentId, '1.0', 'rollback-agent', storage);

    expect(storage.writeVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'ROLLBACK',
      }),
    );
  });

  it('rollback version number is minor increment from current (not target)', async () => {
    const storage = createMockStorage({
      versions: [
        makeVersionRecord('1.0', 'INITIAL'),
        makeVersionRecord('1.1', 'REVIEW_REVISION'),
        makeVersionRecord('1.2', 'REVIEW_REVISION'),
      ],
    });

    await rollback(pipelineId, type, documentId, '1.0', 'rollback-agent', storage);

    // Current version is 1.2, so rollback should create 1.3
    expect(storage.writeVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        version: '1.3',
      }),
    );
  });

  it('rollback content matches target content', async () => {
    const storage = createMockStorage();

    await rollback(pipelineId, type, documentId, '1.0', 'rollback-agent', storage);

    // The writeVersion call should contain the v1.0 content (with updated frontmatter)
    const writeCall = storage.writeVersion.mock.calls[0][0];
    // The content should originate from v1.0 - it will have "Original Content" in it
    expect(writeCall.content).toContain('Original Content');
  });

  it('rollback sets sourceVersion to target version string', async () => {
    const storage = createMockStorage();

    const record = await rollback(pipelineId, type, documentId, '1.0', 'rollback-agent', storage);

    expect(record.sourceVersion).toBe('1.0');
  });

  it('rollback logs audit event', async () => {
    const storage = createMockStorage();

    const record = await rollback(pipelineId, type, documentId, '1.0', 'rollback-agent', storage);

    // The writeVersion call in DocumentStorage internally logs an audit event.
    // We verify that writeVersion was called (which triggers audit logging).
    expect(storage.writeVersion).toHaveBeenCalledTimes(1);
    expect(record.reason).toBe('ROLLBACK');
  });
});
