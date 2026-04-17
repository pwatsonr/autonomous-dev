/**
 * Integration test: digest generation with a week of mock data (SPEC-007-5-6).
 *
 * Test cases:
 *   TC-5-6-15: Digest signal-to-noise (14 obs, 4 promoted, 1 investigating = 35.7%)
 *   TC-5-6-16: Digest small sample (3 obs total -> SNR = "N/A")
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  generateWeeklyDigest,
  computeSummaryMetrics,
  computeWeekBounds,
} from '../../src/reports/weekly-digest';
import type { ObservationForDigest } from '../../src/reports/digest-types';
import { setupTestDir, fileExists } from '../helpers/mock-observations';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write observation files matching TDD Appendix A scenario:
 *   14 observations total
 *   P0:1, P1:3, P2:7, P3:3
 *   promote:4, dismiss:5, defer:2, investigate:1, pending:2
 */
async function seedAppendixAData(rootDir: string): Promise<void> {
  const obsDir = path.join(rootDir, '.autonomous-dev', 'observations', '2026', '04');
  await fs.mkdir(obsDir, { recursive: true });

  const specs: Array<{
    id: string;
    service: string;
    severity: string;
    type: string;
    triage_decision: string | null;
    triage_at: string | null;
    effectiveness: string | null;
    oscillation_warning: boolean;
    error_class?: string;
    tokens: number;
    run: string;
  }> = [
    // P0: 1 (promoted)
    { id: 'OBS-20260406-090000-a001', service: 'api-gateway', severity: 'P0', type: 'error', triage_decision: 'promote', triage_at: '2026-04-06T10:00:00Z', effectiveness: 'improved', oscillation_warning: false, tokens: 42000, run: 'RUN-20260406-090000' },
    // P1: 3 (1 promoted, 1 dismissed, 1 investigating)
    { id: 'OBS-20260406-100000-a002', service: 'api-gateway', severity: 'P1', type: 'error', triage_decision: 'promote', triage_at: '2026-04-06T11:00:00Z', effectiveness: null, oscillation_warning: false, tokens: 38000, run: 'RUN-20260406-100000' },
    { id: 'OBS-20260407-080000-a003', service: 'payment-svc', severity: 'P1', type: 'error', triage_decision: 'dismiss', triage_at: '2026-04-07T09:00:00Z', effectiveness: null, oscillation_warning: false, tokens: 35000, run: 'RUN-20260407-080000' },
    { id: 'OBS-20260408-060000-a004', service: 'auth-svc', severity: 'P1', type: 'anomaly', triage_decision: 'investigate', triage_at: '2026-04-08T07:00:00Z', effectiveness: null, oscillation_warning: false, tokens: 40000, run: 'RUN-20260408-060000' },
    // P2: 7 (2 promoted, 3 dismissed, 1 deferred, 1 pending)
    { id: 'OBS-20260406-110000-a005', service: 'api-gateway', severity: 'P2', type: 'error', triage_decision: 'promote', triage_at: '2026-04-06T14:00:00Z', effectiveness: null, oscillation_warning: true, error_class: 'ConnPool', tokens: 30000, run: 'RUN-20260406-110000' },
    { id: 'OBS-20260406-120000-a006', service: 'search-svc', severity: 'P2', type: 'error', triage_decision: 'promote', triage_at: '2026-04-06T15:00:00Z', effectiveness: null, oscillation_warning: false, tokens: 28000, run: 'RUN-20260406-120000' },
    { id: 'OBS-20260407-090000-a007', service: 'payment-svc', severity: 'P2', type: 'anomaly', triage_decision: 'dismiss', triage_at: '2026-04-07T10:00:00Z', effectiveness: null, oscillation_warning: false, tokens: 25000, run: 'RUN-20260407-090000' },
    { id: 'OBS-20260407-100000-a008', service: 'search-svc', severity: 'P2', type: 'error', triage_decision: 'dismiss', triage_at: '2026-04-07T11:00:00Z', effectiveness: null, oscillation_warning: false, tokens: 27000, run: 'RUN-20260407-090000' },
    { id: 'OBS-20260407-110000-a009', service: 'auth-svc', severity: 'P2', type: 'trend', triage_decision: 'dismiss', triage_at: '2026-04-07T14:00:00Z', effectiveness: null, oscillation_warning: false, tokens: 22000, run: 'RUN-20260407-110000' },
    { id: 'OBS-20260408-070000-a010', service: 'api-gateway', severity: 'P2', type: 'error', triage_decision: 'defer', triage_at: '2026-04-08T08:00:00Z', effectiveness: null, oscillation_warning: false, tokens: 26000, run: 'RUN-20260408-070000' },
    { id: 'OBS-20260408-080000-a011', service: 'payment-svc', severity: 'P2', type: 'error', triage_decision: null, triage_at: null, effectiveness: null, oscillation_warning: false, tokens: 24000, run: 'RUN-20260408-080000' },
    // P3: 3 (1 deferred, 1 dismissed, 1 pending)
    { id: 'OBS-20260406-130000-a012', service: 'cdn-svc', severity: 'P3', type: 'trend', triage_decision: 'defer', triage_at: '2026-04-06T16:00:00Z', effectiveness: null, oscillation_warning: false, tokens: 18000, run: 'RUN-20260406-130000' },
    { id: 'OBS-20260407-120000-a013', service: 'cdn-svc', severity: 'P3', type: 'anomaly', triage_decision: 'dismiss', triage_at: '2026-04-07T15:00:00Z', effectiveness: null, oscillation_warning: false, tokens: 16000, run: 'RUN-20260407-120000' },
    { id: 'OBS-20260408-090000-a014', service: 'search-svc', severity: 'P3', type: 'trend', triage_decision: null, triage_at: null, effectiveness: null, oscillation_warning: false, tokens: 15000, run: 'RUN-20260408-090000' },
  ];

  for (const spec of specs) {
    const lines: string[] = [
      '---',
      `id: ${spec.id}`,
      `timestamp: "${spec.id.replace('OBS-', '').substring(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')}T${spec.id.substring(13, 15)}:${spec.id.substring(15, 17)}:${spec.id.substring(17, 19)}Z"`,
      `service: ${spec.service}`,
      `type: ${spec.type}`,
      `severity: ${spec.severity}`,
      `triage_decision: ${spec.triage_decision ?? 'null'}`,
      `triage_at: ${spec.triage_at ? `"${spec.triage_at}"` : 'null'}`,
      `observation_run_id: ${spec.run}`,
      `tokens_consumed: ${spec.tokens}`,
      `linked_prd: null`,
      `linked_deployment: null`,
      `effectiveness: ${spec.effectiveness ?? 'null'}`,
      `effectiveness_detail: null`,
      `oscillation_warning: ${spec.oscillation_warning}`,
      `cooldown_active: false`,
      spec.error_class ? `error_class: ${spec.error_class}` : '',
      '---',
      '',
      `# Observation: ${spec.id}`,
      '',
      'Mock observation data.',
    ].filter(Boolean);

    await fs.writeFile(
      path.join(obsDir, `${spec.id}.md`),
      lines.join('\n'),
      'utf-8',
    );
  }
}

/**
 * Write a small set of observations (3 total) for the small-sample test.
 */
async function seedSmallSampleData(rootDir: string): Promise<void> {
  const obsDir = path.join(rootDir, '.autonomous-dev', 'observations', '2026', '04');
  await fs.mkdir(obsDir, { recursive: true });

  const specs = [
    { id: 'OBS-20260406-090000-s001', severity: 'P1', triage_decision: 'promote' },
    { id: 'OBS-20260407-090000-s002', severity: 'P2', triage_decision: 'dismiss' },
    { id: 'OBS-20260408-090000-s003', severity: 'P2', triage_decision: null },
  ];

  for (const spec of specs) {
    const ts = `${spec.id.substring(4, 8)}-${spec.id.substring(8, 10)}-${spec.id.substring(10, 12)}T${spec.id.substring(13, 15)}:${spec.id.substring(15, 17)}:${spec.id.substring(17, 19)}Z`;
    await fs.writeFile(
      path.join(obsDir, `${spec.id}.md`),
      [
        '---',
        `id: ${spec.id}`,
        `timestamp: "${ts}"`,
        `service: api-gateway`,
        `type: error`,
        `severity: ${spec.severity}`,
        `triage_decision: ${spec.triage_decision ?? 'null'}`,
        `triage_at: null`,
        `observation_run_id: RUN-test`,
        `tokens_consumed: 30000`,
        `linked_prd: null`,
        `linked_deployment: null`,
        `effectiveness: null`,
        `effectiveness_detail: null`,
        `oscillation_warning: false`,
        `cooldown_active: false`,
        '---',
        '',
        `# Observation: ${spec.id}`,
      ].join('\n'),
      'utf-8',
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('weekly digest generation', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await setupTestDir();
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  // TC-5-6-15: Digest signal-to-noise with TDD Appendix A data
  test('TC-5-6-15: generates digest with correct aggregation from Appendix A mock data', async () => {
    await seedAppendixAData(rootDir);

    // 2026-W15 covers April 6 (Mon) through April 12 (Sun)
    const result = await generateWeeklyDigest(rootDir, '2026-W15');

    expect(result.summary.total_observations).toBe(14);
    expect(result.summary.by_severity).toEqual({ P0: 1, P1: 3, P2: 7, P3: 3 });
    expect(result.summary.triage_decisions.promote).toBe(4);
    expect(result.summary.triage_decisions.dismiss).toBe(5);
    expect(result.summary.triage_decisions.defer).toBe(2);
    expect(result.summary.triage_decisions.investigate).toBe(1);
    expect(result.summary.triage_decisions.pending).toBe(2);

    // Signal-to-noise: (4 promoted + 1 investigating) / 14 = 35.7%
    expect(result.summary.signal_to_noise_ratio).toBeCloseTo(35.7, 1);
    expect(result.summary.signal_to_noise_display).toContain('(4+1) / 14');

    // Verify file exists
    expect(await fileExists(result.filePath)).toBe(true);
    const content = await fs.readFile(result.filePath, 'utf-8');
    expect(content).toContain('## Summary');
    expect(content).toContain('## Observations by Service');
    expect(content).toContain('## Effectiveness Tracking');
    expect(content).toContain('## Recurring Patterns');
    expect(content).toContain('## Recommendations');
  });

  // TC-5-6-16: Digest small sample
  test('TC-5-6-16: small sample (3 obs) shows SNR as N/A', async () => {
    await seedSmallSampleData(rootDir);

    const result = await generateWeeklyDigest(rootDir, '2026-W15');

    expect(result.summary.total_observations).toBe(3);
    expect(result.summary.signal_to_noise_ratio).toBeNull();
    expect(result.summary.signal_to_noise_display).toContain('N/A');
    expect(result.summary.signal_to_noise_display).toContain('<5');
  });

  test('digest file is placed in correct directory', async () => {
    await seedAppendixAData(rootDir);
    const result = await generateWeeklyDigest(rootDir, '2026-W15');

    const expectedDir = path.join(rootDir, '.autonomous-dev', 'observations', 'digests');
    expect(result.filePath).toContain(expectedDir);
    expect(result.filePath).toContain('DIGEST-2026W15.md');
  });

  test('digest is idempotent (running twice produces same result)', async () => {
    await seedAppendixAData(rootDir);

    const result1 = await generateWeeklyDigest(rootDir, '2026-W15');
    const content1 = await fs.readFile(result1.filePath, 'utf-8');

    const result2 = await generateWeeklyDigest(rootDir, '2026-W15');
    const content2 = await fs.readFile(result2.filePath, 'utf-8');

    // Summary metrics should be identical
    expect(result1.summary.total_observations).toBe(result2.summary.total_observations);
    expect(result1.summary.signal_to_noise_ratio).toBe(result2.summary.signal_to_noise_ratio);
    expect(result1.summary.triage_decisions).toEqual(result2.summary.triage_decisions);
  });

  test('digest YAML frontmatter includes week and period', async () => {
    await seedAppendixAData(rootDir);
    const result = await generateWeeklyDigest(rootDir, '2026-W15');
    const content = await fs.readFile(result.filePath, 'utf-8');

    expect(content).toContain('type: digest');
    expect(content).toContain('week: "2026-W15"');
    expect(content).toContain('generated_at:');
  });

  test('empty week produces digest with zero observations', async () => {
    // No observation files seeded
    const result = await generateWeeklyDigest(rootDir, '2026-W15');

    expect(result.summary.total_observations).toBe(0);
    expect(result.summary.signal_to_noise_ratio).toBeNull();
    expect(await fileExists(result.filePath)).toBe(true);
  });
});

describe('computeSummaryMetrics with Appendix A data', () => {
  test('computes correct severity counts', () => {
    const observations: ObservationForDigest[] = [
      makeObs('P0', 'promote'),
      makeObs('P1', 'promote'),
      makeObs('P1', 'dismiss'),
      makeObs('P1', 'investigate'),
      makeObs('P2', 'promote'),
      makeObs('P2', 'promote'),
      makeObs('P2', 'dismiss'),
      makeObs('P2', 'dismiss'),
      makeObs('P2', 'dismiss'),
      makeObs('P2', 'defer'),
      makeObs('P2', null),
      makeObs('P3', 'defer'),
      makeObs('P3', 'dismiss'),
      makeObs('P3', null),
    ];

    const summary = computeSummaryMetrics(observations);

    expect(summary.total_observations).toBe(14);
    expect(summary.by_severity).toEqual({ P0: 1, P1: 3, P2: 7, P3: 3 });
    expect(summary.triage_decisions.promote).toBe(4);
    expect(summary.triage_decisions.dismiss).toBe(5);
    expect(summary.triage_decisions.defer).toBe(2);
    expect(summary.triage_decisions.investigate).toBe(1);
    expect(summary.triage_decisions.pending).toBe(2);
    expect(summary.signal_to_noise_ratio).toBeCloseTo(35.7, 1);
  });
});

// ---------------------------------------------------------------------------
// Helpers for computeSummaryMetrics tests
// ---------------------------------------------------------------------------

let obsCounter = 0;

function makeObs(severity: string, triage_decision: string | null): ObservationForDigest {
  obsCounter++;
  return {
    id: `OBS-${obsCounter.toString().padStart(4, '0')}`,
    timestamp: '2026-04-07T10:00:00Z',
    service: 'api-gateway',
    type: 'error',
    severity,
    triage_decision,
    triage_at: null,
    observation_run_id: 'RUN-test',
    tokens_consumed: 30000,
    linked_prd: null,
    linked_deployment: null,
    effectiveness: null,
    effectiveness_detail: null,
    oscillation_warning: false,
    cooldown_active: false,
  };
}
