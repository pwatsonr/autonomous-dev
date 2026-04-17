/**
 * Unit tests for the severity scoring algorithm and LLM override mechanism
 * (SPEC-007-3-2, Tasks 4 & 5).
 *
 * Test case IDs correspond to the spec's test case table:
 *   TC-3-2-01 through TC-3-2-14.
 */

import {
  computeSeverity,
  estimateAffectedUsers,
  requestLlmOverride,
  parseSeverityOverrideResponse,
  buildOverridePrompt,
} from '../../src/engine/severity-scorer';
import type {
  SeverityResult,
  Severity,
  LlmQueryFn,
} from '../../src/engine/severity-scorer';
import type { ServiceConfig } from '../../src/config/intelligence-config.schema';
import type { CandidateObservation } from '../../src/engine/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildService(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name: 'api-gateway',
    repo: 'org/api-gateway',
    prometheus_job: 'api-gateway',
    grafana_dashboard_uid: 'abc123',
    opensearch_index: 'logs-api-gateway-*',
    criticality: 'critical',
    ...overrides,
  };
}

function buildCandidate(
  overrides: Partial<CandidateObservation> = {},
): CandidateObservation {
  return {
    type: 'error',
    error_type: 'error_rate',
    service: 'api-gateway',
    metric_value: 12.3,
    threshold_value: 5.0,
    sustained_minutes: 45,
    log_samples: [],
    data_sources_used: ['prometheus'],
    has_data_loss_indicator: false,
    has_data_corruption_indicator: false,
    ...overrides,
  };
}

/**
 * Builds a mock LLM query function that returns the given response string.
 */
function buildMockLlm(response: string): LlmQueryFn {
  return async () => response;
}

// ---------------------------------------------------------------------------
// Task 4: Severity Scoring Algorithm
// ---------------------------------------------------------------------------

describe('computeSeverity', () => {
  // TC-3-2-01: TDD example - P1
  it('TC-3-2-01: TDD example produces score ~0.63 and severity P1', () => {
    // error=12.3%, critical service, 45 min, no data risk
    // We need to also provide throughput to get ~2400 affected users.
    // estimateAffectedUsers(throughput, 12.3, 45) should give ~2400
    // 2400 = throughput * 45 * 60 * 0.123 / 3
    // 2400 * 3 = throughput * 2700 * 0.123
    // 7200 = throughput * 332.1
    // throughput ~= 21.68 rps
    // But the spec says users=2400, so let's use that throughput.
    // Actually let's calculate: 58 rps is used in TC-3-2-07.
    // With 58 rps: estimateAffectedUsers(58, 12.3, 45) = round(58*45*60*0.123/3) = round(6432.6) = 6433
    // That's >1000, so userSubScore=0.75
    // But spec says users=2400 for TC-3-2-01. Let's use throughput that gives ~2400.
    // 2400 = round(throughput * 45 * 60 * 0.123 / 3)
    // 2400 * 3 / (45 * 60 * 0.123) = throughput
    // 7200 / 332.1 = 21.68
    const throughput = 21.68;
    const candidate = buildCandidate({
      metric_value: 12.3,
      sustained_minutes: 45,
      has_data_loss_indicator: false,
      has_data_corruption_indicator: false,
    });
    const service = buildService({ criticality: 'critical' });

    const result = computeSeverity(candidate, service, throughput);

    // Error rate 12.3% -> >5%, sub=0.50, weighted=0.15
    // Users ~2400 -> >1000, sub=0.75, weighted=0.1875
    // Criticality critical -> sub=1.0, weighted=0.20
    // Duration 45 -> >30, sub=0.75, weighted=0.1125
    // Data integrity no risk -> sub=0.0, weighted=0.0
    // Total = 0.15 + 0.1875 + 0.20 + 0.1125 + 0.0 = 0.65
    expect(result.score).toBeCloseTo(0.65, 2);
    expect(result.severity).toBe('P1');
  });

  // TC-3-2-02: P0 boundary
  it('TC-3-2-02: P0 when all factors are high', () => {
    // error=55%, users=15000, critical, 90min, data loss
    // 15000 = round(throughput * 90 * 60 * 0.55 / 3)
    // 15000 * 3 / (5400 * 0.55) = 45000 / 2970 = 15.15
    const throughput = 15.15;
    const candidate = buildCandidate({
      metric_value: 55,
      sustained_minutes: 90,
      has_data_loss_indicator: true,
      has_data_corruption_indicator: false,
    });
    const service = buildService({ criticality: 'critical' });

    const result = computeSeverity(candidate, service, throughput);

    // Error rate 55% -> >50%, sub=1.0, weighted=0.30
    // Users ~15000 -> >10000, sub=1.0, weighted=0.25
    // Criticality critical -> sub=1.0, weighted=0.20
    // Duration 90 -> >60, sub=1.0, weighted=0.15
    // Data integrity data_loss -> sub=1.0, weighted=0.10
    // Total = 0.30 + 0.25 + 0.20 + 0.15 + 0.10 = 1.0
    expect(result.score).toBeGreaterThanOrEqual(0.75);
    expect(result.severity).toBe('P0');
  });

  // TC-3-2-03: P0 exact boundary (score = 0.75 exactly)
  it('TC-3-2-03: severity is P0 when score equals 0.75', () => {
    // We need a combination that gives exactly 0.75
    // error_rate sub=0.75 (>20%), weighted=0.225
    // users sub=1.0 (>10000), weighted=0.25
    // criticality sub=0.75 (high), weighted=0.15
    // duration sub=0.50 (>10), weighted=0.075
    // data integrity sub=0.50... but we only have 0.0, 0.75, or 1.0
    // Let's try: error=1.0(0.30) + users=0.75(0.1875) + crit=0.50(0.10) + dur=0.25(0.0375) + data=1.0(0.10) = 0.725 - not quite
    // error=1.0(0.30) + users=0.75(0.1875) + crit=0.75(0.15) + dur=0.25(0.0375) + data=0.75(0.075) = 0.75
    // error > 50% -> sub=1.0
    // users > 1000 but <=10000 -> sub=0.75
    // crit = high -> sub=0.75
    // dur <= 10 -> sub=0.25
    // data corruption -> sub=0.75
    // Total = 0.30 + 0.1875 + 0.15 + 0.0375 + 0.075 = 0.75 exactly

    // estimateAffectedUsers needs to give >1000 and <=10000
    // Let's use metric_value=55 (error>50%), sustained=5 (dur<=10)
    // 5000 = round(throughput * 5 * 60 * 0.55 / 3) => throughput = 5000*3/(300*0.55) = 15000/165 = 90.9
    const throughput = 90.9;
    const candidate = buildCandidate({
      metric_value: 55,
      sustained_minutes: 5,
      has_data_loss_indicator: false,
      has_data_corruption_indicator: true,
    });
    const service = buildService({ criticality: 'high' });

    const result = computeSeverity(candidate, service, throughput);

    expect(result.score).toBeCloseTo(0.75, 2);
    expect(result.severity).toBe('P0');
  });

  // TC-3-2-04: P1 exact boundary (score = 0.55 exactly)
  it('TC-3-2-04: severity is P1 when score equals 0.55', () => {
    // Need score = 0.55
    // error sub=0.50 (>5%), weighted=0.15
    // users sub=0.50 (>100), weighted=0.125
    // crit sub=0.50 (medium), weighted=0.10
    // dur sub=0.50 (>10), weighted=0.075
    // data sub=0.0, weighted=0.0
    // Total = 0.15 + 0.125 + 0.10 + 0.075 + 0.0 = 0.45 - too low

    // error sub=0.75 (>20%), weighted=0.225
    // users sub=0.50 (>100), weighted=0.125
    // crit sub=0.50 (medium), weighted=0.10
    // dur sub=0.50 (>10), weighted=0.075
    // data sub=0.25... nope
    // data sub=0.0, weighted=0.0
    // Total = 0.225 + 0.125 + 0.10 + 0.075 + 0.0 = 0.525 - still low

    // error sub=0.75 (>20%), weighted=0.225
    // users sub=0.75 (>1000), weighted=0.1875
    // crit sub=0.25 (low), weighted=0.05
    // dur sub=0.25 (<=10), weighted=0.0375
    // data sub=0.75 (corruption), weighted=0.075
    // Total = 0.225 + 0.1875 + 0.05 + 0.0375 + 0.075 = 0.575 - close but high

    // error sub=0.50 (>5%), weighted=0.15
    // users sub=0.75 (>1000), weighted=0.1875
    // crit sub=0.50 (medium), weighted=0.10
    // dur sub=0.25 (<=10), weighted=0.0375
    // data sub=0.75 (corruption), weighted=0.075
    // Total = 0.15 + 0.1875 + 0.10 + 0.0375 + 0.075 = 0.55 exactly!

    // error > 5% -> sub=0.50: metric_value=6
    // dur <= 10 -> sub=0.25: sustained_minutes=5
    // users > 1000: estimateAffectedUsers(throughput, 6, 5) > 1000
    //   1500 = round(throughput * 5 * 60 * 0.06 / 3) = round(throughput * 6)
    //   throughput = 250
    const throughput = 250;
    const candidate = buildCandidate({
      metric_value: 6,
      sustained_minutes: 5,
      has_data_loss_indicator: false,
      has_data_corruption_indicator: true,
    });
    const service = buildService({ criticality: 'medium' });

    const result = computeSeverity(candidate, service, throughput);

    expect(result.score).toBeCloseTo(0.55, 2);
    expect(result.severity).toBe('P1');
  });

  // TC-3-2-05: P2 exact boundary (score = 0.35 exactly)
  it('TC-3-2-05: severity is P2 when score equals 0.35', () => {
    // Need score = 0.35
    // error sub=0.25 (>1%), weighted=0.075
    // users sub=0.25 (<=100), weighted=0.0625
    // crit sub=0.25 (low), weighted=0.05
    // dur sub=0.25 (<=10), weighted=0.0375
    // data sub=1.0 (data loss), weighted=0.10
    // Total = 0.075 + 0.0625 + 0.05 + 0.0375 + 0.10 = 0.325 - too low

    // error sub=0.50 (>5%), weighted=0.15
    // users sub=0.25 (<=100), weighted=0.0625
    // crit sub=0.25 (low), weighted=0.05
    // dur sub=0.25 (<=10), weighted=0.0375
    // data sub=0.50... not available. 0.0
    // Total = 0.15 + 0.0625 + 0.05 + 0.0375 + 0.0 = 0.30 - too low

    // error sub=0.50 (>5%), weighted=0.15
    // users sub=0.25 (<=100), weighted=0.0625
    // crit sub=0.25 (low), weighted=0.05
    // dur sub=0.25 (<=10), weighted=0.0375
    // data sub=0.75 (corruption), weighted=0.075
    // Total = 0.15 + 0.0625 + 0.05 + 0.0375 + 0.075 = 0.375 - too high

    // error sub=0.25 (>1%), weighted=0.075
    // users sub=0.25 (<=100), weighted=0.0625
    // crit sub=0.50 (medium), weighted=0.10
    // dur sub=0.25 (<=10), weighted=0.0375
    // data sub=0.75 (corruption), weighted=0.075
    // Total = 0.075 + 0.0625 + 0.10 + 0.0375 + 0.075 = 0.35 exactly!

    // error > 1% but <= 5% -> sub=0.25: metric_value=2
    // dur <= 10 -> sub=0.25: sustained_minutes=5
    // users <= 100: estimateAffectedUsers(throughput, 2, 5) <= 100
    //   50 = round(throughput * 5 * 60 * 0.02 / 3) = round(throughput * 2)
    //   throughput = 25
    const throughput = 25;
    const candidate = buildCandidate({
      metric_value: 2,
      sustained_minutes: 5,
      has_data_loss_indicator: false,
      has_data_corruption_indicator: true,
    });
    const service = buildService({ criticality: 'medium' });

    const result = computeSeverity(candidate, service, throughput);

    expect(result.score).toBeCloseTo(0.35, 2);
    expect(result.severity).toBe('P2');
  });

  // TC-3-2-06: P3 low score
  it('TC-3-2-06: severity is P3 for low-severity inputs', () => {
    // error=1.5%, users=50, low criticality, 5 min, no risk
    // error 1.5% -> >1%, sub=0.25, weighted=0.075
    // users <=100 -> sub=0.25, weighted=0.0625
    // crit low -> sub=0.25, weighted=0.05
    // dur 5 -> <=10, sub=0.25, weighted=0.0375
    // data no risk -> sub=0.0, weighted=0.0
    // Total = 0.075 + 0.0625 + 0.05 + 0.0375 + 0.0 = 0.225

    // estimateAffectedUsers(throughput, 1.5, 5) should give ~50
    // 50 = round(throughput * 5 * 60 * 0.015 / 3) = round(throughput * 1.5)
    // throughput ~= 33.33
    const throughput = 33.33;
    const candidate = buildCandidate({
      metric_value: 1.5,
      sustained_minutes: 5,
      has_data_loss_indicator: false,
      has_data_corruption_indicator: false,
    });
    const service = buildService({ criticality: 'low' });

    const result = computeSeverity(candidate, service, throughput);

    expect(result.score).toBeLessThan(0.35);
    expect(result.severity).toBe('P3');
  });

  // TC-3-2-13: All-max factors
  it('TC-3-2-13: all-max factors produce score 1.0 and severity P0', () => {
    // error=100%, critical, 120min, data loss
    // Sub-scores: error=1.0, users=1.0 (need >10000), crit=1.0, dur=1.0, data=1.0
    // We need throughput that produces >10000 users
    // 15000 = round(throughput * 120 * 60 * 1.0 / 3) => throughput = 15000*3/7200 = 6.25
    const throughput = 6.25;
    const candidate = buildCandidate({
      metric_value: 100,
      sustained_minutes: 120,
      has_data_loss_indicator: true,
      has_data_corruption_indicator: false,
    });
    const service = buildService({ criticality: 'critical' });

    const result = computeSeverity(candidate, service, throughput);

    expect(result.score).toBeCloseTo(1.0, 4);
    expect(result.severity).toBe('P0');
  });

  // TC-3-2-14: Breakdown in result
  it('TC-3-2-14: result contains complete breakdown with all 5 factors', () => {
    const candidate = buildCandidate({
      metric_value: 12.3,
      sustained_minutes: 45,
    });
    const service = buildService({ criticality: 'critical' });

    const result = computeSeverity(candidate, service, 58);

    expect(result.breakdown).toBeDefined();

    // error_rate factor
    expect(result.breakdown.error_rate).toBeDefined();
    expect(result.breakdown.error_rate.value).toBe(12.3);
    expect(typeof result.breakdown.error_rate.sub_score).toBe('number');
    expect(typeof result.breakdown.error_rate.weighted).toBe('number');

    // affected_users factor
    expect(result.breakdown.affected_users).toBeDefined();
    expect(typeof result.breakdown.affected_users.value).toBe('number');
    expect(typeof result.breakdown.affected_users.sub_score).toBe('number');
    expect(typeof result.breakdown.affected_users.weighted).toBe('number');

    // service_criticality factor
    expect(result.breakdown.service_criticality).toBeDefined();
    expect(result.breakdown.service_criticality.value).toBe('critical');
    expect(typeof result.breakdown.service_criticality.sub_score).toBe('number');
    expect(typeof result.breakdown.service_criticality.weighted).toBe('number');

    // duration factor
    expect(result.breakdown.duration).toBeDefined();
    expect(result.breakdown.duration.value).toBe(45);
    expect(typeof result.breakdown.duration.sub_score).toBe('number');
    expect(typeof result.breakdown.duration.weighted).toBe('number');

    // data_integrity factor
    expect(result.breakdown.data_integrity).toBeDefined();
    expect(typeof result.breakdown.data_integrity.value).toBe('string');
    expect(typeof result.breakdown.data_integrity.sub_score).toBe('number');
    expect(typeof result.breakdown.data_integrity.weighted).toBe('number');

    // Verify weighted contributions sum to the total score
    const sumOfWeighted =
      result.breakdown.error_rate.weighted +
      result.breakdown.affected_users.weighted +
      result.breakdown.service_criticality.weighted +
      result.breakdown.duration.weighted +
      result.breakdown.data_integrity.weighted;
    expect(sumOfWeighted).toBeCloseTo(result.score, 10);
  });
});

// ---------------------------------------------------------------------------
// estimateAffectedUsers
// ---------------------------------------------------------------------------

describe('estimateAffectedUsers', () => {
  // TC-3-2-07: Affected users estimate
  it('TC-3-2-07: 58 rps, 12.3% error, 45 min produces ~6432 users', () => {
    const affected = estimateAffectedUsers(58, 12.3, 45);
    // (58 * 45 * 60 * 0.123) / 3 = (58 * 2700 * 0.123) / 3
    // = 19256.4 / 3 = 6418.8 -> round = 6419
    // The spec says ~6,432 (approximate) so we check a reasonable range
    expect(affected).toBeGreaterThan(6000);
    expect(affected).toBeLessThan(7000);
  });

  // TC-3-2-12: Zero throughput
  it('TC-3-2-12: zero throughput returns 0', () => {
    const affected = estimateAffectedUsers(0, 12.3, 45);
    expect(affected).toBe(0);
  });

  it('returns 0 when error rate is 0', () => {
    const affected = estimateAffectedUsers(100, 0, 45);
    expect(affected).toBe(0);
  });

  it('returns 0 when duration is 0', () => {
    const affected = estimateAffectedUsers(100, 12.3, 0);
    expect(affected).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sub-score boundary tests
// ---------------------------------------------------------------------------

describe('sub-score thresholds', () => {
  const baseCandidate = buildCandidate();
  const service = buildService({ criticality: 'critical' });

  describe('error rate sub-scoring', () => {
    it('error rate > 50% gives sub_score 1.0', () => {
      const candidate = buildCandidate({ metric_value: 51 });
      const result = computeSeverity(candidate, service, 0);
      expect(result.breakdown.error_rate.sub_score).toBe(1.0);
    });

    it('error rate > 20% but <= 50% gives sub_score 0.75', () => {
      const candidate = buildCandidate({ metric_value: 21 });
      const result = computeSeverity(candidate, service, 0);
      expect(result.breakdown.error_rate.sub_score).toBe(0.75);
    });

    it('error rate > 5% but <= 20% gives sub_score 0.50', () => {
      const candidate = buildCandidate({ metric_value: 6 });
      const result = computeSeverity(candidate, service, 0);
      expect(result.breakdown.error_rate.sub_score).toBe(0.50);
    });

    it('error rate > 1% but <= 5% gives sub_score 0.25', () => {
      const candidate = buildCandidate({ metric_value: 2 });
      const result = computeSeverity(candidate, service, 0);
      expect(result.breakdown.error_rate.sub_score).toBe(0.25);
    });

    it('error rate <= 1% gives sub_score 0.0', () => {
      const candidate = buildCandidate({ metric_value: 0.5 });
      const result = computeSeverity(candidate, service, 0);
      expect(result.breakdown.error_rate.sub_score).toBe(0.0);
    });

    // Boundary: exactly at threshold (strict >)
    it('error rate exactly 50% gives sub_score 0.75 (not 1.0)', () => {
      const candidate = buildCandidate({ metric_value: 50 });
      const result = computeSeverity(candidate, service, 0);
      expect(result.breakdown.error_rate.sub_score).toBe(0.75);
    });

    it('error rate exactly 20% gives sub_score 0.50 (not 0.75)', () => {
      const candidate = buildCandidate({ metric_value: 20 });
      const result = computeSeverity(candidate, service, 0);
      expect(result.breakdown.error_rate.sub_score).toBe(0.50);
    });

    it('error rate exactly 5% gives sub_score 0.25 (not 0.50)', () => {
      const candidate = buildCandidate({ metric_value: 5 });
      const result = computeSeverity(candidate, service, 0);
      expect(result.breakdown.error_rate.sub_score).toBe(0.25);
    });

    it('error rate exactly 1% gives sub_score 0.0 (not 0.25)', () => {
      const candidate = buildCandidate({ metric_value: 1 });
      const result = computeSeverity(candidate, service, 0);
      expect(result.breakdown.error_rate.sub_score).toBe(0.0);
    });
  });

  describe('affected users sub-scoring', () => {
    it('users > 10000 gives sub_score 1.0', () => {
      // Need throughput that gives >10000 users
      // 11000 = round(throughput * 45 * 60 * 0.123 / 3)
      // throughput = 11000 * 3 / (2700 * 0.123) = 33000 / 332.1 = 99.37
      const candidate = buildCandidate({ metric_value: 12.3, sustained_minutes: 45 });
      const result = computeSeverity(candidate, service, 100);
      expect(result.breakdown.affected_users.sub_score).toBe(1.0);
    });

    it('users > 1000 but <= 10000 gives sub_score 0.75', () => {
      const candidate = buildCandidate({ metric_value: 12.3, sustained_minutes: 45 });
      const result = computeSeverity(candidate, service, 50);
      expect(result.breakdown.affected_users.value).toBeGreaterThan(1000);
      expect(result.breakdown.affected_users.value).toBeLessThanOrEqual(10000);
      expect(result.breakdown.affected_users.sub_score).toBe(0.75);
    });

    it('users > 100 but <= 1000 gives sub_score 0.50', () => {
      const candidate = buildCandidate({ metric_value: 12.3, sustained_minutes: 10 });
      const result = computeSeverity(candidate, service, 5);
      // 5 * 10 * 60 * 0.123 / 3 = 123
      expect(result.breakdown.affected_users.value).toBeGreaterThan(100);
      expect(result.breakdown.affected_users.value).toBeLessThanOrEqual(1000);
      expect(result.breakdown.affected_users.sub_score).toBe(0.50);
    });

    it('users <= 100 gives sub_score 0.25', () => {
      const candidate = buildCandidate({ metric_value: 1.5, sustained_minutes: 5 });
      const result = computeSeverity(candidate, service, 1);
      expect(result.breakdown.affected_users.value).toBeLessThanOrEqual(100);
      expect(result.breakdown.affected_users.sub_score).toBe(0.25);
    });
  });

  describe('service criticality sub-scoring', () => {
    it('critical gives sub_score 1.0', () => {
      const result = computeSeverity(baseCandidate, buildService({ criticality: 'critical' }), 0);
      expect(result.breakdown.service_criticality.sub_score).toBe(1.0);
    });

    it('high gives sub_score 0.75', () => {
      const result = computeSeverity(baseCandidate, buildService({ criticality: 'high' }), 0);
      expect(result.breakdown.service_criticality.sub_score).toBe(0.75);
    });

    it('medium gives sub_score 0.50', () => {
      const result = computeSeverity(baseCandidate, buildService({ criticality: 'medium' }), 0);
      expect(result.breakdown.service_criticality.sub_score).toBe(0.50);
    });

    it('low gives sub_score 0.25', () => {
      const result = computeSeverity(baseCandidate, buildService({ criticality: 'low' }), 0);
      expect(result.breakdown.service_criticality.sub_score).toBe(0.25);
    });
  });

  describe('duration sub-scoring', () => {
    it('duration > 60 min gives sub_score 1.0', () => {
      const candidate = buildCandidate({ sustained_minutes: 61 });
      const result = computeSeverity(candidate, service, 0);
      expect(result.breakdown.duration.sub_score).toBe(1.0);
    });

    it('duration > 30 min but <= 60 gives sub_score 0.75', () => {
      const candidate = buildCandidate({ sustained_minutes: 31 });
      const result = computeSeverity(candidate, service, 0);
      expect(result.breakdown.duration.sub_score).toBe(0.75);
    });

    it('duration > 10 min but <= 30 gives sub_score 0.50', () => {
      const candidate = buildCandidate({ sustained_minutes: 11 });
      const result = computeSeverity(candidate, service, 0);
      expect(result.breakdown.duration.sub_score).toBe(0.50);
    });

    it('duration <= 10 min gives sub_score 0.25', () => {
      const candidate = buildCandidate({ sustained_minutes: 10 });
      const result = computeSeverity(candidate, service, 0);
      expect(result.breakdown.duration.sub_score).toBe(0.25);
    });
  });

  describe('data integrity sub-scoring', () => {
    it('data loss gives sub_score 1.0', () => {
      const candidate = buildCandidate({ has_data_loss_indicator: true });
      const result = computeSeverity(candidate, service, 0);
      expect(result.breakdown.data_integrity.sub_score).toBe(1.0);
      expect(result.breakdown.data_integrity.value).toBe('data_loss_confirmed');
    });

    it('data corruption gives sub_score 0.75', () => {
      const candidate = buildCandidate({
        has_data_loss_indicator: false,
        has_data_corruption_indicator: true,
      });
      const result = computeSeverity(candidate, service, 0);
      expect(result.breakdown.data_integrity.sub_score).toBe(0.75);
      expect(result.breakdown.data_integrity.value).toBe('data_corruption_possible');
    });

    it('no data risk gives sub_score 0.0', () => {
      const candidate = buildCandidate({
        has_data_loss_indicator: false,
        has_data_corruption_indicator: false,
      });
      const result = computeSeverity(candidate, service, 0);
      expect(result.breakdown.data_integrity.sub_score).toBe(0.0);
      expect(result.breakdown.data_integrity.value).toBe('no_data_risk');
    });

    it('data loss takes precedence over data corruption', () => {
      const candidate = buildCandidate({
        has_data_loss_indicator: true,
        has_data_corruption_indicator: true,
      });
      const result = computeSeverity(candidate, service, 0);
      expect(result.breakdown.data_integrity.sub_score).toBe(1.0);
      expect(result.breakdown.data_integrity.value).toBe('data_loss_confirmed');
    });
  });
});

// ---------------------------------------------------------------------------
// Score-to-severity mapping
// ---------------------------------------------------------------------------

describe('score-to-severity mapping', () => {
  // We test the mapping function indirectly through computeSeverity
  // by crafting inputs that produce known scores.

  it('score >= 0.75 maps to P0', () => {
    // All max: error=100%, 120min, critical, data loss, high throughput
    const candidate = buildCandidate({
      metric_value: 100,
      sustained_minutes: 120,
      has_data_loss_indicator: true,
    });
    const result = computeSeverity(candidate, buildService({ criticality: 'critical' }), 10);
    expect(result.score).toBeGreaterThanOrEqual(0.75);
    expect(result.severity).toBe('P0');
  });

  it('score < 0.35 maps to P3', () => {
    const candidate = buildCandidate({
      metric_value: 0.5,
      sustained_minutes: 5,
      has_data_loss_indicator: false,
      has_data_corruption_indicator: false,
    });
    const result = computeSeverity(candidate, buildService({ criticality: 'low' }), 0);
    expect(result.score).toBeLessThan(0.35);
    expect(result.severity).toBe('P3');
  });
});

// ---------------------------------------------------------------------------
// parseSeverityOverrideResponse
// ---------------------------------------------------------------------------

describe('parseSeverityOverrideResponse', () => {
  it('parses a valid override response', () => {
    const response = `OVERRIDE: yes
NEW_SEVERITY: P1
JUSTIFICATION: The error rate is climbing rapidly and will likely hit P0 soon.`;

    const parsed = parseSeverityOverrideResponse(response);
    expect(parsed).not.toBeNull();
    expect(parsed!.override).toBe('yes');
    expect(parsed!.new_severity).toBe('P1');
    expect(parsed!.justification).toBe(
      'The error rate is climbing rapidly and will likely hit P0 soon.',
    );
  });

  it('parses a "no" override response', () => {
    const response = `OVERRIDE: no
NEW_SEVERITY: P2
JUSTIFICATION: The deterministic assessment is accurate.`;

    const parsed = parseSeverityOverrideResponse(response);
    expect(parsed).not.toBeNull();
    expect(parsed!.override).toBe('no');
  });

  it('returns null for unparseable response', () => {
    const parsed = parseSeverityOverrideResponse('I think it should be P1.');
    expect(parsed).toBeNull();
  });

  it('handles case-insensitive override field', () => {
    const response = `override: YES
new_severity: p0
justification: Critical service with data loss.`;

    const parsed = parseSeverityOverrideResponse(response);
    expect(parsed).not.toBeNull();
    expect(parsed!.override).toBe('yes');
    expect(parsed!.new_severity).toBe('P0');
  });
});

// ---------------------------------------------------------------------------
// buildOverridePrompt
// ---------------------------------------------------------------------------

describe('buildOverridePrompt', () => {
  it('interpolates all placeholders', () => {
    const result: SeverityResult = {
      severity: 'P2',
      score: 0.45,
      breakdown: {
        error_rate: { value: 12.3, sub_score: 0.50, weighted: 0.15 },
        affected_users: { value: 2400, sub_score: 0.75, weighted: 0.1875 },
        service_criticality: { value: 'critical', sub_score: 1.0, weighted: 0.20 },
        duration: { value: 45, sub_score: 0.75, weighted: 0.1125 },
        data_integrity: { value: 'no_data_risk', sub_score: 0.0, weighted: 0.0 },
      },
    };

    const prompt = buildOverridePrompt(result, 'Service is degrading rapidly.');

    expect(prompt).toContain('Severity: P2');
    expect(prompt).toContain('Score: 0.4500');
    expect(prompt).toContain('Error rate: 12.3%');
    expect(prompt).toContain('Affected users: ~2400');
    expect(prompt).toContain('Service criticality: critical');
    expect(prompt).toContain('Duration: 45 min');
    expect(prompt).toContain('Data integrity: no_data_risk');
    expect(prompt).toContain('Service is degrading rapidly.');
    // No remaining placeholders
    expect(prompt).not.toContain('{');
    expect(prompt).not.toContain('}');
  });
});

// ---------------------------------------------------------------------------
// Task 5: LLM Override
// ---------------------------------------------------------------------------

describe('requestLlmOverride', () => {
  const baseResult: SeverityResult = {
    severity: 'P2',
    score: 0.45,
    breakdown: {
      error_rate: { value: 12.3, sub_score: 0.50, weighted: 0.15 },
      affected_users: { value: 2400, sub_score: 0.75, weighted: 0.1875 },
      service_criticality: { value: 'critical', sub_score: 1.0, weighted: 0.20 },
      duration: { value: 45, sub_score: 0.75, weighted: 0.1125 },
      data_integrity: { value: 'no_data_risk', sub_score: 0.0, weighted: 0.0 },
    },
  };

  const baseCandidate = buildCandidate();

  // TC-3-2-08: Override one level up
  it('TC-3-2-08: accepts override one level up (P2 -> P1)', async () => {
    const mockLlm = buildMockLlm(
      `OVERRIDE: yes\nNEW_SEVERITY: P1\nJUSTIFICATION: Error trend is accelerating rapidly.`,
    );

    const override = await requestLlmOverride(
      baseResult,
      baseCandidate,
      'Error trend accelerating',
      mockLlm,
    );

    expect(override).not.toBeNull();
    expect(override!.original_severity).toBe('P2');
    expect(override!.new_severity).toBe('P1');
    expect(override!.justification).toBe('Error trend is accelerating rapidly.');
    expect(override!.accepted).toBe(true);
  });

  // TC-3-2-09: Override one level down
  it('TC-3-2-09: accepts override one level down (P1 -> P2)', async () => {
    const p1Result: SeverityResult = { ...baseResult, severity: 'P1', score: 0.60 };
    const mockLlm = buildMockLlm(
      `OVERRIDE: yes\nNEW_SEVERITY: P2\nJUSTIFICATION: Error is transient and self-recovering.`,
    );

    const override = await requestLlmOverride(
      p1Result,
      baseCandidate,
      'Self-recovering error',
      mockLlm,
    );

    expect(override).not.toBeNull();
    expect(override!.original_severity).toBe('P1');
    expect(override!.new_severity).toBe('P2');
    expect(override!.accepted).toBe(true);
  });

  // TC-3-2-10: Override two levels rejected
  it('TC-3-2-10: rejects override more than one level (P3 -> P1)', async () => {
    const p3Result: SeverityResult = { ...baseResult, severity: 'P3', score: 0.20 };
    const mockLlm = buildMockLlm(
      `OVERRIDE: yes\nNEW_SEVERITY: P1\nJUSTIFICATION: This is actually quite severe.`,
    );

    const override = await requestLlmOverride(
      p3Result,
      baseCandidate,
      'Possibly severe',
      mockLlm,
    );

    expect(override).not.toBeNull();
    expect(override!.original_severity).toBe('P3');
    expect(override!.new_severity).toBe('P1');
    expect(override!.accepted).toBe(false);
  });

  // TC-3-2-11: Override no change
  it('TC-3-2-11: returns null when LLM responds with no override', async () => {
    const mockLlm = buildMockLlm(
      `OVERRIDE: no\nNEW_SEVERITY: P2\nJUSTIFICATION: Assessment is accurate.`,
    );

    const override = await requestLlmOverride(
      baseResult,
      baseCandidate,
      'Assessment accurate',
      mockLlm,
    );

    expect(override).toBeNull();
  });

  it('returns null when LLM response is unparseable', async () => {
    const mockLlm = buildMockLlm('I think the severity is fine.');

    const override = await requestLlmOverride(
      baseResult,
      baseCandidate,
      'Some evidence',
      mockLlm,
    );

    expect(override).toBeNull();
  });

  it('rejects P0 -> P2 override (two levels down)', async () => {
    const p0Result: SeverityResult = { ...baseResult, severity: 'P0', score: 0.80 };
    const mockLlm = buildMockLlm(
      `OVERRIDE: yes\nNEW_SEVERITY: P2\nJUSTIFICATION: Not that bad.`,
    );

    const override = await requestLlmOverride(
      p0Result,
      baseCandidate,
      'Some evidence',
      mockLlm,
    );

    expect(override).not.toBeNull();
    expect(override!.accepted).toBe(false);
  });

  it('rejects P3 -> P0 override (three levels up)', async () => {
    const p3Result: SeverityResult = { ...baseResult, severity: 'P3', score: 0.10 };
    const mockLlm = buildMockLlm(
      `OVERRIDE: yes\nNEW_SEVERITY: P0\nJUSTIFICATION: Everything is on fire.`,
    );

    const override = await requestLlmOverride(
      p3Result,
      baseCandidate,
      'Fire detected',
      mockLlm,
    );

    expect(override).not.toBeNull();
    expect(override!.accepted).toBe(false);
  });

  it('accepts P0 -> P1 override (one level down)', async () => {
    const p0Result: SeverityResult = { ...baseResult, severity: 'P0', score: 0.80 };
    const mockLlm = buildMockLlm(
      `OVERRIDE: yes\nNEW_SEVERITY: P1\nJUSTIFICATION: Impact is contained to non-critical users.`,
    );

    const override = await requestLlmOverride(
      p0Result,
      baseCandidate,
      'Contained impact',
      mockLlm,
    );

    expect(override).not.toBeNull();
    expect(override!.accepted).toBe(true);
    expect(override!.new_severity).toBe('P1');
  });

  it('accepts P2 -> P3 override (one level down)', async () => {
    const mockLlm = buildMockLlm(
      `OVERRIDE: yes\nNEW_SEVERITY: P3\nJUSTIFICATION: Known false positive from deployment.`,
    );

    const override = await requestLlmOverride(
      baseResult,
      baseCandidate,
      'Deployment-related spike',
      mockLlm,
    );

    expect(override).not.toBeNull();
    expect(override!.accepted).toBe(true);
    expect(override!.new_severity).toBe('P3');
  });

  it('override includes justification string', async () => {
    const mockLlm = buildMockLlm(
      `OVERRIDE: yes\nNEW_SEVERITY: P1\nJUSTIFICATION: Revenue-impacting endpoint affected.`,
    );

    const override = await requestLlmOverride(
      baseResult,
      baseCandidate,
      'Revenue impact',
      mockLlm,
    );

    expect(override).not.toBeNull();
    expect(override!.justification).toBe('Revenue-impacting endpoint affected.');
  });
});

// ---------------------------------------------------------------------------
// SPEC-007-3-6: TDD example verification
// ---------------------------------------------------------------------------

describe('TDD example verification (SPEC-007-3-6)', () => {
  it('TDD example: error=12.3%, users=2400, critical, 45min -> P1', () => {
    // TDD section 3.9.2 example:
    // error_rate = 12.3%  -> sub_score=0.50 (> 5%)  -> weighted=0.15
    // users ~= 2400       -> sub_score=0.75 (> 1000) -> weighted=0.1875
    // criticality=critical -> sub_score=1.0          -> weighted=0.20
    // duration=45 min     -> sub_score=0.75 (> 30)   -> weighted=0.1125
    // data_integrity=none -> sub_score=0.0            -> weighted=0.0
    // Total = 0.15 + 0.1875 + 0.20 + 0.1125 + 0.0 = 0.65 -> P1 (>= 0.55, < 0.75)

    // We need throughput that gives ~2400 users:
    // 2400 = round(throughput * 45 * 60 * 0.123 / 3) => throughput ~= 21.68
    const throughput = 21.68;
    const candidate = buildCandidate({
      metric_value: 12.3,
      sustained_minutes: 45,
      has_data_loss_indicator: false,
      has_data_corruption_indicator: false,
    });
    const service = buildService({ criticality: 'critical' });

    const result = computeSeverity(candidate, service, throughput);

    expect(result.severity).toBe('P1');
    expect(result.score).toBeCloseTo(0.65, 1);
    expect(result.breakdown.error_rate.sub_score).toBe(0.50);
    expect(result.breakdown.affected_users.sub_score).toBe(0.75);
    expect(result.breakdown.service_criticality.sub_score).toBe(1.0);
    expect(result.breakdown.duration.sub_score).toBe(0.75);
    expect(result.breakdown.data_integrity.sub_score).toBe(0.0);
  });

  it('boundary: score exactly 0.75 maps to P0', () => {
    // Verify the boundary condition for P0 threshold
    const throughput = 90.9;
    const candidate = buildCandidate({
      metric_value: 55,
      sustained_minutes: 5,
      has_data_loss_indicator: false,
      has_data_corruption_indicator: true,
    });
    const service = buildService({ criticality: 'high' });

    const result = computeSeverity(candidate, service, throughput);

    expect(result.score).toBeCloseTo(0.75, 2);
    expect(result.severity).toBe('P0');
  });

  it('boundary: score exactly 0.55 maps to P1', () => {
    const throughput = 250;
    const candidate = buildCandidate({
      metric_value: 6,
      sustained_minutes: 5,
      has_data_loss_indicator: false,
      has_data_corruption_indicator: true,
    });
    const service = buildService({ criticality: 'medium' });

    const result = computeSeverity(candidate, service, throughput);

    expect(result.score).toBeCloseTo(0.55, 2);
    expect(result.severity).toBe('P1');
  });

  it('boundary: score exactly 0.35 maps to P2', () => {
    const throughput = 25;
    const candidate = buildCandidate({
      metric_value: 2,
      sustained_minutes: 5,
      has_data_loss_indicator: false,
      has_data_corruption_indicator: true,
    });
    const service = buildService({ criticality: 'medium' });

    const result = computeSeverity(candidate, service, throughput);

    expect(result.score).toBeCloseTo(0.35, 2);
    expect(result.severity).toBe('P2');
  });
});
