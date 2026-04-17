/**
 * Unit tests for error handler: LLM retry, token budget, and minimal
 * observation generation (SPEC-007-3-6, Task 15).
 *
 * Test case IDs: TC-3-6-01 through TC-3-6-06.
 */

import {
  withLlmRetry,
  generateMinimalObservation,
  TokenBudgetTracker,
  shouldHaltForBudget,
} from '../../src/engine/error-handler';
import type {
  AuditLogger,
  LlmRetryContext,
  MinimalObservation,
  RunMetadata,
} from '../../src/engine/error-handler';
import type { CandidateObservation } from '../../src/engine/types';
import type { SeverityResult } from '../../src/engine/severity-scorer';
import type { ServiceConfig } from '../../src/config/intelligence-config.schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCandidate(
  overrides: Partial<CandidateObservation> = {},
): CandidateObservation {
  return {
    type: 'error',
    error_type: 'error_rate',
    service: 'api-gateway',
    metric_value: 12.3,
    threshold_value: 5.0,
    sustained_minutes: 15,
    log_samples: [],
    data_sources_used: ['prometheus'],
    has_data_loss_indicator: false,
    has_data_corruption_indicator: false,
    ...overrides,
  };
}

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

function buildSeverityResult(
  overrides: Partial<SeverityResult> = {},
): SeverityResult {
  return {
    severity: 'P1',
    score: 0.65,
    breakdown: {
      error_rate: { value: 12.3, sub_score: 0.50, weighted: 0.15 },
      affected_users: { value: 2400, sub_score: 0.75, weighted: 0.1875 },
      service_criticality: { value: 'critical', sub_score: 1.0, weighted: 0.20 },
      duration: { value: 45, sub_score: 0.75, weighted: 0.1125 },
      data_integrity: { value: 'no_data_risk', sub_score: 0.0, weighted: 0.0 },
    },
    ...overrides,
  };
}

function buildMockAuditLogger(): AuditLogger & { warnings: string[]; errors: string[]; infos: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const infos: string[] = [];
  return {
    warnings,
    errors,
    infos,
    warn: (msg: string) => warnings.push(msg),
    error: (msg: string) => errors.push(msg),
    info: (msg: string) => infos.push(msg),
  };
}

function buildRunMetadata(): RunMetadata {
  return {
    errors: [],
    skipped_services: [],
    completed_services: [],
  };
}

// ---------------------------------------------------------------------------
// withLlmRetry
// ---------------------------------------------------------------------------

describe('withLlmRetry', () => {
  const context: LlmRetryContext = { service: 'api-gateway', phase: 'classification' };

  // TC-3-6-01: First call fails, second succeeds
  it('TC-3-6-01: returns result from second call when first fails', async () => {
    let callCount = 0;
    const operation = async () => {
      callCount++;
      if (callCount === 1) throw new Error('First call timeout');
      return 'success-result';
    };
    const auditLog = buildMockAuditLogger();

    const result = await withLlmRetry(operation, context, auditLog);

    expect(result).toBe('success-result');
    expect(callCount).toBe(2);
    expect(auditLog.warnings).toHaveLength(1);
    expect(auditLog.warnings[0]).toContain('Retrying');
    expect(auditLog.errors).toHaveLength(0);
  });

  // TC-3-6-02: Both calls fail -> null
  it('TC-3-6-02: returns null when both calls fail', async () => {
    const operation = async () => {
      throw new Error('LLM unavailable');
    };
    const auditLog = buildMockAuditLogger();

    const result = await withLlmRetry(operation, context, auditLog);

    expect(result).toBeNull();
    expect(auditLog.warnings).toHaveLength(1);
    expect(auditLog.errors).toHaveLength(1);
    expect(auditLog.errors[0]).toContain('Generating minimal observation');
  });

  it('returns result immediately when first call succeeds', async () => {
    let callCount = 0;
    const operation = async () => {
      callCount++;
      return 42;
    };
    const auditLog = buildMockAuditLogger();

    const result = await withLlmRetry(operation, context, auditLog);

    expect(result).toBe(42);
    expect(callCount).toBe(1);
    expect(auditLog.warnings).toHaveLength(0);
    expect(auditLog.errors).toHaveLength(0);
  });

  it('includes service and phase in log messages', async () => {
    const operation = async () => {
      throw new Error('timeout');
    };
    const auditLog = buildMockAuditLogger();

    await withLlmRetry(operation, { service: 'payment-svc', phase: 'analysis' }, auditLog);

    expect(auditLog.warnings[0]).toContain('payment-svc/analysis');
    expect(auditLog.errors[0]).toContain('payment-svc/analysis');
  });
});

// ---------------------------------------------------------------------------
// generateMinimalObservation
// ---------------------------------------------------------------------------

describe('generateMinimalObservation', () => {
  // TC-3-6-03: Confidence reduced by 0.7x factor
  it('TC-3-6-03: reduces confidence by 0.7x factor', () => {
    const candidate = buildCandidate();
    const severity = buildSeverityResult({ score: 0.65 });
    const service = buildService();

    const minimal = generateMinimalObservation(candidate, severity, service);

    expect(minimal.confidence).toBeCloseTo(0.65 * 0.7, 10);
    expect(minimal.llm_analysis_available).toBe(false);
  });

  it('includes auto-generated summary with error type and service name', () => {
    const candidate = buildCandidate({ error_type: 'timeout' });
    const severity = buildSeverityResult();
    const service = buildService({ name: 'payment-svc' });

    const minimal = generateMinimalObservation(candidate, severity, service);

    expect(minimal.summary).toContain('[Auto-generated]');
    expect(minimal.summary).toContain('timeout');
    expect(minimal.summary).toContain('payment-svc');
  });

  it('uses "error" when error_type is undefined', () => {
    const candidate = buildCandidate({ error_type: undefined });
    const severity = buildSeverityResult();
    const service = buildService();

    const minimal = generateMinimalObservation(candidate, severity, service);

    expect(minimal.summary).toContain('error');
  });

  it('sets root_cause_hypothesis to manual investigation message', () => {
    const candidate = buildCandidate();
    const severity = buildSeverityResult();
    const service = buildService();

    const minimal = generateMinimalObservation(candidate, severity, service);

    expect(minimal.root_cause_hypothesis).toBe(
      'LLM analysis unavailable. Manual investigation required.',
    );
  });

  it('sets recommended_action to manual review', () => {
    const candidate = buildCandidate();
    const severity = buildSeverityResult();
    const service = buildService();

    const minimal = generateMinimalObservation(candidate, severity, service);

    expect(minimal.recommended_action).toBe('Review metrics and logs manually.');
  });

  it('preserves all candidate fields in the minimal observation', () => {
    const candidate = buildCandidate({
      metric_value: 12.3,
      threshold_value: 5.0,
      service: 'api-gateway',
      log_samples: ['error line 1'],
      data_sources_used: ['prometheus', 'opensearch'],
    });
    const severity = buildSeverityResult({ severity: 'P1' });
    const service = buildService();

    const minimal = generateMinimalObservation(candidate, severity, service);

    expect(minimal.metric_value).toBe(12.3);
    expect(minimal.threshold_value).toBe(5.0);
    expect(minimal.service).toBe('api-gateway');
    expect(minimal.log_samples).toEqual(['error line 1']);
    expect(minimal.severity).toBe('P1');
  });
});

// ---------------------------------------------------------------------------
// TokenBudgetTracker
// ---------------------------------------------------------------------------

describe('TokenBudgetTracker', () => {
  // TC-3-6-04: canContinue returns true when budget allows
  it('TC-3-6-04: canContinue returns true when 150K consumed, 200K limit, est 30K next', () => {
    const tracker = new TokenBudgetTracker(200_000);
    tracker.record(150_000);

    expect(tracker.canContinue(30_000)).toBe(true);
  });

  // TC-3-6-05: canContinue returns false when budget exhausted
  it('TC-3-6-05: canContinue returns false when 185K consumed, 200K limit, est 30K next', () => {
    const tracker = new TokenBudgetTracker(200_000);
    tracker.record(185_000);

    expect(tracker.canContinue(30_000)).toBe(false);
  });

  it('defaults to 200,000 max tokens', () => {
    const tracker = new TokenBudgetTracker();
    expect(tracker.budget).toBe(200_000);
  });

  it('tracks consumed tokens correctly', () => {
    const tracker = new TokenBudgetTracker(100_000);
    tracker.record(30_000);
    tracker.record(20_000);

    expect(tracker.tokensConsumed).toBe(50_000);
    expect(tracker.remaining).toBe(50_000);
  });

  it('isExhausted returns true when consumed >= max', () => {
    const tracker = new TokenBudgetTracker(100_000);
    tracker.record(100_000);

    expect(tracker.isExhausted()).toBe(true);
  });

  it('isExhausted returns false when consumed < max', () => {
    const tracker = new TokenBudgetTracker(100_000);
    tracker.record(99_999);

    expect(tracker.isExhausted()).toBe(false);
  });

  it('remaining returns 0 when over budget', () => {
    const tracker = new TokenBudgetTracker(100_000);
    tracker.record(120_000);

    expect(tracker.remaining).toBe(0);
  });

  it('canContinue defaults to 30,000 estimated next service tokens', () => {
    const tracker = new TokenBudgetTracker(200_000);
    tracker.record(170_000);

    // 170K + 30K = 200K = limit -> should be true (<=)
    expect(tracker.canContinue()).toBe(true);

    tracker.record(1);
    // 170001 + 30000 = 200001 > 200000 -> should be false
    expect(tracker.canContinue()).toBe(false);
  });

  it('canContinue returns true at exact budget boundary', () => {
    const tracker = new TokenBudgetTracker(200_000);
    tracker.record(170_000);

    // 170K + 30K = 200K exactly -> true
    expect(tracker.canContinue(30_000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldHaltForBudget
// ---------------------------------------------------------------------------

describe('shouldHaltForBudget', () => {
  // TC-3-6-06: Complete current service, skip remaining
  it('TC-3-6-06: returns true and records skipped services when budget exhausted', () => {
    const tracker = new TokenBudgetTracker(200_000);
    tracker.record(185_000);

    const auditLog = buildMockAuditLogger();
    const metadata = buildRunMetadata();

    const shouldHalt = shouldHaltForBudget(
      tracker,
      'api-gateway',
      ['payment-svc', 'auth-svc'],
      auditLog,
      metadata,
    );

    expect(shouldHalt).toBe(true);
    expect(metadata.errors).toHaveLength(1);
    expect(metadata.errors[0]).toContain('payment-svc');
    expect(metadata.errors[0]).toContain('auth-svc');
    expect(metadata.skipped_services).toEqual(['payment-svc', 'auth-svc']);
    expect(auditLog.warnings).toHaveLength(1);
    expect(auditLog.warnings[0]).toContain('Token budget exhausted');
    expect(auditLog.warnings[0]).toContain('api-gateway');
  });

  it('returns false when budget has room', () => {
    const tracker = new TokenBudgetTracker(200_000);
    tracker.record(100_000);

    const auditLog = buildMockAuditLogger();
    const metadata = buildRunMetadata();

    const shouldHalt = shouldHaltForBudget(
      tracker,
      'api-gateway',
      ['payment-svc'],
      auditLog,
      metadata,
    );

    expect(shouldHalt).toBe(false);
    expect(metadata.errors).toHaveLength(0);
    expect(metadata.skipped_services).toHaveLength(0);
    expect(auditLog.warnings).toHaveLength(0);
  });
});
