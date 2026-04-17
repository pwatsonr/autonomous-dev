import { DocumentType } from '../../../src/pipeline/types/document-type';
import { VersionRecord } from '../../../src/pipeline/storage/version-writer';
import { DocumentStorage } from '../../../src/pipeline/storage/document-storage';
import { createVersion, VersionCreateRequest } from '../../../src/pipeline/versioning/version-creator';

/**
 * Creates a mock DocumentStorage with jest.fn() stubs for listVersions and writeVersion.
 */
function createMockStorage(versionRecords: VersionRecord[] = []): jest.Mocked<Pick<DocumentStorage, 'listVersions' | 'writeVersion'>> & DocumentStorage {
  const mock = {
    listVersions: jest.fn().mockResolvedValue(versionRecords),
    writeVersion: jest.fn().mockImplementation(async (req) => ({
      version: req.version,
      reason: req.reason,
      timestamp: new Date().toISOString(),
      author: req.authorAgent,
      contentHash: 'abc123',
      filePath: `/tmp/test/v${req.version}.md`,
    } as VersionRecord)),
  };
  return mock as any;
}

function makeRequest(overrides: Partial<VersionCreateRequest> = {}): VersionCreateRequest {
  return {
    pipelineId: 'PIPE-2026-0408-001',
    type: DocumentType.PRD,
    documentId: 'PRD-001',
    content: '---\nid: PRD-001\nversion: "1.0"\nupdated_at: "2026-01-01T00:00:00.000Z"\n---\n# Product Requirements\n',
    reason: 'INITIAL',
    authorAgent: 'prd-author',
    ...overrides,
  };
}

describe('createVersion', () => {
  it('calls storage.listVersions to get current version', async () => {
    const storage = createMockStorage([
      { version: '1.0', reason: 'INITIAL', timestamp: '', author: '', contentHash: '', filePath: '' },
    ]);
    const request = makeRequest({ reason: 'REVIEW_REVISION' });

    await createVersion(request, storage);

    expect(storage.listVersions).toHaveBeenCalledWith(
      request.pipelineId, request.type, request.documentId,
    );
  });

  it('calls calculateNextVersion with correct args', async () => {
    const storage = createMockStorage([
      { version: '1.0', reason: 'INITIAL', timestamp: '', author: '', contentHash: '', filePath: '' },
    ]);
    const request = makeRequest({ reason: 'REVIEW_REVISION' });

    await createVersion(request, storage);

    // The writeVersion call should receive version "1.1" (calculated from "1.0" + REVIEW_REVISION)
    expect(storage.writeVersion).toHaveBeenCalledWith(
      expect.objectContaining({ version: '1.1' }),
    );
  });

  it('updates frontmatter version in content', async () => {
    const storage = createMockStorage();
    const request = makeRequest({ reason: 'INITIAL' });

    await createVersion(request, storage);

    const writeCall = storage.writeVersion.mock.calls[0][0];
    expect(writeCall.content).toMatch(/^version:\s*"1\.0"$/m);
  });

  it('updates frontmatter updated_at in content', async () => {
    const storage = createMockStorage();
    const request = makeRequest({ reason: 'INITIAL' });

    const beforeTime = new Date().toISOString();
    await createVersion(request, storage);
    const afterTime = new Date().toISOString();

    const writeCall = storage.writeVersion.mock.calls[0][0];
    // Extract the updated_at value from the written content
    const match = writeCall.content.match(/^updated_at:\s*"(.+)"$/m);
    expect(match).not.toBeNull();
    const writtenTimestamp = match![1];
    expect(writtenTimestamp >= beforeTime).toBe(true);
    expect(writtenTimestamp <= afterTime).toBe(true);
  });

  it('calls storage.writeVersion with computed version', async () => {
    const storage = createMockStorage([
      { version: '1.0', reason: 'INITIAL', timestamp: '', author: '', contentHash: '', filePath: '' },
      { version: '1.1', reason: 'REVIEW_REVISION', timestamp: '', author: '', contentHash: '', filePath: '' },
    ]);
    const request = makeRequest({ reason: 'REVIEW_REVISION' });

    await createVersion(request, storage);

    expect(storage.writeVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineId: request.pipelineId,
        type: request.type,
        documentId: request.documentId,
        version: '1.2',
        reason: 'REVIEW_REVISION',
        authorAgent: 'prd-author',
      }),
    );
  });

  it('returns VersionRecord with sourceVersion for rollbacks', async () => {
    const storage = createMockStorage([
      { version: '1.0', reason: 'INITIAL', timestamp: '', author: '', contentHash: '', filePath: '' },
      { version: '1.1', reason: 'REVIEW_REVISION', timestamp: '', author: '', contentHash: '', filePath: '' },
      { version: '1.2', reason: 'REVIEW_REVISION', timestamp: '', author: '', contentHash: '', filePath: '' },
    ]);
    const request = makeRequest({
      reason: 'ROLLBACK',
      sourceVersion: '1.0',
    });

    const record = await createVersion(request, storage);

    expect(record.sourceVersion).toBe('1.0');
    expect(record.version).toBe('1.3');
  });

  it('with INITIAL reason does not list versions', async () => {
    const storage = createMockStorage();
    const request = makeRequest({ reason: 'INITIAL' });

    await createVersion(request, storage);

    expect(storage.listVersions).not.toHaveBeenCalled();
  });

  it('with REVIEW_REVISION increments from latest version', async () => {
    const storage = createMockStorage([
      { version: '1.0', reason: 'INITIAL', timestamp: '', author: '', contentHash: '', filePath: '' },
      { version: '1.1', reason: 'REVIEW_REVISION', timestamp: '', author: '', contentHash: '', filePath: '' },
      { version: '1.2', reason: 'REVIEW_REVISION', timestamp: '', author: '', contentHash: '', filePath: '' },
    ]);
    const request = makeRequest({ reason: 'REVIEW_REVISION' });

    await createVersion(request, storage);

    expect(storage.writeVersion).toHaveBeenCalledWith(
      expect.objectContaining({ version: '1.3' }),
    );
  });
});
