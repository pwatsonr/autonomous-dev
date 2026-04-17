import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  generatePrdFromObservation,
  createPrdGenerator,
  extractSection,
  extractEvidenceFromBody,
  extractMetricsFromBody,
  type PrdGenerationResult,
  type GeneratePrdViaLlmFn,
} from '../../src/triage/prd-generator';
import {
  buildPrdContent,
  buildPrdPrompt,
  PRD_AUTHOR,
  PRD_STATUS,
  PRD_SOURCE,
  PRD_VERSION,
  type ObservationData,
  type LlmPrdContent,
} from '../../src/triage/prd-template';
import type { TriageDecision } from '../../src/triage/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OBSERVATION_ID = 'OBS-20260408-143022-a7f3';

function makeObservationReport(overrides: Record<string, string> = {}): string {
  const fm: Record<string, string> = {
    id: OBSERVATION_ID,
    service: 'orders-api',
    repo: 'github.com/acme/orders-api',
    severity: 'P1',
    confidence: '0.92',
    fingerprint: 'abc123',
    triage_status: 'pending',
    ...overrides,
  };
  const fmLines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return [
    '---',
    ...fmLines,
    '---',
    '',
    '# Connection Pool Exhaustion',
    '',
    '## Evidence',
    '',
    'Database connection pool exhausted at 2026-04-08T14:30:00Z.',
    'Active connections: 100/100. Waiting queue: 47.',
    '',
    '## Root Cause Hypothesis',
    '',
    'Connection leak in the checkout flow causing pool exhaustion under load.',
    '',
    '## Recommended Action',
    '',
    'Add connection timeout and pool size monitoring. Fix leak in checkout handler.',
    '',
    '## Metrics',
    '',
    '| Metric | Current | Target |',
    '|--------|---------|--------|',
    '| error_rate | 12.3% | 0.4% |',
    '',
  ].join('\n');
}

const MOCK_LLM_RESPONSE: LlmPrdContent = {
  title: 'Fix Connection Pool Exhaustion in Orders DB',
  problemStatement:
    'The orders-api service is experiencing connection pool exhaustion ' +
    'with error_rate at 12.3% (baseline 0.4%). Active connections reached ' +
    '100/100 with 47 requests queued.',
  scope:
    'Add connection timeout enforcement and pool size monitoring. ' +
    'Fix the connection leak in the checkout handler that prevents ' +
    'connections from being returned to the pool.',
};

const mockLlmFn: GeneratePrdViaLlmFn = async (_prompt: string) => MOCK_LLM_RESPONSE;

const PROMOTE_DECISION: TriageDecision = {
  observation_id: OBSERVATION_ID,
  file_path: '/tmp/fake',
  decision: 'promote',
  triage_by: 'pwatson',
  triage_at: '2026-04-08T15:12:00Z',
  triage_reason: 'Connection pool issue confirmed. Needs fix PRD.',
};

// ---------------------------------------------------------------------------
// extractSection
// ---------------------------------------------------------------------------

describe('extractSection', () => {
  const body = [
    '## Evidence',
    '',
    'Some evidence text.',
    '',
    '## Root Cause Hypothesis',
    '',
    'A hypothesis.',
    '',
    '## Recommended Action',
    '',
    'Do something.',
  ].join('\n');

  it('extracts a named section', () => {
    expect(extractSection(body, 'Evidence')).toBe('Some evidence text.');
  });

  it('extracts another section', () => {
    expect(extractSection(body, 'Root Cause Hypothesis')).toBe('A hypothesis.');
  });

  it('extracts the last section', () => {
    expect(extractSection(body, 'Recommended Action')).toBe('Do something.');
  });

  it('returns empty string for missing section', () => {
    expect(extractSection(body, 'Nonexistent')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// extractEvidenceFromBody
// ---------------------------------------------------------------------------

describe('extractEvidenceFromBody', () => {
  it('extracts Evidence section when present', () => {
    const body = '## Evidence\n\nPool exhausted.\n\n## Root Cause\n\nLeak.';
    expect(extractEvidenceFromBody(body)).toBe('Pool exhausted.');
  });

  it('falls back to first paragraph when no Evidence section', () => {
    const body = 'Some direct evidence paragraph.\n\nMore text.';
    expect(extractEvidenceFromBody(body)).toBe('Some direct evidence paragraph.');
  });
});

// ---------------------------------------------------------------------------
// extractMetricsFromBody
// ---------------------------------------------------------------------------

describe('extractMetricsFromBody', () => {
  it('extracts metrics from inline pattern', () => {
    const body = 'The error_rate: 12.3% (baseline: 0.4%) is too high.';
    const metrics = extractMetricsFromBody(body);
    expect(metrics.targetMetric).toBe('error_rate');
    expect(metrics.currentValue).toBe('12.3%');
    expect(metrics.baselineValue).toBe('0.4%');
  });

  it('extracts metrics from a Metrics table', () => {
    const body = [
      '## Metrics',
      '',
      '| Metric | Current | Target |',
      '|--------|---------|--------|',
      '| latency_p99 | 450ms | 200ms |',
    ].join('\n');
    const metrics = extractMetricsFromBody(body);
    expect(metrics.targetMetric).toBe('latency_p99');
    expect(metrics.currentValue).toBe('450ms');
    expect(metrics.baselineValue).toBe('200ms');
  });

  it('returns defaults when no metrics found', () => {
    const metrics = extractMetricsFromBody('No metrics here.');
    expect(metrics.targetMetric).toBe('unknown');
    expect(metrics.currentValue).toBe('unknown');
    expect(metrics.baselineValue).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// buildPrdContent (TC-4-3-01 through TC-4-3-07, TC-4-3-13)
// ---------------------------------------------------------------------------

describe('buildPrdContent', () => {
  const observation: ObservationData = {
    id: OBSERVATION_ID,
    service: 'orders-api',
    repo: 'github.com/acme/orders-api',
    severity: 'P1',
    confidence: 0.92,
    fingerprint: 'abc123',
    evidence: 'Pool exhausted at 14:30.',
    targetMetric: 'error_rate',
    currentValue: '12.3%',
    baselineValue: '0.4%',
  };
  const llmContent: LlmPrdContent = MOCK_LLM_RESPONSE;
  const prdId = 'PRD-OBS-20260408-143022-a7f3';

  let prdContent: string;

  beforeAll(() => {
    prdContent = buildPrdContent(prdId, observation, llmContent);
  });

  // TC-4-3-01: PRD created with correct YAML frontmatter
  it('TC-4-3-01: generates PRD with YAML frontmatter', () => {
    expect(prdContent).toMatch(/^---\n/);
    expect(prdContent).toMatch(/\n---\n/);
  });

  // TC-4-3-02: author, status, source fields
  it('TC-4-3-02: has correct author, status, source', () => {
    expect(prdContent).toContain(`author: ${PRD_AUTHOR}`);
    expect(prdContent).toContain(`status: ${PRD_STATUS}`);
    expect(prdContent).toContain(`source: ${PRD_SOURCE}`);
  });

  // TC-4-3-03: observation_id link
  it('TC-4-3-03: includes observation_id in frontmatter', () => {
    expect(prdContent).toContain(`observation_id: ${OBSERVATION_ID}`);
  });

  // TC-4-3-06: success criteria table
  it('TC-4-3-06: includes success criteria table with metric values', () => {
    expect(prdContent).toContain('| error_rate | 12.3% | 0.4% | Prometheus query post-deploy |');
  });

  // TC-4-3-07: problem statement with quantitative metrics
  it('TC-4-3-07: problem statement has quantitative metrics', () => {
    expect(prdContent).toContain('12.3%');
    expect(prdContent).toContain('0.4%');
    expect(prdContent).toContain(llmContent.problemStatement);
  });

  // TC-4-3-13: pipeline-compatible frontmatter
  it('TC-4-3-13: has pipeline-compatible frontmatter fields', () => {
    expect(prdContent).toContain('title:');
    expect(prdContent).toContain(`version: ${PRD_VERSION}`);
    expect(prdContent).toContain('date:');
    expect(prdContent).toContain('author:');
    expect(prdContent).toContain('status:');
  });

  it('includes severity and service in frontmatter', () => {
    expect(prdContent).toContain('severity: P1');
    expect(prdContent).toContain('service: orders-api');
  });

  it('includes constraints referencing observation', () => {
    expect(prdContent).toContain(
      `Fix must address the root cause identified in observation ${OBSERVATION_ID}`,
    );
  });

  it('includes scope from LLM content', () => {
    expect(prdContent).toContain(llmContent.scope);
  });

  it('includes evidence from observation', () => {
    expect(prdContent).toContain('Pool exhausted at 14:30.');
  });
});

// ---------------------------------------------------------------------------
// buildPrdPrompt
// ---------------------------------------------------------------------------

describe('buildPrdPrompt', () => {
  it('interpolates observation data into prompt template', () => {
    const prompt = buildPrdPrompt(
      'Full observation text here',
      'orders-api',
      'github.com/acme/orders-api',
      'P1',
      'Previous obs summary',
    );
    expect(prompt).toContain('Full observation text here');
    expect(prompt).toContain('orders-api');
    expect(prompt).toContain('github.com/acme/orders-api');
    expect(prompt).toContain('P1');
    expect(prompt).toContain('Previous obs summary');
  });

  it('uses "None" for empty previous observations', () => {
    const prompt = buildPrdPrompt('obs', 'svc', 'repo', 'P2', '');
    expect(prompt).toContain('None');
  });
});

// ---------------------------------------------------------------------------
// generatePrdFromObservation (full pipeline: TC-4-3-01 through TC-4-3-05)
// ---------------------------------------------------------------------------

describe('generatePrdFromObservation', () => {
  let tmpDir: string;
  let rootDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-gen-pipeline-'));
    rootDir = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeObservation(
    overrides: Record<string, string> = {},
  ): Promise<string> {
    const obsDir = path.join(rootDir, '.autonomous-dev', 'observations');
    await fs.mkdir(obsDir, { recursive: true });
    const obsPath = path.join(obsDir, `${OBSERVATION_ID}.md`);
    await fs.writeFile(obsPath, makeObservationReport(overrides));
    return obsPath;
  }

  // TC-4-3-01: PRD file created with correct YAML frontmatter
  it('TC-4-3-01: creates PRD file with correct YAML frontmatter', async () => {
    const obsPath = await writeObservation();
    const result = await generatePrdFromObservation(
      obsPath,
      PROMOTE_DECISION,
      rootDir,
      mockLlmFn,
    );

    const prdContent = await fs.readFile(result.file_path, 'utf-8');
    expect(prdContent).toMatch(/^---\n/);
    expect(prdContent).toContain(`author: ${PRD_AUTHOR}`);
    expect(prdContent).toContain(`status: ${PRD_STATUS}`);
    expect(prdContent).toContain(`source: ${PRD_SOURCE}`);
  });

  // TC-4-3-03: observation_id link in PRD frontmatter
  it('TC-4-3-03: links observation_id in PRD frontmatter', async () => {
    const obsPath = await writeObservation();
    const result = await generatePrdFromObservation(
      obsPath,
      PROMOTE_DECISION,
      rootDir,
      mockLlmFn,
    );

    const prdContent = await fs.readFile(result.file_path, 'utf-8');
    expect(prdContent).toContain(`observation_id: ${OBSERVATION_ID}`);
  });

  // TC-4-3-04: PRD written to correct file path
  it('TC-4-3-04: writes PRD to .autonomous-dev/prd/PRD-OBS-<id>.md', async () => {
    const obsPath = await writeObservation();
    const result = await generatePrdFromObservation(
      obsPath,
      PROMOTE_DECISION,
      rootDir,
      mockLlmFn,
    );

    const expectedPrdId = 'PRD-OBS-20260408-143022-a7f3';
    expect(result.prd_id).toBe(expectedPrdId);
    expect(result.file_path).toBe(
      path.join(rootDir, '.autonomous-dev', 'prd', `${expectedPrdId}.md`),
    );
    // Verify file actually exists
    const stat = await fs.stat(result.file_path);
    expect(stat.isFile()).toBe(true);
  });

  // TC-4-3-05: observation updated with linked_prd
  it('TC-4-3-05: updates observation with linked_prd field', async () => {
    const obsPath = await writeObservation();
    const result = await generatePrdFromObservation(
      obsPath,
      PROMOTE_DECISION,
      rootDir,
      mockLlmFn,
    );

    const updatedObs = await fs.readFile(obsPath, 'utf-8');
    expect(updatedObs).toContain(`linked_prd: ${result.prd_id}`);
  });

  it('returns correct observation_id in result', async () => {
    const obsPath = await writeObservation();
    const result = await generatePrdFromObservation(
      obsPath,
      PROMOTE_DECISION,
      rootDir,
      mockLlmFn,
    );
    expect(result.observation_id).toBe(OBSERVATION_ID);
  });

  it('passes previous observation summary to LLM', async () => {
    const obsPath = await writeObservation();
    let capturedPrompt = '';
    const capturingLlm: GeneratePrdViaLlmFn = async (prompt: string) => {
      capturedPrompt = prompt;
      return MOCK_LLM_RESPONSE;
    };

    const getPreviousObs = async (_service: string) =>
      'OBS-123 on 2026-04-01: error_rate spike';

    await generatePrdFromObservation(
      obsPath,
      PROMOTE_DECISION,
      rootDir,
      capturingLlm,
      getPreviousObs,
    );

    expect(capturedPrompt).toContain('OBS-123 on 2026-04-01: error_rate spike');
  });

  it('creates parent directories for PRD file', async () => {
    const obsPath = await writeObservation();
    const result = await generatePrdFromObservation(
      obsPath,
      PROMOTE_DECISION,
      rootDir,
      mockLlmFn,
    );
    // The .autonomous-dev/prd directory should have been created
    const prdDir = path.dirname(result.file_path);
    const stat = await fs.stat(prdDir);
    expect(stat.isDirectory()).toBe(true);
  });

  // TC-4-3-06: Success criteria table in generated PRD
  it('TC-4-3-06: PRD contains success criteria table with metric values', async () => {
    const obsPath = await writeObservation();
    const result = await generatePrdFromObservation(
      obsPath,
      PROMOTE_DECISION,
      rootDir,
      mockLlmFn,
    );

    const prdContent = await fs.readFile(result.file_path, 'utf-8');
    expect(prdContent).toContain('## Success Criteria');
    expect(prdContent).toContain('error_rate');
    expect(prdContent).toContain('12.3%');
    expect(prdContent).toContain('0.4%');
  });

  it('throws when observation file is invalid', async () => {
    const obsDir = path.join(rootDir, '.autonomous-dev', 'observations');
    await fs.mkdir(obsDir, { recursive: true });
    const badPath = path.join(obsDir, 'bad.md');
    await fs.writeFile(badPath, 'No frontmatter here');

    await expect(
      generatePrdFromObservation(badPath, PROMOTE_DECISION, rootDir, mockLlmFn),
    ).rejects.toThrow('Invalid observation file');
  });
});

// ---------------------------------------------------------------------------
// createPrdGenerator (triage processor integration)
// ---------------------------------------------------------------------------

describe('createPrdGenerator', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-factory-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns a function matching GeneratePrdFromObservationFn signature', async () => {
    const obsDir = path.join(tmpDir, '.autonomous-dev', 'observations');
    await fs.mkdir(obsDir, { recursive: true });
    const obsPath = path.join(obsDir, `${OBSERVATION_ID}.md`);
    await fs.writeFile(
      obsPath,
      [
        '---',
        `id: ${OBSERVATION_ID}`,
        'service: orders-api',
        'triage_status: pending',
        '---',
        '',
        '## Evidence',
        '',
        'Some evidence.',
      ].join('\n'),
    );

    const generator = createPrdGenerator(tmpDir, mockLlmFn);
    const prdId = await generator(obsPath, PROMOTE_DECISION);

    expect(prdId).toBe('PRD-OBS-20260408-143022-a7f3');
  });
});

// ---------------------------------------------------------------------------
// SPEC-007-4-4: PRD format and compatibility tests
// ---------------------------------------------------------------------------

describe('PRD Generator - SPEC-007-4-4 format and compatibility', () => {
  let tmpDir: string;
  let rootDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prd-compat-'));
    rootDir = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeObs(overrides: Record<string, string> = {}): Promise<string> {
    const obsDir = path.join(rootDir, '.autonomous-dev', 'observations');
    await fs.mkdir(obsDir, { recursive: true });
    const obsPath = path.join(obsDir, `${OBSERVATION_ID}.md`);
    await fs.writeFile(obsPath, makeObservationReport(overrides));
    return obsPath;
  }

  test('PRD ID follows PRD-OBS-<date>-<time>-<hex> convention', async () => {
    const obsPath = await writeObs();
    const result = await generatePrdFromObservation(
      obsPath,
      PROMOTE_DECISION,
      rootDir,
      mockLlmFn,
    );
    expect(result.prd_id).toMatch(/^PRD-OBS-\d{8}-\d{6}-[a-f0-9]{4}$/);
  });

  test('PRD contains all required sections', async () => {
    const obsPath = await writeObs();
    const result = await generatePrdFromObservation(
      obsPath,
      PROMOTE_DECISION,
      rootDir,
      mockLlmFn,
    );

    const prdContent = await fs.readFile(result.file_path, 'utf-8');
    expect(prdContent).toContain('## Problem Statement');
    expect(prdContent).toContain('## Evidence');
    expect(prdContent).toContain('## Constraints');
    expect(prdContent).toContain('## Success Criteria');
    expect(prdContent).toContain('## Scope');
  });

  test('PRD frontmatter is pipeline-compatible with required fields', async () => {
    const obsPath = await writeObs();
    const result = await generatePrdFromObservation(
      obsPath,
      PROMOTE_DECISION,
      rootDir,
      mockLlmFn,
    );

    const prdContent = await fs.readFile(result.file_path, 'utf-8');
    const requiredFields = ['title', 'version', 'date', 'author', 'status', 'source', 'observation_id', 'severity', 'service'];
    for (const field of requiredFields) {
      expect(prdContent).toContain(`${field}:`);
    }
  });

  test('PRD severity matches observation severity', async () => {
    const obsPath = await writeObs({ severity: 'P0' });
    const result = await generatePrdFromObservation(
      obsPath,
      PROMOTE_DECISION,
      rootDir,
      mockLlmFn,
    );

    const prdContent = await fs.readFile(result.file_path, 'utf-8');
    expect(prdContent).toContain('severity: P0');
  });

  test('PRD observation_id links back to source observation', async () => {
    const obsPath = await writeObs();
    const result = await generatePrdFromObservation(
      obsPath,
      PROMOTE_DECISION,
      rootDir,
      mockLlmFn,
    );

    const prdContent = await fs.readFile(result.file_path, 'utf-8');
    expect(prdContent).toContain(`observation_id: ${OBSERVATION_ID}`);
    expect(prdContent).toContain(`observation ${OBSERVATION_ID}`);
  });
});
