import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DirectoryManager } from '../../../src/pipeline/storage/directory-manager';
import { DocumentType } from '../../../src/pipeline/types/document-type';
import { PipelineConfig, DEFAULT_PIPELINE_CONFIG } from '../../../src/pipeline/types/config';
import { QuotaEnforcer, QuotaExceededError } from '../../../src/pipeline/storage/quota-enforcer';
import { writeVersion, WriteVersionRequest } from '../../../src/pipeline/storage/version-writer';
import { listVersions } from '../../../src/pipeline/storage/version-lister';

describe('Version + Quota Integration', () => {
  let tmpDir: string;
  let dm: DirectoryManager;
  const pipelineId = 'PIPE-2026-0408-001';
  const documentId = 'PRD-001';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'version-quota-integ-'));
    dm = new DirectoryManager(tmpDir);
    await dm.createPipelineDirs(pipelineId);
    await dm.createDocumentDirs(pipelineId, DocumentType.PRD, documentId);
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

  function makeFrontmatter(version: string): string {
    return [
      '---',
      `id: ${documentId}`,
      'title: Test PRD',
      `version: ${version}`,
      'version_reason: INITIAL',
      `updated_at: ${new Date().toISOString()}`,
      'author_agent: prd-author',
      '---',
      '# Product Requirements',
      `Version ${version} content.`,
      '',
    ].join('\n');
  }

  function makeRequest(version: string): WriteVersionRequest {
    return {
      pipelineId,
      type: DocumentType.PRD,
      documentId,
      version,
      content: makeFrontmatter(version),
      reason: 'INITIAL',
      authorAgent: 'prd-author',
    };
  }

  it('write 20 versions -> attempt 21st -> QuotaExceededError', async () => {
    const config = makeConfig({ maxVersionsPerDocument: 20 });
    const enforcer = new QuotaEnforcer(config, dm);

    // Write 20 versions
    for (let i = 0; i < 20; i++) {
      const version = `1.${i}`;
      await writeVersion(makeRequest(version), dm);
    }

    // 21st should be blocked by quota
    await expect(
      enforcer.checkVersionLimit(pipelineId, 'PRD', documentId),
    ).rejects.toThrow(QuotaExceededError);

    try {
      await enforcer.checkVersionLimit(pipelineId, 'PRD', documentId);
    } catch (err) {
      expect((err as QuotaExceededError).violation).toBe('MAX_VERSIONS_EXCEEDED');
      expect((err as QuotaExceededError).limit).toBe(20);
      expect((err as QuotaExceededError).actual).toBe(20);
    }
  });

  it('create 100 documents -> attempt 101st -> QuotaExceededError', async () => {
    const config = makeConfig({ maxDocumentsPerPipeline: 100 });
    const enforcer = new QuotaEnforcer(config, dm);

    // Create 99 more documents (we already have PRD-001 from beforeEach)
    for (let i = 2; i <= 100; i++) {
      const docId = `DOC-${String(i).padStart(3, '0')}`;
      await dm.createDocumentDirs(pipelineId, DocumentType.PRD, docId);
    }

    // 101st should be blocked
    await expect(
      enforcer.checkDocumentLimit(pipelineId),
    ).rejects.toThrow(QuotaExceededError);

    try {
      await enforcer.checkDocumentLimit(pipelineId);
    } catch (err) {
      expect((err as QuotaExceededError).violation).toBe('MAX_DOCUMENTS_EXCEEDED');
      expect((err as QuotaExceededError).limit).toBe(100);
      expect((err as QuotaExceededError).actual).toBe(100);
    }
  });

  it('write version -> read back via listVersions -> version present', async () => {
    const request = makeRequest('1.0');
    const record = await writeVersion(request, dm);

    const versions = await listVersions(pipelineId, DocumentType.PRD, documentId, dm);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe('1.0');
    expect(versions[0].filePath).toBe(record.filePath);
  });

  it('write 3 versions -> listVersions returns sorted [1.0, 1.1, 1.2]', async () => {
    // Write in non-sequential order
    await writeVersion(makeRequest('1.2'), dm);
    await writeVersion(makeRequest('1.0'), dm);
    await writeVersion(makeRequest('1.1'), dm);

    const versions = await listVersions(pipelineId, DocumentType.PRD, documentId, dm);
    expect(versions).toHaveLength(3);
    expect(versions.map(v => v.version)).toEqual(['1.0', '1.1', '1.2']);
  });
});
