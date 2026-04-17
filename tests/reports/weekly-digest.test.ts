/**
 * Unit tests for weekly digest generation and aggregation math
 * (SPEC-007-5-3, Task 6).
 *
 * Test cases:
 *   TC-5-3-06: Digest summary math
 *   TC-5-3-07: Signal-to-noise ratio
 *   TC-5-3-08: Signal-to-noise suppression
 *   TC-5-3-09: Triage latency computation
 *   TC-5-3-10: Tokens per run average
 *   TC-5-3-11: Service breakdown table
 *   TC-5-3-12: Effectiveness tracking table
 *   TC-5-3-13: Recurring patterns table
 *   TC-5-3-14: Recommendation: oscillation
 *   TC-5-3-15: Recommendation: low SNR
 *   TC-5-3-16: Digest file placement
 *   TC-5-3-17: Digest idempotency
 *   TC-5-3-18: Digest YAML frontmatter
 *   TC-5-3-19: ISO week computation
 *   TC-5-3-20: Week bounds
 *   TC-5-3-21: Empty week
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import {
  generateWeeklyDigest,
  computeIsoWeek,
  computeWeekBounds,
  computeSummaryMetrics,
  computeServiceBreakdown,
  collectEffectivenessResults,
  detectRecurringPatterns,
  generateRecommendations,
  renderDigest,
  formatDate,
  formatSeverityCounts,
  formatTypeCounts,
  formatTriageCounts,
  formatLatency,
} from '../../src/reports/weekly-digest';

import type {
  DigestSummary,
  ObservationForDigest,
  RecurringPattern,
} from '../../src/reports/digest-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a test observation with default values and overrides.
 */
function makeObservation(overrides: Partial<ObservationForDigest> = {}): ObservationForDigest {
  return {
    id: 'OBS-20260408-100000-a001',
    timestamp: '2026-04-08T10:00:00.000Z',
    service: 'api-gateway',
    type: 'error',
    severity: 'P2',
    triage_decision: null,
    triage_at: null,
    observation_run_id: 'RUN-20260408-100000',
    tokens_consumed: 1500,
    linked_prd: null,
    linked_deployment: null,
    effectiveness: null,
    effectiveness_detail: null,
    oscillation_warning: false,
    cooldown_active: false,
    ...overrides,
  };
}

/**
 * Write a test observation file to the expected directory structure.
 */
async function writeObservationFile(
  rootDir: string,
  obs: ObservationForDigest,
): Promise<void> {
  const year = obs.id.slice(4, 8);
  const month = obs.id.slice(8, 10);
  const dir = path.join(rootDir, '.autonomous-dev', 'observations', year, month);
  await fs.mkdir(dir, { recursive: true });

  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(obs)) {
    if (v === null) {
      lines.push(`${k}: null`);
    } else if (typeof v === 'boolean') {
      lines.push(`${k}: ${v}`);
    } else if (typeof v === 'number') {
      lines.push(`${k}: ${v}`);
    } else if (typeof v === 'string') {
      lines.push(`${k}: "${v}"`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push('# Observation: Test');
  lines.push('');
  lines.push('Test body.');

  const filePath = path.join(dir, `${obs.id}.md`);
  await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
}

/**
 * Build the TDD Appendix A test dataset: 14 observations with specific
 * severity/triage/type distributions.
 */
function makeAppendixADataset(): ObservationForDigest[] {
  const baseTimestamp = '2026-04-08T10:00:00.000Z';
  let counter = 0;
  const mkId = () => {
    counter++;
    return `OBS-20260408-10${String(counter).padStart(4, '0')}-a${String(counter).padStart(3, '0')}`;
  };

  // P0: 1, P1: 3, P2: 7, P3: 3
  // triage: promote:4, dismiss:5, defer:2, investigate:1, pending:2
  // type: error:8, anomaly:4, trend:2
  const observations: ObservationForDigest[] = [];

  // P0 x1 (promote) - error
  observations.push(makeObservation({
    id: mkId(), severity: 'P0', triage_decision: 'promote', type: 'error',
    timestamp: baseTimestamp, observation_run_id: 'RUN-001', tokens_consumed: 35000,
    triage_at: '2026-04-08T11:00:00.000Z', // 1h latency
    service: 'api-gateway',
  }));

  // P1 x3 (1 promote, 1 dismiss, 1 investigate)
  observations.push(makeObservation({
    id: mkId(), severity: 'P1', triage_decision: 'promote', type: 'error',
    timestamp: baseTimestamp, observation_run_id: 'RUN-001', tokens_consumed: 0,
    triage_at: '2026-04-08T13:12:00.000Z', // 3.2h latency
    service: 'api-gateway',
  }));
  observations.push(makeObservation({
    id: mkId(), severity: 'P1', triage_decision: 'dismiss', type: 'error',
    timestamp: baseTimestamp, observation_run_id: 'RUN-001', tokens_consumed: 0,
    service: 'auth-service',
  }));
  observations.push(makeObservation({
    id: mkId(), severity: 'P1', triage_decision: 'investigate', type: 'anomaly',
    timestamp: baseTimestamp, observation_run_id: 'RUN-002', tokens_consumed: 38000,
    service: 'auth-service',
  }));

  // P2 x7 (2 promote, 3 dismiss, 1 defer, 1 pending)
  observations.push(makeObservation({
    id: mkId(), severity: 'P2', triage_decision: 'promote', type: 'error',
    timestamp: baseTimestamp, observation_run_id: 'RUN-002', tokens_consumed: 0,
    triage_at: '2026-04-08T22:00:00.000Z', // 12h latency
    service: 'data-pipeline',
  }));
  observations.push(makeObservation({
    id: mkId(), severity: 'P2', triage_decision: 'dismiss', type: 'error',
    timestamp: baseTimestamp, observation_run_id: 'RUN-002', tokens_consumed: 0,
    service: 'api-gateway',
  }));
  observations.push(makeObservation({
    id: mkId(), severity: 'P2', triage_decision: 'dismiss', type: 'anomaly',
    timestamp: baseTimestamp, observation_run_id: 'RUN-003', tokens_consumed: 41600,
    service: 'api-gateway',
  }));
  observations.push(makeObservation({
    id: mkId(), severity: 'P2', triage_decision: 'defer', type: 'anomaly',
    timestamp: baseTimestamp, observation_run_id: 'RUN-003', tokens_consumed: 0,
    service: 'auth-service',
  }));
  observations.push(makeObservation({
    id: mkId(), severity: 'P2', triage_decision: null, type: 'error',
    timestamp: baseTimestamp, observation_run_id: 'RUN-003', tokens_consumed: 0,
    service: 'data-pipeline',
  }));
  observations.push(makeObservation({
    id: mkId(), severity: 'P2', triage_decision: 'promote', type: 'trend',
    timestamp: baseTimestamp, observation_run_id: 'RUN-003', tokens_consumed: 0,
    triage_at: '2026-04-09T04:00:00.000Z', // 18h latency
    service: 'api-gateway',
  }));
  observations.push(makeObservation({
    id: mkId(), severity: 'P2', triage_decision: 'dismiss', type: 'error',
    timestamp: baseTimestamp, observation_run_id: 'RUN-003', tokens_consumed: 0,
    service: 'auth-service',
  }));

  // P3 x3 (1 defer, 1 dismiss, 1 pending)
  observations.push(makeObservation({
    id: mkId(), severity: 'P3', triage_decision: 'defer', type: 'error',
    timestamp: baseTimestamp, observation_run_id: 'RUN-003', tokens_consumed: 0,
    service: 'data-pipeline',
  }));
  observations.push(makeObservation({
    id: mkId(), severity: 'P3', triage_decision: 'dismiss', type: 'anomaly',
    timestamp: baseTimestamp, observation_run_id: 'RUN-003', tokens_consumed: 0,
    service: 'api-gateway',
  }));
  observations.push(makeObservation({
    id: mkId(), severity: 'P3', triage_decision: null, type: 'trend',
    timestamp: baseTimestamp, observation_run_id: 'RUN-003', tokens_consumed: 0,
    service: 'data-pipeline',
  }));

  return observations;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WeeklyDigest', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'digest-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // TC-5-3-06: Digest summary math
  // -------------------------------------------------------------------------
  describe('TC-5-3-06: digest summary math', () => {
    it('computes correct summary metrics for 14 observations', () => {
      const observations = makeAppendixADataset();
      const summary = computeSummaryMetrics(observations);

      expect(summary.total_observations).toBe(14);
      expect(summary.by_severity).toEqual({ P0: 1, P1: 3, P2: 7, P3: 3 });
      expect(summary.by_type).toEqual({ error: 8, anomaly: 4, trend: 2 });
      expect(summary.triage_decisions).toEqual({
        promote: 4,
        dismiss: 5,
        defer: 2,
        investigate: 1,
        pending: 2,
      });
    });
  });

  // -------------------------------------------------------------------------
  // TC-5-3-07: Signal-to-noise ratio
  // -------------------------------------------------------------------------
  describe('TC-5-3-07: signal-to-noise ratio', () => {
    it('computes (4+1) / 14 = 35.7%', () => {
      const observations = makeAppendixADataset();
      const summary = computeSummaryMetrics(observations);

      expect(summary.signal_to_noise_ratio).toBeCloseTo(35.7, 1);
      expect(summary.signal_to_noise_display).toBe('(4+1) / 14 = 35.7%');
    });
  });

  // -------------------------------------------------------------------------
  // TC-5-3-08: Signal-to-noise suppression
  // -------------------------------------------------------------------------
  describe('TC-5-3-08: signal-to-noise suppression', () => {
    it('shows N/A when total observations < 5', () => {
      const observations = [
        makeObservation({ triage_decision: 'promote' }),
        makeObservation({ triage_decision: 'dismiss' }),
        makeObservation({ triage_decision: null }),
      ];

      const summary = computeSummaryMetrics(observations);

      expect(summary.signal_to_noise_ratio).toBeNull();
      expect(summary.signal_to_noise_display).toBe('N/A (<5 observations)');
    });

    it('computes ratio when exactly 5 observations', () => {
      const observations = [
        makeObservation({ triage_decision: 'promote' }),
        makeObservation({ triage_decision: 'promote' }),
        makeObservation({ triage_decision: 'dismiss' }),
        makeObservation({ triage_decision: 'dismiss' }),
        makeObservation({ triage_decision: null }),
      ];

      const summary = computeSummaryMetrics(observations);

      expect(summary.signal_to_noise_ratio).not.toBeNull();
      expect(summary.signal_to_noise_ratio).toBeCloseTo(40.0, 1);
    });
  });

  // -------------------------------------------------------------------------
  // TC-5-3-09: Triage latency computation
  // -------------------------------------------------------------------------
  describe('TC-5-3-09: triage latency computation', () => {
    it('computes separate P0/P1 and P2/P3 averages', () => {
      const baseTs = '2026-04-08T10:00:00.000Z';
      const observations = [
        // P0: triaged at 1h
        makeObservation({
          severity: 'P0',
          timestamp: baseTs,
          triage_at: '2026-04-08T11:00:00.000Z',
          triage_decision: 'promote',
        }),
        // P1: triaged at 3.2h
        makeObservation({
          severity: 'P1',
          timestamp: baseTs,
          triage_at: '2026-04-08T13:12:00.000Z',
          triage_decision: 'promote',
        }),
        // P2: triaged at 12h
        makeObservation({
          severity: 'P2',
          timestamp: baseTs,
          triage_at: '2026-04-08T22:00:00.000Z',
          triage_decision: 'dismiss',
        }),
        // P2: triaged at 18h
        makeObservation({
          severity: 'P2',
          timestamp: baseTs,
          triage_at: '2026-04-09T04:00:00.000Z',
          triage_decision: 'promote',
        }),
        // P3: triaged at 25.2h
        makeObservation({
          severity: 'P3',
          timestamp: baseTs,
          triage_at: '2026-04-09T11:12:00.000Z',
          triage_decision: 'dismiss',
        }),
      ];

      const summary = computeSummaryMetrics(observations);

      // P0/P1 avg: (1 + 3.2) / 2 = 2.1
      expect(summary.avg_triage_latency_p0p1_hours).toBeCloseTo(2.1, 1);
      // P2/P3 avg: (12 + 18 + 25.2) / 3 = 18.4
      expect(summary.avg_triage_latency_p2p3_hours).toBeCloseTo(18.4, 1);
    });

    it('returns null when no triage timestamps exist', () => {
      const observations = [
        makeObservation({ severity: 'P0', triage_at: null }),
        makeObservation({ severity: 'P2', triage_at: null }),
      ];

      const summary = computeSummaryMetrics(observations);

      expect(summary.avg_triage_latency_p0p1_hours).toBeNull();
      expect(summary.avg_triage_latency_p2p3_hours).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // TC-5-3-10: Tokens per run average
  // -------------------------------------------------------------------------
  describe('TC-5-3-10: tokens per run average', () => {
    it('computes average tokens across unique runs', () => {
      const observations = [
        // RUN-001: 35000 tokens
        makeObservation({ observation_run_id: 'RUN-001', tokens_consumed: 35000 }),
        // RUN-002: 38000 tokens
        makeObservation({ observation_run_id: 'RUN-002', tokens_consumed: 38000 }),
        // RUN-003: 41600 tokens
        makeObservation({ observation_run_id: 'RUN-003', tokens_consumed: 41600 }),
      ];

      const summary = computeSummaryMetrics(observations);

      // avg: (35000 + 38000 + 41600) / 3 = 38200
      expect(summary.avg_tokens_per_run).toBe(38200);
    });

    it('aggregates tokens from the same run', () => {
      const observations = [
        makeObservation({ observation_run_id: 'RUN-001', tokens_consumed: 20000 }),
        makeObservation({ observation_run_id: 'RUN-001', tokens_consumed: 15000 }),
        makeObservation({ observation_run_id: 'RUN-002', tokens_consumed: 38000 }),
      ];

      const summary = computeSummaryMetrics(observations);

      // RUN-001: 35000, RUN-002: 38000 => avg: 36500
      expect(summary.avg_tokens_per_run).toBe(36500);
    });
  });

  // -------------------------------------------------------------------------
  // TC-5-3-11: Service breakdown table
  // -------------------------------------------------------------------------
  describe('TC-5-3-11: service breakdown table', () => {
    it('produces one row per service with correct counts', () => {
      const observations = [
        makeObservation({ service: 'api-gateway', severity: 'P0', triage_decision: 'promote' }),
        makeObservation({ service: 'api-gateway', severity: 'P2', triage_decision: 'dismiss' }),
        makeObservation({ service: 'api-gateway', severity: 'P2', triage_decision: null }),
        makeObservation({ service: 'auth-service', severity: 'P1', triage_decision: 'promote' }),
        makeObservation({ service: 'auth-service', severity: 'P3', triage_decision: 'dismiss' }),
        makeObservation({ service: 'data-pipeline', severity: 'P2', triage_decision: 'defer' }),
      ];

      const breakdown = computeServiceBreakdown(observations);

      expect(breakdown.length).toBe(3);

      const apiGateway = breakdown.find((b) => b.service === 'api-gateway')!;
      expect(apiGateway.total_observations).toBe(3);
      expect(apiGateway.p0_p1_count).toBe(1);
      expect(apiGateway.promoted).toBe(1);
      expect(apiGateway.dismissed).toBe(1);

      const authService = breakdown.find((b) => b.service === 'auth-service')!;
      expect(authService.total_observations).toBe(2);
      expect(authService.p0_p1_count).toBe(1);
      expect(authService.promoted).toBe(1);
      expect(authService.dismissed).toBe(1);

      const dataPipeline = breakdown.find((b) => b.service === 'data-pipeline')!;
      expect(dataPipeline.total_observations).toBe(1);
      expect(dataPipeline.p0_p1_count).toBe(0);
      expect(dataPipeline.promoted).toBe(0);
      expect(dataPipeline.dismissed).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // TC-5-3-12: Effectiveness tracking table
  // -------------------------------------------------------------------------
  describe('TC-5-3-12: effectiveness tracking table', () => {
    it('collects effectiveness entries from evaluated observations', () => {
      const observations = [
        makeObservation({
          id: 'OBS-001',
          effectiveness: 'improved',
          effectiveness_detail: '8.2 -> 0.5 (93.9%)',
          linked_prd: 'PRD-001',
          linked_deployment: 'DEPLOY-001',
        }),
        makeObservation({
          id: 'OBS-002',
          effectiveness: 'degraded',
          effectiveness_detail: '2.1 -> 4.5 (-114.3%)',
          linked_prd: 'PRD-002',
          linked_deployment: 'DEPLOY-002',
        }),
        // Pending and null should be excluded
        makeObservation({ effectiveness: 'pending' }),
        makeObservation({ effectiveness: null }),
      ];

      const entries = collectEffectivenessResults(observations);

      expect(entries.length).toBe(2);
      expect(entries[0].observation_id).toBe('OBS-001');
      expect(entries[0].prd_id).toBe('PRD-001');
      expect(entries[0].pre_fix_summary).toBe('8.2');
      expect(entries[0].post_fix_summary).toBe('0.5');
      expect(entries[0].result).toBe('improved (93.9%)');

      expect(entries[1].observation_id).toBe('OBS-002');
      expect(entries[1].result).toBe('degraded (-114.3%)');
    });
  });

  // -------------------------------------------------------------------------
  // TC-5-3-13: Recurring patterns table
  // -------------------------------------------------------------------------
  describe('TC-5-3-13: recurring patterns table', () => {
    it('detects oscillating and monitoring patterns', () => {
      const observations = [
        // 3 error observations for api-gateway with oscillation_warning
        makeObservation({
          service: 'api-gateway', error_class: 'ConnectionTimeout',
          oscillation_warning: true,
        }),
        makeObservation({
          service: 'api-gateway', error_class: 'ConnectionTimeout',
          oscillation_warning: true,
        }),
        makeObservation({
          service: 'api-gateway', error_class: 'ConnectionTimeout',
          oscillation_warning: false,
        }),
        // 2 anomaly observations for auth-service (monitoring)
        makeObservation({
          service: 'auth-service', error_class: 'MemoryLeak',
          oscillation_warning: false,
        }),
        makeObservation({
          service: 'auth-service', error_class: 'MemoryLeak',
          oscillation_warning: false,
        }),
        // 1 solo observation (should not appear)
        makeObservation({
          service: 'data-pipeline', error_class: 'OneOff',
          oscillation_warning: false,
        }),
      ];

      const patterns = detectRecurringPatterns('', observations, new Date());

      expect(patterns.length).toBe(2);

      const oscillating = patterns.find((p) => p.pattern === 'ConnectionTimeout')!;
      expect(oscillating.service).toBe('api-gateway');
      expect(oscillating.occurrences_30d).toBe(3);
      expect(oscillating.status).toBe('OSCILLATING');

      const monitoring = patterns.find((p) => p.pattern === 'MemoryLeak')!;
      expect(monitoring.service).toBe('auth-service');
      expect(monitoring.occurrences_30d).toBe(2);
      expect(monitoring.status).toBe('Monitoring');
    });
  });

  // -------------------------------------------------------------------------
  // TC-5-3-14: Recommendation: oscillation
  // -------------------------------------------------------------------------
  describe('TC-5-3-14: recommendation: oscillation', () => {
    it('recommends architectural review for oscillating patterns', () => {
      const summary = computeSummaryMetrics(makeAppendixADataset());
      const recurring: RecurringPattern[] = [
        {
          pattern: 'ConnectionTimeoutError',
          service: 'api-gateway',
          occurrences_30d: 4,
          status: 'OSCILLATING',
        },
      ];

      const recs = generateRecommendations(summary, recurring);

      const oscRec = recs.find((r) => r.includes('architectural review'));
      expect(oscRec).toBeDefined();
      expect(oscRec).toContain('api-gateway');
      expect(oscRec).toContain('4 in 30d');
    });
  });

  // -------------------------------------------------------------------------
  // TC-5-3-15: Recommendation: low SNR
  // -------------------------------------------------------------------------
  describe('TC-5-3-15: recommendation: low SNR', () => {
    it('recommends tightening thresholds when SNR is below target', () => {
      const summary = computeSummaryMetrics(makeAppendixADataset());
      // Summary should have signal_to_noise_ratio ~35.7%
      expect(summary.signal_to_noise_ratio).not.toBeNull();
      expect(summary.signal_to_noise_ratio!).toBeLessThan(60);

      const recs = generateRecommendations(summary, []);

      const snrRec = recs.find((r) => r.includes('tightening P2/P3 thresholds'));
      expect(snrRec).toBeDefined();
      expect(snrRec).toContain('35.7%');
      expect(snrRec).toContain('60%');
    });
  });

  // -------------------------------------------------------------------------
  // TC-5-3-16: Digest file placement
  // -------------------------------------------------------------------------
  describe('TC-5-3-16: digest file placement', () => {
    it('writes digest to .autonomous-dev/observations/digests/DIGEST-2026W15.md', async () => {
      const result = await generateWeeklyDigest(
        tmpDir,
        '2026-W15',
        new Date('2026-04-12T23:00:00.000Z'),
      );

      expect(result.filePath).toBe(
        path.join(tmpDir, '.autonomous-dev', 'observations', 'digests', 'DIGEST-2026W15.md'),
      );
      expect(result.weekId).toBe('2026-W15');

      // Verify file exists
      const stat = await fs.stat(result.filePath);
      expect(stat.isFile()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // TC-5-3-17: Digest idempotency
  // -------------------------------------------------------------------------
  describe('TC-5-3-17: digest idempotency', () => {
    it('produces identical content when run twice for the same week', async () => {
      const now = new Date('2026-04-12T23:00:00.000Z');

      const result1 = await generateWeeklyDigest(tmpDir, '2026-W15', now);
      const content1 = await fs.readFile(result1.filePath, 'utf-8');

      const result2 = await generateWeeklyDigest(tmpDir, '2026-W15', now);
      const content2 = await fs.readFile(result2.filePath, 'utf-8');

      expect(result1.filePath).toBe(result2.filePath);
      expect(content1).toBe(content2);
    });
  });

  // -------------------------------------------------------------------------
  // TC-5-3-18: Digest YAML frontmatter
  // -------------------------------------------------------------------------
  describe('TC-5-3-18: digest YAML frontmatter', () => {
    it('contains required frontmatter fields', async () => {
      const now = new Date('2026-04-12T23:00:00.000Z');
      const result = await generateWeeklyDigest(tmpDir, '2026-W15', now);
      const content = await fs.readFile(result.filePath, 'utf-8');

      expect(content).toMatch(/^---\n/);
      expect(content).toContain('type: digest');
      expect(content).toContain('week: "2026-W15"');
      expect(content).toContain('period:');
      expect(content).toContain('generated_at:');
      expect(content).toContain(now.toISOString());
    });
  });

  // -------------------------------------------------------------------------
  // TC-5-3-19: ISO week computation
  // -------------------------------------------------------------------------
  describe('TC-5-3-19: ISO week computation', () => {
    it('computes 2026-W15 for 2026-04-08', () => {
      const result = computeIsoWeek(new Date('2026-04-08'));
      expect(result).toBe('2026-W15');
    });

    it('handles year boundaries correctly', () => {
      // Jan 1, 2026 is a Thursday -> W01
      expect(computeIsoWeek(new Date('2026-01-01'))).toBe('2026-W01');

      // Dec 31, 2025 is a Wednesday -> should be W01 of 2026
      // (ISO week: if Dec 31 falls on Wed, it's week 1 of next year only if
      //  the nearest Thursday is in the new year)
      // Actually Dec 31, 2025 (Wednesday): nearest Thursday is Jan 1, 2026
      expect(computeIsoWeek(new Date('2025-12-31'))).toBe('2026-W01');
    });

    it('computes correct week for various dates', () => {
      // Monday of W15 2026 is April 6
      expect(computeIsoWeek(new Date('2026-04-06'))).toBe('2026-W15');
      // Sunday of W15 2026 is April 12
      expect(computeIsoWeek(new Date('2026-04-12'))).toBe('2026-W15');
    });
  });

  // -------------------------------------------------------------------------
  // TC-5-3-20: Week bounds
  // -------------------------------------------------------------------------
  describe('TC-5-3-20: week bounds', () => {
    it('computes correct Monday and Sunday for 2026-W15', () => {
      const { start, end } = computeWeekBounds('2026-W15');

      // Monday 2026-04-06
      expect(start.getFullYear()).toBe(2026);
      expect(start.getMonth()).toBe(3); // April (0-indexed)
      expect(start.getDate()).toBe(6);
      expect(start.getHours()).toBe(0);
      expect(start.getMinutes()).toBe(0);
      expect(start.getSeconds()).toBe(0);

      // Sunday 2026-04-12
      expect(end.getFullYear()).toBe(2026);
      expect(end.getMonth()).toBe(3);
      expect(end.getDate()).toBe(12);
      expect(end.getHours()).toBe(23);
      expect(end.getMinutes()).toBe(59);
      expect(end.getSeconds()).toBe(59);
    });

    it('throws on invalid week ID format', () => {
      expect(() => computeWeekBounds('2026-15')).toThrow('Invalid week ID');
      expect(() => computeWeekBounds('invalid')).toThrow('Invalid week ID');
    });
  });

  // -------------------------------------------------------------------------
  // TC-5-3-21: Empty week
  // -------------------------------------------------------------------------
  describe('TC-5-3-21: empty week', () => {
    it('generates digest with all zeros and no recommendations', async () => {
      const now = new Date('2026-04-12T23:00:00.000Z');
      const result = await generateWeeklyDigest(tmpDir, '2026-W15', now);

      expect(result.summary.total_observations).toBe(0);
      expect(result.summary.avg_tokens_per_run).toBe(0);
      expect(result.summary.signal_to_noise_ratio).toBeNull();
      expect(result.summary.signal_to_noise_display).toBe('N/A (<5 observations)');

      const content = await fs.readFile(result.filePath, 'utf-8');
      expect(content).toContain('No effectiveness results this period.');
      expect(content).toContain('No recurring patterns detected.');
      expect(content).toContain('No recommendations this period.');
    });
  });

  // -------------------------------------------------------------------------
  // Full digest with observations on disk
  // -------------------------------------------------------------------------
  describe('full digest with observations on disk', () => {
    it('collects observations from directory and generates complete digest', async () => {
      // Write observations in the W15 period (April 6-12, 2026)
      await writeObservationFile(tmpDir, makeObservation({
        id: 'OBS-20260408-100000-d001',
        timestamp: '2026-04-08T10:00:00.000Z',
        service: 'api-gateway',
        severity: 'P1',
        triage_decision: 'promote',
      }));
      await writeObservationFile(tmpDir, makeObservation({
        id: 'OBS-20260409-100000-d002',
        timestamp: '2026-04-09T10:00:00.000Z',
        service: 'auth-service',
        severity: 'P2',
        triage_decision: 'dismiss',
      }));

      // Write an observation OUTSIDE the period (should not be included)
      await writeObservationFile(tmpDir, makeObservation({
        id: 'OBS-20260401-100000-d003',
        timestamp: '2026-04-01T10:00:00.000Z',
        service: 'api-gateway',
        severity: 'P0',
        triage_decision: 'promote',
      }));

      const now = new Date('2026-04-12T23:00:00.000Z');
      const result = await generateWeeklyDigest(tmpDir, '2026-W15', now);

      // Should only include observations in the W15 period
      expect(result.summary.total_observations).toBe(2);

      const content = await fs.readFile(result.filePath, 'utf-8');
      expect(content).toContain('# Production Intelligence Weekly Digest -- 2026-W15');
      expect(content).toContain('api-gateway');
      expect(content).toContain('auth-service');
    });
  });

  // -------------------------------------------------------------------------
  // Formatting helpers
  // -------------------------------------------------------------------------
  describe('formatting helpers', () => {
    it('formatDate returns YYYY-MM-DD', () => {
      expect(formatDate(new Date('2026-04-08T14:30:00Z'))).toBe('2026-04-08');
    });

    it('formatSeverityCounts formats all severity levels', () => {
      expect(formatSeverityCounts({ P0: 1, P1: 3, P2: 7, P3: 3 }))
        .toBe('P0: 1, P1: 3, P2: 7, P3: 3');
    });

    it('formatTypeCounts sorts by count descending', () => {
      const result = formatTypeCounts({ error: 8, anomaly: 4, trend: 2 });
      expect(result).toBe('error: 8, anomaly: 4, trend: 2');
    });

    it('formatTriageCounts omits zero-count decisions', () => {
      expect(formatTriageCounts({ promote: 4, dismiss: 5, defer: 0, investigate: 1, pending: 2 }))
        .toBe('promote: 4, dismiss: 5, investigate: 1, pending: 2');
    });

    it('formatLatency returns hours or N/A', () => {
      expect(formatLatency(2.1)).toBe('2.1h');
      expect(formatLatency(null)).toBe('N/A');
    });
  });

  // -------------------------------------------------------------------------
  // Render digest
  // -------------------------------------------------------------------------
  describe('renderDigest', () => {
    it('produces all required sections', () => {
      const summary: DigestSummary = {
        total_observations: 14,
        by_severity: { P0: 1, P1: 3, P2: 7, P3: 3 },
        by_type: { error: 8, anomaly: 4, trend: 2 },
        triage_decisions: { promote: 4, dismiss: 5, defer: 2, investigate: 1, pending: 2 },
        signal_to_noise_ratio: 35.7,
        signal_to_noise_display: '(4+1) / 14 = 35.7%',
        avg_triage_latency_p0p1_hours: 2.1,
        avg_triage_latency_p2p3_hours: 18.4,
        avg_tokens_per_run: 38200,
      };

      const content = renderDigest(
        '2026-W15',
        new Date('2026-04-06T00:00:00Z'),
        new Date('2026-04-12T23:59:59Z'),
        new Date('2026-04-12T23:00:00Z'),
        {
          summary,
          byService: [
            { service: 'api-gateway', total_observations: 8, p0_p1_count: 3, promoted: 3, dismissed: 3 },
            { service: 'auth-service', total_observations: 4, p0_p1_count: 1, promoted: 1, dismissed: 2 },
            { service: 'data-pipeline', total_observations: 2, p0_p1_count: 0, promoted: 0, dismissed: 0 },
          ],
          effectiveness: [],
          recurring: [],
          recommendations: ['Test recommendation.'],
        },
      );

      expect(content).toContain('## Summary');
      expect(content).toContain('## Observations by Service');
      expect(content).toContain('## Effectiveness Tracking');
      expect(content).toContain('## Recurring Patterns');
      expect(content).toContain('## Recommendations');
      expect(content).toContain('Test recommendation.');
      expect(content).toContain('38,200');
    });
  });

  // -------------------------------------------------------------------------
  // Recommendation: high P0 count
  // -------------------------------------------------------------------------
  describe('recommendation: high P0 count', () => {
    it('recommends incident review when P0 count > 3', () => {
      const summary: DigestSummary = {
        total_observations: 10,
        by_severity: { P0: 4, P1: 2, P2: 3, P3: 1 },
        by_type: { error: 10 },
        triage_decisions: { promote: 5, dismiss: 3, defer: 0, investigate: 0, pending: 2 },
        signal_to_noise_ratio: 50.0,
        signal_to_noise_display: '(5+0) / 10 = 50.0%',
        avg_triage_latency_p0p1_hours: 2.0,
        avg_triage_latency_p2p3_hours: null,
        avg_tokens_per_run: 30000,
      };

      const recs = generateRecommendations(summary, []);
      const p0Rec = recs.find((r) => r.includes('incident review'));
      expect(p0Rec).toBeDefined();
      expect(p0Rec).toContain('4');
    });
  });

  // -------------------------------------------------------------------------
  // Recommendation: slow triage latency
  // -------------------------------------------------------------------------
  describe('recommendation: slow triage latency', () => {
    it('recommends faster triage when P0/P1 latency > 4h', () => {
      const summary: DigestSummary = {
        total_observations: 10,
        by_severity: { P0: 1, P1: 2, P2: 5, P3: 2 },
        by_type: { error: 10 },
        triage_decisions: { promote: 5, dismiss: 3, defer: 0, investigate: 0, pending: 2 },
        signal_to_noise_ratio: 50.0,
        signal_to_noise_display: '(5+0) / 10 = 50.0%',
        avg_triage_latency_p0p1_hours: 5.5,
        avg_triage_latency_p2p3_hours: 20.0,
        avg_tokens_per_run: 30000,
      };

      const recs = generateRecommendations(summary, []);
      const latRec = recs.find((r) => r.includes('triage latency'));
      expect(latRec).toBeDefined();
      expect(latRec).toContain('5.5h');
      expect(latRec).toContain('4h target');
    });
  });
});
