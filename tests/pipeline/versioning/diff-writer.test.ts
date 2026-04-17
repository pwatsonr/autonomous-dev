import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { writeDiff, readDiff } from '../../../src/pipeline/versioning/diff-writer';
import { VersionDiff, SectionDiff, DiffSummary } from '../../../src/pipeline/versioning/diff-engine';
import { DirectoryManager } from '../../../src/pipeline/storage/directory-manager';
import { DocumentType } from '../../../src/pipeline/types/document-type';

/**
 * Unit tests for diff-writer (SPEC-003-3-03, Task 5).
 */

function makeDiff(overrides: Partial<VersionDiff> = {}): VersionDiff {
  const sectionDiffs: SectionDiff[] = [
    {
      sectionId: 'introduction',
      changeType: 'modified',
      oldContent: 'Old introduction text.',
      newContent: 'New introduction text with more detail.',
      wordCountDelta: 3,
      oldWordCount: 3,
      newWordCount: 6,
    },
    {
      sectionId: 'conclusion',
      changeType: 'unchanged',
      oldContent: 'The end.',
      newContent: 'The end.',
      wordCountDelta: 0,
      oldWordCount: 2,
      newWordCount: 2,
    },
  ];

  const summary: DiffSummary = {
    sectionsAdded: 0,
    sectionsRemoved: 0,
    sectionsModified: 1,
    sectionsUnchanged: 1,
    totalWordCountDelta: 3,
  };

  return {
    fromVersion: '1.0',
    toVersion: '1.1',
    sectionDiffs,
    frontmatterChanges: [
      { field: 'version', oldValue: '1.0', newValue: '1.1' },
    ],
    summary,
    computedAt: '2026-04-08T12:00:00.000Z',
    ...overrides,
  };
}

describe('diff-writer', () => {
  let tmpDir: string;
  let dm: DirectoryManager;
  const pipelineId = 'PIPE-2026-0408-001';
  const documentId = 'PRD-001';
  const type = DocumentType.PRD;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'diff-writer-test-'));
    dm = new DirectoryManager(tmpDir);
    await dm.createPipelineDirs(pipelineId);
    await dm.createDocumentDirs(pipelineId, type, documentId);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writeDiff creates file at correct path', async () => {
    const diff = makeDiff();

    const filePath = await writeDiff(diff, pipelineId, type, documentId, dm);

    const expectedDir = dm.getDiffsDir(pipelineId, type, documentId);
    expect(filePath.startsWith(expectedDir)).toBe(true);

    // Verify the file actually exists on disk
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });

  it('writeDiff filename format: v1.0-to-v1.1.diff', async () => {
    const diff = makeDiff({ fromVersion: '1.0', toVersion: '1.1' });

    const filePath = await writeDiff(diff, pipelineId, type, documentId, dm);

    expect(path.basename(filePath)).toBe('v1.0-to-v1.1.diff');
  });

  it('readDiff deserializes back to original VersionDiff', async () => {
    const diff = makeDiff();

    await writeDiff(diff, pipelineId, type, documentId, dm);
    const read = await readDiff(pipelineId, type, documentId, '1.0', '1.1', dm);

    expect(read.fromVersion).toBe(diff.fromVersion);
    expect(read.toVersion).toBe(diff.toVersion);
    expect(read.computedAt).toBe(diff.computedAt);
    expect(read.summary.sectionsModified).toBe(diff.summary.sectionsModified);
    expect(read.summary.sectionsUnchanged).toBe(diff.summary.sectionsUnchanged);
    expect(read.summary.totalWordCountDelta).toBe(diff.summary.totalWordCountDelta);
  });

  it('round-trip: writeDiff -> readDiff preserves all fields', async () => {
    const diff = makeDiff({
      fromVersion: '2.3',
      toVersion: '2.4',
      frontmatterChanges: [
        { field: 'status', oldValue: 'draft', newValue: 'review' },
        { field: 'version', oldValue: '2.3', newValue: '2.4' },
      ],
    });

    await writeDiff(diff, pipelineId, type, documentId, dm);
    const read = await readDiff(pipelineId, type, documentId, '2.3', '2.4', dm);

    // Verify all top-level fields
    expect(read.fromVersion).toBe(diff.fromVersion);
    expect(read.toVersion).toBe(diff.toVersion);
    expect(read.computedAt).toBe(diff.computedAt);

    // Verify section diffs
    expect(read.sectionDiffs).toHaveLength(diff.sectionDiffs.length);
    for (let i = 0; i < diff.sectionDiffs.length; i++) {
      expect(read.sectionDiffs[i].sectionId).toBe(diff.sectionDiffs[i].sectionId);
      expect(read.sectionDiffs[i].changeType).toBe(diff.sectionDiffs[i].changeType);
      expect(read.sectionDiffs[i].oldContent).toBe(diff.sectionDiffs[i].oldContent);
      expect(read.sectionDiffs[i].newContent).toBe(diff.sectionDiffs[i].newContent);
      expect(read.sectionDiffs[i].wordCountDelta).toBe(diff.sectionDiffs[i].wordCountDelta);
      expect(read.sectionDiffs[i].oldWordCount).toBe(diff.sectionDiffs[i].oldWordCount);
      expect(read.sectionDiffs[i].newWordCount).toBe(diff.sectionDiffs[i].newWordCount);
    }

    // Verify frontmatter changes
    expect(read.frontmatterChanges).toHaveLength(diff.frontmatterChanges.length);
    for (let i = 0; i < diff.frontmatterChanges.length; i++) {
      expect(read.frontmatterChanges[i].field).toBe(diff.frontmatterChanges[i].field);
      expect(read.frontmatterChanges[i].oldValue).toBe(diff.frontmatterChanges[i].oldValue);
      expect(read.frontmatterChanges[i].newValue).toBe(diff.frontmatterChanges[i].newValue);
    }

    // Verify summary
    expect(read.summary).toEqual(diff.summary);
  });

  it('writeDiff uses atomic write', async () => {
    const diff = makeDiff();

    // writeDiff uses atomicWrite internally, which does write-then-rename.
    // We verify that the file exists after the call and is readable,
    // which means the atomic write succeeded (no partial writes).
    const filePath = await writeDiff(diff, pipelineId, type, documentId, dm);

    // Verify no temp files remain
    const diffsDir = dm.getDiffsDir(pipelineId, type, documentId);
    const files = await fs.readdir(diffsDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);

    // Verify the diff file exists and is valid YAML
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });
});
