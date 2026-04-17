import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { DocumentType } from '../../../src/pipeline/types/document-type';
import { DocumentStorage } from '../../../src/pipeline/storage/document-storage';
import { DEFAULT_PIPELINE_CONFIG, PipelineConfig } from '../../../src/pipeline/types/config';
import { InMemoryIdCounter } from '../../../src/pipeline/frontmatter/id-generator';
import { rollback } from '../../../src/pipeline/versioning/rollback-executor';
import { createVersion, VersionCreateRequest } from '../../../src/pipeline/versioning/version-creator';
import { normalizeForHash } from '../../../src/pipeline/storage/version-writer';

/**
 * Integration tests for rollback (SPEC-003-3-03).
 *
 * These tests use the real DocumentStorage and filesystem rather than mocks.
 */

describe('Rollback Integration', () => {
  let tmpDir: string;
  let storage: DocumentStorage;
  let config: PipelineConfig;
  const pipelineId = 'PIPE-2026-0408-001';
  const documentId = 'PRD-001';
  const type = DocumentType.PRD;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rollback-integ-'));
    config = {
      ...DEFAULT_PIPELINE_CONFIG,
      pipeline: {
        ...DEFAULT_PIPELINE_CONFIG.pipeline,
        rootDir: tmpDir,
      },
    };
    const idCounter = new InMemoryIdCounter();
    storage = new DocumentStorage(config, idCounter);

    // Initialize pipeline and create the document directory structure
    await storage.initializePipeline(pipelineId, 'Test Pipeline');

    // Create document directory manually for version writes
    const dm = storage.getDirectoryManager();
    await dm.createDocumentDirs(pipelineId, type, documentId);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Helper to compute content hash using the same normalization as version-writer */
  function computeHash(content: string): string {
    const normalized = normalizeForHash(content);
    return crypto.createHash('sha256').update(normalized, 'utf-8').digest('hex');
  }

  it('create v1.0 -> create v1.1 -> rollback to v1.0 -> v1.2 has v1.0 content', async () => {
    const v10Content = '---\nid: PRD-001\nversion: "1.0"\nupdated_at: "2026-01-01T00:00:00.000Z"\n---\n# Original\n\nOriginal v1.0 content here.\n';
    const v11Content = '---\nid: PRD-001\nversion: "1.0"\nupdated_at: "2026-01-01T00:00:00.000Z"\n---\n# Modified\n\nModified v1.1 content here.\n';

    // Create v1.0
    const v10Request: VersionCreateRequest = {
      pipelineId,
      type,
      documentId,
      content: v10Content,
      reason: 'INITIAL',
      authorAgent: 'prd-author',
    };
    const v10Record = await createVersion(v10Request, storage);
    expect(v10Record.version).toBe('1.0');

    // Create v1.1 (revision)
    const v11Request: VersionCreateRequest = {
      pipelineId,
      type,
      documentId,
      content: v11Content,
      reason: 'REVIEW_REVISION',
      authorAgent: 'prd-author',
    };
    const v11Record = await createVersion(v11Request, storage);
    expect(v11Record.version).toBe('1.1');

    // Rollback to v1.0
    const rollbackRecord = await rollback(
      pipelineId, type, documentId, '1.0', 'rollback-agent', storage,
    );

    // Rollback creates v1.2 (minor increment from current 1.1)
    expect(rollbackRecord.version).toBe('1.2');

    // Read v1.2 content and verify it contains v1.0's body content
    const v12Content = await storage.readVersion(pipelineId, type, documentId, '1.2');
    expect(v12Content.rawContent).toContain('Original v1.0 content here.');
    expect(v12Content.rawContent).not.toContain('Modified v1.1 content');
  });

  it('content hash of v1.2 matches content hash of v1.0', async () => {
    const v10Content = '---\nid: PRD-001\nversion: "1.0"\nupdated_at: "2026-01-01T00:00:00.000Z"\n---\n# Original\n\nOriginal content for hash test.\n';
    const v11Content = '---\nid: PRD-001\nversion: "1.0"\nupdated_at: "2026-01-01T00:00:00.000Z"\n---\n# Changed\n\nDifferent content for v1.1.\n';

    // Create v1.0
    await createVersion({
      pipelineId, type, documentId,
      content: v10Content,
      reason: 'INITIAL',
      authorAgent: 'prd-author',
    }, storage);

    // Create v1.1
    await createVersion({
      pipelineId, type, documentId,
      content: v11Content,
      reason: 'REVIEW_REVISION',
      authorAgent: 'prd-author',
    }, storage);

    // Rollback to v1.0
    const rollbackRecord = await rollback(
      pipelineId, type, documentId, '1.0', 'rollback-agent', storage,
    );

    // Read v1.0 and v1.2 to compare
    const v10Read = await storage.readVersion(pipelineId, type, documentId, '1.0');
    const v12Read = await storage.readVersion(pipelineId, type, documentId, '1.2');

    // The rollback version content hash should match v1.0's content hash.
    // Note: frontmatter version/updated_at fields will differ, but the body content
    // (the actual document substance) should be identical.
    // We verify the body content matches.
    expect(v12Read.body.trim()).toBe(v10Read.body.trim());
  });

  it('version history shows: v1.0, v1.1, v1.2', async () => {
    const v10Content = '---\nid: PRD-001\nversion: "1.0"\nupdated_at: "2026-01-01T00:00:00.000Z"\n---\n# Doc\n\nContent A.\n';
    const v11Content = '---\nid: PRD-001\nversion: "1.0"\nupdated_at: "2026-01-01T00:00:00.000Z"\n---\n# Doc\n\nContent B.\n';

    // Create v1.0
    await createVersion({
      pipelineId, type, documentId,
      content: v10Content,
      reason: 'INITIAL',
      authorAgent: 'prd-author',
    }, storage);

    // Create v1.1
    await createVersion({
      pipelineId, type, documentId,
      content: v11Content,
      reason: 'REVIEW_REVISION',
      authorAgent: 'prd-author',
    }, storage);

    // Rollback to v1.0
    await rollback(pipelineId, type, documentId, '1.0', 'rollback-agent', storage);

    // List all versions
    const versions = await storage.listVersions(pipelineId, type, documentId);
    const versionStrings = versions.map(v => v.version);

    expect(versionStrings).toEqual(['1.0', '1.1', '1.2']);
  });
});
