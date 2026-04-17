import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import yaml from 'js-yaml';
import { DirectoryManager } from '../../../src/pipeline/storage/directory-manager';
import { generatePipelineId, initializePipeline } from '../../../src/pipeline/storage/pipeline-initializer';

describe('generatePipelineId', () => {
  it('formats correctly for 2026-04-08 seq 1', () => {
    const date = new Date(2026, 3, 8); // Month is 0-indexed: 3 = April
    expect(generatePipelineId(date, 1)).toBe('PIPE-2026-0408-001');
  });

  it('pads sequence to 3 digits', () => {
    const date = new Date(2026, 0, 15); // January 15
    expect(generatePipelineId(date, 1)).toBe('PIPE-2026-0115-001');
    expect(generatePipelineId(date, 12)).toBe('PIPE-2026-0115-012');
    expect(generatePipelineId(date, 123)).toBe('PIPE-2026-0115-123');
  });

  it('handles single-digit months and days', () => {
    const date = new Date(2026, 0, 5); // January 5
    expect(generatePipelineId(date, 1)).toBe('PIPE-2026-0105-001');
  });

  it('handles double-digit months', () => {
    const date = new Date(2026, 11, 25); // December 25
    expect(generatePipelineId(date, 42)).toBe('PIPE-2026-1225-042');
  });
});

describe('initializePipeline', () => {
  let tmpDir: string;
  let dm: DirectoryManager;
  const pipelineId = 'PIPE-2026-0408-001';
  const title = 'Test Pipeline';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-init-test-'));
    dm = new DirectoryManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates pipeline.yaml with correct YAML structure', async () => {
    const result = await initializePipeline(dm, pipelineId, title);

    const content = await fs.readFile(result.pipelineYamlPath, 'utf-8');
    const parsed = yaml.load(content) as Record<string, unknown>;

    expect(parsed.pipeline_id).toBe(pipelineId);
    expect(parsed.title).toBe(title);
    expect(parsed.status).toBe('active');
    expect(parsed.priority).toBe('normal');
    expect(parsed.created_at).toBeDefined();
    expect(parsed.updated_at).toBeDefined();
    expect(parsed.paused_at).toBeNull();
    expect(parsed.document_states).toEqual({});
    expect(parsed.active_cascades).toEqual([]);
    expect(parsed.metrics).toEqual({
      total_documents: 0,
      documents_by_status: {},
      total_versions: 0,
      total_reviews: 0,
    });
  });

  it('pipeline.yaml has status active', async () => {
    const result = await initializePipeline(dm, pipelineId, title);

    const content = await fs.readFile(result.pipelineYamlPath, 'utf-8');
    const parsed = yaml.load(content) as Record<string, unknown>;

    expect(parsed.status).toBe('active');
  });

  it('creates empty audit.log', async () => {
    const result = await initializePipeline(dm, pipelineId, title);

    const content = await fs.readFile(result.auditLogPath, 'utf-8');
    expect(content).toBe('');
  });

  it('creates traceability.yaml with empty arrays', async () => {
    const result = await initializePipeline(dm, pipelineId, title);

    const content = await fs.readFile(result.traceabilityPath, 'utf-8');
    const parsed = yaml.load(content) as Record<string, unknown>;

    expect(parsed).toEqual({
      links: [],
      chains: [],
      gaps: [],
      orphans: [],
    });
  });

  it('returns correct PipelineInitResult paths', async () => {
    const result = await initializePipeline(dm, pipelineId, title);

    expect(result.pipelineId).toBe(pipelineId);
    expect(result.pipelineDir).toBe(path.join(tmpDir, pipelineId));
    expect(result.pipelineYamlPath).toBe(path.join(tmpDir, pipelineId, 'pipeline.yaml'));
    expect(result.auditLogPath).toBe(path.join(tmpDir, pipelineId, 'audit.log'));
    expect(result.traceabilityPath).toBe(path.join(tmpDir, pipelineId, 'traceability.yaml'));
  });

  it('creates the full directory structure', async () => {
    await initializePipeline(dm, pipelineId, title);

    const pipeDir = dm.getPipelineDir(pipelineId);
    const documentsDir = path.join(pipeDir, 'documents');
    const decompositionDir = path.join(pipeDir, 'decomposition');

    const pipeStat = await fs.stat(pipeDir);
    expect(pipeStat.isDirectory()).toBe(true);

    const docsStat = await fs.stat(documentsDir);
    expect(docsStat.isDirectory()).toBe(true);

    const decompStat = await fs.stat(decompositionDir);
    expect(decompStat.isDirectory()).toBe(true);
  });
});
