import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DocumentType } from '../../../src/pipeline/types/document-type';
import { DirectoryManager } from '../../../src/pipeline/storage/directory-manager';
import {
  writeDecompositionRecord,
  readDecompositionRecord,
  readAllDecompositionRecords,
  DecompositionRecord,
  ProposedChild,
  CoverageMatrixEntry,
  SmokeTestResult,
} from '../../../src/pipeline/decomposition/decomposition-record-io';

function makeRecord(overrides?: Partial<DecompositionRecord>): DecompositionRecord {
  return {
    parentId: 'PRD-001',
    parentType: DocumentType.PRD,
    parentVersion: '1.0',
    childType: DocumentType.TDD,
    strategy: 'domain',
    children: [
      {
        id: 'TDD-001-01',
        title: 'Auth Domain',
        tracesFrom: ['section-1', 'section-2'],
        executionMode: 'parallel',
        dependsOn: [],
      },
      {
        id: 'TDD-001-02',
        title: 'Data Domain',
        tracesFrom: ['section-3'],
        executionMode: 'sequential',
        dependsOn: ['TDD-001-01'],
      },
    ],
    coverageMatrix: [
      { parentSection: 'section-1', coveredBy: ['TDD-001-01'] },
      { parentSection: 'section-2', coveredBy: ['TDD-001-01'] },
      { parentSection: 'section-3', coveredBy: ['TDD-001-02'] },
    ],
    smokeTestResult: {
      passed: true,
      coverageComplete: true,
      uncoveredParentSections: [],
      scopeCreep: false,
      scopeCreepDetails: [],
      contradictions: false,
      contradictionDetails: [],
    },
    createdAt: '2026-04-08T10:00:00Z',
    decompositionAgent: 'decomposer-v1',
    ...overrides,
  };
}

describe('Decomposition Record I/O', () => {
  let tmpDir: string;
  let directoryManager: DirectoryManager;
  const pipelineId = 'test-pipeline';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'decomp-io-test-'));
    directoryManager = new DirectoryManager(tmpDir);
    // Create the pipeline decomposition directory
    const decompDir = directoryManager.getDecompositionDir(pipelineId);
    await fs.mkdir(decompDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('writeDecompositionRecord creates correct filename', async () => {
    const record = makeRecord();
    const filePath = await writeDecompositionRecord(record, pipelineId, directoryManager);

    expect(path.basename(filePath)).toBe('PRD-001-decomposition.yaml');
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });

  test('writeDecompositionRecord writes valid YAML', async () => {
    const record = makeRecord();
    const filePath = await writeDecompositionRecord(record, pipelineId, directoryManager);

    const content = await fs.readFile(filePath, 'utf-8');
    // Basic YAML structure checks
    expect(content).toContain('parentId: PRD-001');
    expect(content).toContain('parentType: PRD');
    expect(content).toContain('strategy: domain');
    expect(content).toContain('childType: TDD');
  });

  test('readDecompositionRecord returns null for non-existent record', async () => {
    const result = await readDecompositionRecord('NONEXISTENT', pipelineId, directoryManager);
    expect(result).toBeNull();
  });

  test('round-trip: write -> read preserves all fields', async () => {
    const record = makeRecord();
    await writeDecompositionRecord(record, pipelineId, directoryManager);
    const readBack = await readDecompositionRecord('PRD-001', pipelineId, directoryManager);

    expect(readBack).not.toBeNull();
    expect(readBack!.parentId).toBe(record.parentId);
    expect(readBack!.parentType).toBe(record.parentType);
    expect(readBack!.parentVersion).toBe(record.parentVersion);
    expect(readBack!.childType).toBe(record.childType);
    expect(readBack!.strategy).toBe(record.strategy);
    expect(readBack!.createdAt).toBe(record.createdAt);
    expect(readBack!.decompositionAgent).toBe(record.decompositionAgent);

    // Children
    expect(readBack!.children).toHaveLength(2);
    expect(readBack!.children[0].id).toBe('TDD-001-01');
    expect(readBack!.children[0].title).toBe('Auth Domain');
    expect(readBack!.children[0].tracesFrom).toEqual(['section-1', 'section-2']);
    expect(readBack!.children[0].executionMode).toBe('parallel');
    expect(readBack!.children[0].dependsOn).toEqual([]);
    expect(readBack!.children[1].id).toBe('TDD-001-02');
    expect(readBack!.children[1].dependsOn).toEqual(['TDD-001-01']);

    // Coverage matrix
    expect(readBack!.coverageMatrix).toHaveLength(3);
    expect(readBack!.coverageMatrix[0].parentSection).toBe('section-1');
    expect(readBack!.coverageMatrix[0].coveredBy).toEqual(['TDD-001-01']);

    // Smoke test result
    expect(readBack!.smokeTestResult).not.toBeNull();
    expect(readBack!.smokeTestResult!.passed).toBe(true);
    expect(readBack!.smokeTestResult!.coverageComplete).toBe(true);
    expect(readBack!.smokeTestResult!.uncoveredParentSections).toEqual([]);
    expect(readBack!.smokeTestResult!.scopeCreep).toBe(false);
    expect(readBack!.smokeTestResult!.contradictions).toBe(false);
  });

  test('round-trip with null smokeTestResult', async () => {
    const record = makeRecord({ smokeTestResult: null });
    await writeDecompositionRecord(record, pipelineId, directoryManager);
    const readBack = await readDecompositionRecord('PRD-001', pipelineId, directoryManager);

    expect(readBack).not.toBeNull();
    expect(readBack!.smokeTestResult).toBeNull();
  });

  test('readAllDecompositionRecords returns all records in directory', async () => {
    const record1 = makeRecord({ parentId: 'PRD-001' });
    const record2 = makeRecord({
      parentId: 'TDD-001-01',
      parentType: DocumentType.TDD,
      childType: DocumentType.PLAN,
      strategy: 'phase',
    });

    await writeDecompositionRecord(record1, pipelineId, directoryManager);
    await writeDecompositionRecord(record2, pipelineId, directoryManager);

    const records = await readAllDecompositionRecords(pipelineId, directoryManager);
    expect(records).toHaveLength(2);

    const ids = records.map(r => r.parentId).sort();
    expect(ids).toEqual(['PRD-001', 'TDD-001-01']);
  });

  test('readAllDecompositionRecords returns empty for empty directory', async () => {
    const records = await readAllDecompositionRecords(pipelineId, directoryManager);
    expect(records).toEqual([]);
  });

  test('readAllDecompositionRecords returns empty when directory does not exist', async () => {
    const nonExistentDm = new DirectoryManager(path.join(tmpDir, 'nonexistent'));
    const records = await readAllDecompositionRecords('no-such-pipeline', nonExistentDm);
    expect(records).toEqual([]);
  });

  test('readAllDecompositionRecords ignores non-decomposition files', async () => {
    const record = makeRecord();
    await writeDecompositionRecord(record, pipelineId, directoryManager);

    // Write a non-decomposition file in the same directory
    const decompDir = directoryManager.getDecompositionDir(pipelineId);
    await fs.writeFile(path.join(decompDir, 'other-file.yaml'), 'key: value');

    const records = await readAllDecompositionRecords(pipelineId, directoryManager);
    expect(records).toHaveLength(1);
    expect(records[0].parentId).toBe('PRD-001');
  });

  test('record schema includes all required fields', () => {
    const record = makeRecord();
    expect(record).toHaveProperty('parentId');
    expect(record).toHaveProperty('parentType');
    expect(record).toHaveProperty('parentVersion');
    expect(record).toHaveProperty('childType');
    expect(record).toHaveProperty('strategy');
    expect(record).toHaveProperty('children');
    expect(record).toHaveProperty('coverageMatrix');
    expect(record).toHaveProperty('smokeTestResult');
    expect(record).toHaveProperty('createdAt');
    expect(record).toHaveProperty('decompositionAgent');
  });

  test('writeDecompositionRecord returns the correct file path', async () => {
    const record = makeRecord();
    const filePath = await writeDecompositionRecord(record, pipelineId, directoryManager);

    const decompDir = directoryManager.getDecompositionDir(pipelineId);
    expect(filePath).toBe(path.join(decompDir, 'PRD-001-decomposition.yaml'));
  });
});
