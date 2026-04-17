/**
 * Unit tests for the observation report generator
 * (SPEC-007-4-1, Task 1).
 *
 * Test case IDs correspond to the spec's test case table:
 *   TC-4-1-01 through TC-4-1-06, TC-4-1-15, TC-4-1-16.
 */

import {
  generateReport,
  buildFrontmatter,
  buildMarkdownBody,
  findServiceRepo,
} from '../../src/reports/report-generator';
import type { ReportInput } from '../../src/reports/report-generator';
import { parseFrontmatter } from '../../src/reports/schema-validator';
import type { CandidateObservation, BaselineMetrics, DeduplicationResult } from '../../src/engine/types';
import type { SeverityResult, SeverityBreakdown } from '../../src/engine/severity-scorer';
import type { ConfidenceScore } from '../../src/engine/confidence';
import type { PrometheusResult, GrafanaAlertResult } from '../../src/adapters/types';
import type { DataSourceStatus } from '../../src/adapters/types';
import type { ScrubbedOpenSearchResult } from '../../src/safety/scrub-pipeline';
import type { GovernanceFlags, LlmAnalysisResult, OscillationData } from '../../src/reports/templates';

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
    metric_value: 12.5,
    threshold_value: 5.0,
    sustained_minutes: 15,
    log_samples: ['Error: connection refused'],
    data_sources_used: ['prometheus', 'opensearch', 'grafana'],
    has_data_loss_indicator: false,
    has_data_corruption_indicator: false,
    occurrence_count: 3,
    ...overrides,
  };
}

function buildSeverityBreakdown(): SeverityBreakdown {
  return {
    error_rate: { value: 12.5, sub_score: 0.75, weighted: 0.225 },
    affected_users: { value: 1500, sub_score: 0.75, weighted: 0.1875 },
    service_criticality: { value: 'critical', sub_score: 1.0, weighted: 0.2 },
    duration: { value: 15, sub_score: 0.5, weighted: 0.075 },
    data_integrity: { value: 'no_data_risk', sub_score: 0.0, weighted: 0.0 },
  };
}

function buildSeverityResult(
  overrides: Partial<SeverityResult> = {},
): SeverityResult {
  return {
    severity: 'P1',
    score: 0.6875,
    breakdown: buildSeverityBreakdown(),
    ...overrides,
  };
}

function buildConfidence(
  overrides: Partial<ConfidenceScore> = {},
): ConfidenceScore {
  return {
    composite: 0.78,
    evidence_score: 1.0,
    dedup_score: 0.5,
    history_score: 0.62,
    ...overrides,
  };
}

function buildDedupResult(
  overrides: Partial<DeduplicationResult> = {},
): DeduplicationResult {
  return {
    action: 'new',
    ...overrides,
  };
}

function buildMetrics(): PrometheusResult[] {
  return [
    {
      query_name: 'error_rate',
      query: 'rate(http_errors_total[5m])',
      value: 12.5,
      timestamp: '2026-04-08T14:30:22.000Z',
      raw_response: {},
    },
    {
      query_name: 'latency_p99',
      query: 'histogram_quantile(0.99, rate(http_duration_seconds_bucket[5m]))',
      value: 450.2,
      timestamp: '2026-04-08T14:30:22.000Z',
      raw_response: {},
    },
    {
      query_name: 'throughput',
      query: 'rate(http_requests_total[5m])',
      value: 120.5,
      timestamp: '2026-04-08T14:30:22.000Z',
      raw_response: {},
    },
    {
      query_name: 'availability',
      query: '1 - rate(http_errors_total[5m]) / rate(http_requests_total[5m])',
      value: 87.5,
      timestamp: '2026-04-08T14:30:22.000Z',
      raw_response: {},
    },
  ];
}

function buildLogs(): ScrubbedOpenSearchResult[] {
  return [
    {
      hits: [
        {
          message: 'ConnectionPoolExhausted: unable to acquire connection within 30s',
          stack_trace: 'at ConnectionPool.acquire (pool.ts:42)',
          timestamp: '2026-04-08T14:29:00.000Z',
        },
      ],
      total_hits: 1,
      query_name: 'error_logs',
    },
  ];
}

function buildAlerts(): GrafanaAlertResult {
  return {
    alerts: [
      {
        name: 'High Error Rate - api-gateway',
        state: 'alerting',
        dashboard_uid: 'abc123',
        since: '2026-04-08T14:15:00.000Z',
      },
    ],
  };
}

function buildBaseline(): BaselineMetrics {
  return {
    service: 'api-gateway',
    learning_mode: false,
    learning_started: '2026-03-01T00:00:00.000Z',
    learning_completed: '2026-03-08T00:00:00.000Z',
    last_updated: '2026-04-08T14:00:00.000Z',
    observation_run_count: 100,
    metrics: {
      error_rate: {
        mean_7d: 1.2,
        stddev_7d: 0.3,
        mean_14d: 1.1,
        stddev_14d: 0.35,
        mean_30d: 1.0,
        stddev_30d: 0.4,
        p50: 0.8,
        p95: 2.5,
        p99: 3.0,
      },
      latency_p99: {
        mean_7d: 120.0,
        stddev_7d: 25.0,
        mean_14d: 115.0,
        stddev_14d: 28.0,
        mean_30d: 110.0,
        stddev_30d: 30.0,
        p50: 100.0,
        p95: 180.0,
        p99: 250.0,
      },
      throughput: {
        mean_7d: 150.0,
        stddev_7d: 20.0,
        mean_14d: 148.0,
        stddev_14d: 22.0,
        mean_30d: 145.0,
        stddev_30d: 25.0,
        p50: 140.0,
        p95: 190.0,
        p99: 210.0,
      },
      availability: {
        mean_7d: 99.5,
        stddev_7d: 0.2,
        mean_14d: 99.4,
        stddev_14d: 0.25,
        mean_30d: 99.3,
        stddev_30d: 0.3,
        p50: 99.6,
        p95: 99.0,
        p99: 98.5,
      },
    },
  };
}

function buildGovernanceFlags(
  overrides: Partial<GovernanceFlags> = {},
): GovernanceFlags {
  return {
    cooldown_active: false,
    oscillation_warning: false,
    ...overrides,
  };
}

function buildReportInput(
  overrides: Partial<ReportInput> = {},
): ReportInput {
  return {
    candidate: buildCandidate(),
    severity: buildSeverityResult(),
    confidence: buildConfidence(),
    dedupResult: buildDedupResult(),
    metrics: buildMetrics(),
    logs: buildLogs(),
    alerts: buildAlerts(),
    baseline: buildBaseline(),
    runId: 'run-20260408-143000',
    tokensConsumed: 1250,
    dataSourceStatus: {
      prometheus: 'available',
      grafana: 'available',
      opensearch: 'available',
      sentry: 'not_configured',
    },
    governanceFlags: buildGovernanceFlags(),
    fingerprint: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
    repo: 'api-gateway',
    ...overrides,
  };
}

const FIXED_TIME = new Date('2026-04-08T14:30:22.000Z');

// ---------------------------------------------------------------------------
// generateReport
// ---------------------------------------------------------------------------

describe('generateReport', () => {
  // TC-4-1-01: Full report matches TDD example format
  it('TC-4-1-01: produces report with all YAML fields and Markdown sections', () => {
    const input = buildReportInput();
    const { id, content } = generateReport(input, FIXED_TIME);

    // ID format
    expect(id).toMatch(/^OBS-20260408-143022-[a-f0-9]{4}$/);

    // YAML frontmatter present
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('\n---\n');

    // Parse and validate frontmatter
    const fm = parseFrontmatter(content);
    expect(fm).not.toBeNull();
    expect((fm as any).service).toBe('api-gateway');
    expect((fm as any).type).toBe('error');
    expect((fm as any).severity).toBe('P1');
    expect((fm as any).confidence).toBe(0.78);
    expect((fm as any).triage_status).toBe('pending');
    expect((fm as any).triage_decision).toBeNull();
    expect((fm as any).cooldown_active).toBe(false);
    expect((fm as any).observation_run_id).toBe('run-20260408-143000');
    expect((fm as any).tokens_consumed).toBe(1250);
    expect((fm as any).occurrence_count).toBe(3);
    expect((fm as any).oscillation_warning).toBe(false);
    expect((fm as any).data_sources.prometheus).toBe('available');
    expect((fm as any).data_sources.sentry).toBe('not_configured');

    // Markdown body sections
    expect(content).toContain('# Observation:');
    expect(content).toContain('## Summary');
    expect(content).toContain('## Severity Rationale');
    expect(content).toContain('## Evidence');
    expect(content).toContain('### Metrics (Prometheus)');
    expect(content).toContain('### Logs (OpenSearch)');
    expect(content).toContain('### Alerts (Grafana)');
    expect(content).toContain('## Root Cause Hypothesis');
    expect(content).toContain('## Recommended Action');
    expect(content).toContain('## Related Observations');
  });

  // TC-4-1-02: Severity rationale table
  it('TC-4-1-02: includes severity rationale table with all 5 factors', () => {
    const input = buildReportInput();
    const { content } = generateReport(input, FIXED_TIME);

    expect(content).toContain('| Factor | Value | Score |');
    expect(content).toContain('Error rate');
    expect(content).toContain('Estimated affected users');
    expect(content).toContain('Service criticality');
    expect(content).toContain('Duration');
    expect(content).toContain('Data integrity');
    expect(content).toContain('**Weighted score**');
  });

  // TC-4-1-03: Metrics table
  it('TC-4-1-03: includes metrics table with current, baseline, and threshold', () => {
    const input = buildReportInput();
    const { content } = generateReport(input, FIXED_TIME);

    expect(content).toContain('| Metric | Current | Baseline (7d) | Threshold |');
    expect(content).toContain('Error Rate');
    expect(content).toContain('Latency P99');
    expect(content).toContain('Throughput');
  });

  // TC-4-1-04: Log section with code blocks
  it('TC-4-1-04: includes log section with formatted code blocks', () => {
    const input = buildReportInput();
    const { content } = generateReport(input, FIXED_TIME);

    expect(content).toContain('### Logs (OpenSearch)');
    expect(content).toContain('```');
    expect(content).toContain('ConnectionPoolExhausted');
  });

  // TC-4-1-05: Root cause hypothesis with disclaimer
  it('TC-4-1-05: includes root cause hypothesis preceded by disclaimer', () => {
    const input = buildReportInput({
      llmAnalysis: {
        title: 'Connection Pool Exhaustion on api-gateway',
        summary: 'The api-gateway service is experiencing connection pool exhaustion.',
        rootCauseHypothesis: 'Database connection leak in the order processing module.',
        recommendedAction: 'Review connection pool settings and add connection leak detection.',
      },
    });
    const { content } = generateReport(input, FIXED_TIME);

    expect(content).toContain('## Root Cause Hypothesis');
    expect(content).toContain(
      '> **Note: This is a hypothesis generated by the intelligence engine, not a',
    );
    expect(content).toContain('Database connection leak');
  });

  // TC-4-1-06: No LLM analysis -> fallback text
  it('TC-4-1-06: uses fallback text when LLM analysis is unavailable', () => {
    const input = buildReportInput({ llmAnalysis: undefined });
    const { content } = generateReport(input, FIXED_TIME);

    expect(content).toContain('LLM analysis unavailable.');
    expect(content).toContain('Manual investigation required.');
  });

  // TC-4-1-15: Cooldown triage status
  it('TC-4-1-15: sets triage_status to cooldown when cooldown_active is true', () => {
    const input = buildReportInput({
      governanceFlags: buildGovernanceFlags({ cooldown_active: true }),
    });
    const { content } = generateReport(input, FIXED_TIME);

    const fm = parseFrontmatter(content);
    expect((fm as any).triage_status).toBe('cooldown');
    expect((fm as any).cooldown_active).toBe(true);
  });

  // TC-4-1-16: Oscillation warning section
  it('TC-4-1-16: includes oscillation warning section when flag is true', () => {
    const input = buildReportInput({
      governanceFlags: buildGovernanceFlags({
        oscillation_warning: true,
        oscillation_data: {
          flap_count: 5,
          window_minutes: 30,
          transitions: ['pending', 'alerting', 'pending', 'alerting', 'pending'],
        },
      }),
    });
    const { content } = generateReport(input, FIXED_TIME);

    expect(content).toContain('## Oscillation Warning');
    expect(content).toContain('oscillating between states');
    expect(content).toContain('Flap count: 5');
  });

  it('omits oscillation warning section when flag is false', () => {
    const input = buildReportInput({
      governanceFlags: buildGovernanceFlags({ oscillation_warning: false }),
    });
    const { content } = generateReport(input, FIXED_TIME);

    expect(content).not.toContain('## Oscillation Warning');
  });

  it('includes LLM override in severity rationale when accepted', () => {
    const input = buildReportInput({
      severity: buildSeverityResult({
        override: {
          original_severity: 'P2',
          new_severity: 'P1',
          justification: 'Customer-facing payment endpoint with data loss risk',
          accepted: true,
        },
      }),
    });
    const { content } = generateReport(input, FIXED_TIME);

    expect(content).toContain('**LLM Override**: P2 -> P1');
    expect(content).toContain('Customer-facing payment endpoint');

    // Frontmatter should use the overridden severity
    const fm = parseFrontmatter(content);
    expect((fm as any).severity).toBe('P1');
  });

  it('omits log section when no logs are present', () => {
    const input = buildReportInput({ logs: [] });
    const { content } = generateReport(input, FIXED_TIME);

    expect(content).not.toContain('### Logs (OpenSearch)');
  });

  it('omits alert section when no alerts are present', () => {
    const input = buildReportInput({ alerts: { alerts: [] } });
    const { content } = generateReport(input, FIXED_TIME);

    expect(content).not.toContain('### Alerts (Grafana)');
  });

  it('includes related observations when dedup finds existing', () => {
    const input = buildReportInput({
      dedupResult: {
        action: 'update_inter_run',
        existing_observation_id: 'OBS-20260407-120000-beef',
        reason: 'Same fingerprint, recurring issue',
      },
    });
    const { content } = generateReport(input, FIXED_TIME);

    expect(content).toContain('OBS-20260407-120000-beef');
    expect(content).toContain('Same fingerprint, recurring issue');

    const fm = parseFrontmatter(content);
    expect((fm as any).related_observations).toContain('OBS-20260407-120000-beef');
  });

  it('shows "first occurrence" when no related observations', () => {
    const input = buildReportInput({
      dedupResult: { action: 'new' },
    });
    const { content } = generateReport(input, FIXED_TIME);

    expect(content).toContain('None (first occurrence of this pattern).');
    const fm = parseFrontmatter(content);
    expect((fm as any).related_observations).toHaveLength(0);
  });

  it('uses LLM title when available', () => {
    const input = buildReportInput({
      llmAnalysis: {
        title: 'Critical DB Connection Leak',
        summary: 'Summary from LLM.',
        rootCauseHypothesis: 'Hypothesis from LLM.',
        recommendedAction: 'Action from LLM.',
      },
    });
    const { content } = generateReport(input, FIXED_TIME);

    expect(content).toContain('# Observation: Critical DB Connection Leak');
  });

  it('defaults occurrence_count to 1 when not set on candidate', () => {
    const candidate = buildCandidate();
    delete candidate.occurrence_count;
    const input = buildReportInput({ candidate });
    const { content } = generateReport(input, FIXED_TIME);

    const fm = parseFrontmatter(content);
    expect((fm as any).occurrence_count).toBe(1);
  });

  it('defaults data_sources to not_configured when missing', () => {
    const input = buildReportInput({
      dataSourceStatus: {},
    });
    const { content } = generateReport(input, FIXED_TIME);

    const fm = parseFrontmatter(content);
    expect((fm as any).data_sources.prometheus).toBe('not_configured');
    expect((fm as any).data_sources.grafana).toBe('not_configured');
    expect((fm as any).data_sources.opensearch).toBe('not_configured');
    expect((fm as any).data_sources.sentry).toBe('not_configured');
  });
});

// ---------------------------------------------------------------------------
// SPEC-007-4-4 additional report format tests
// ---------------------------------------------------------------------------

describe('Report Generator - SPEC-007-4-4 comprehensive format tests', () => {
  test('error observation matches TDD format', () => {
    const input = buildReportInput({
      candidate: buildCandidate({ type: 'error', service: 'api-gateway' }),
      severity: buildSeverityResult({ severity: 'P1' }),
    });
    const { id, content } = generateReport(input, FIXED_TIME);

    // Verify YAML frontmatter
    const fm = parseFrontmatter(content);
    expect(fm).not.toBeNull();
    expect((fm as any).id).toMatch(/^OBS-\d{8}-\d{6}-[a-f0-9]{4}$/);
    expect((fm as any).type).toBe('error');
    expect((fm as any).severity).toBe('P1');
    expect((fm as any).triage_status).toBe('pending');
    expect((fm as any).triage_decision).toBeNull();

    // Verify Markdown sections
    expect(content).toContain('## Summary');
    expect(content).toContain('## Severity Rationale');
    expect(content).toContain('## Evidence');
    expect(content).toContain('## Root Cause Hypothesis');
    expect(content).toContain('## Recommended Action');
    expect(content).toContain('## Related Observations');
  });

  test.each(['error', 'anomaly', 'trend', 'adoption'])(
    'observation type %s generates valid report',
    (type) => {
      const input = buildReportInput({
        candidate: buildCandidate({ type: type as any }),
      });
      const { content } = generateReport(input, FIXED_TIME);
      const fm = parseFrontmatter(content);
      expect((fm as any).type).toBe(type);
    },
  );

  test('P0 severity generates valid frontmatter', () => {
    const input = buildReportInput({
      severity: buildSeverityResult({ severity: 'P0', score: 0.95 }),
    });
    const { content } = generateReport(input, FIXED_TIME);
    const fm = parseFrontmatter(content);
    expect((fm as any).severity).toBe('P0');
  });

  test('P3 severity generates valid frontmatter', () => {
    const input = buildReportInput({
      severity: buildSeverityResult({ severity: 'P3', score: 0.15 }),
    });
    const { content } = generateReport(input, FIXED_TIME);
    const fm = parseFrontmatter(content);
    expect((fm as any).severity).toBe('P3');
  });

  test('zero confidence generates valid frontmatter', () => {
    const input = buildReportInput({
      confidence: buildConfidence({ composite: 0 }),
    });
    const { content } = generateReport(input, FIXED_TIME);
    const fm = parseFrontmatter(content);
    expect((fm as any).confidence).toBe(0);
  });

  test('maximum confidence generates valid frontmatter', () => {
    const input = buildReportInput({
      confidence: buildConfidence({ composite: 1.0 }),
    });
    const { content } = generateReport(input, FIXED_TIME);
    const fm = parseFrontmatter(content);
    expect((fm as any).confidence).toBe(1);
  });

  test('report with all data sources degraded', () => {
    const input = buildReportInput({
      dataSourceStatus: {
        prometheus: 'degraded',
        grafana: 'degraded',
        opensearch: 'degraded',
        sentry: 'degraded',
      },
    });
    const { content } = generateReport(input, FIXED_TIME);
    const fm = parseFrontmatter(content);
    expect((fm as any).data_sources.prometheus).toBe('degraded');
    expect((fm as any).data_sources.grafana).toBe('degraded');
    expect((fm as any).data_sources.opensearch).toBe('degraded');
    expect((fm as any).data_sources.sentry).toBe('degraded');
  });

  test('report includes fingerprint in frontmatter', () => {
    const fp = 'deadbeef12345678deadbeef12345678deadbeef12345678deadbeef12345678';
    const input = buildReportInput({ fingerprint: fp });
    const { content } = generateReport(input, FIXED_TIME);
    const fm = parseFrontmatter(content);
    expect((fm as any).fingerprint).toBe(fp);
  });

  test('report with high occurrence count', () => {
    const input = buildReportInput({
      candidate: buildCandidate({ occurrence_count: 42 }),
    });
    const { content } = generateReport(input, FIXED_TIME);
    const fm = parseFrontmatter(content);
    expect((fm as any).occurrence_count).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// buildFrontmatter
// ---------------------------------------------------------------------------

describe('buildFrontmatter', () => {
  it('includes all required fields', () => {
    const input = buildReportInput();
    const id = 'OBS-20260408-143022-abcd';
    const fm = buildFrontmatter(id, input, FIXED_TIME);

    expect(fm.id).toBe(id);
    expect(fm.timestamp).toBe('2026-04-08T14:30:22.000Z');
    expect(fm.service).toBe('api-gateway');
    expect(fm.repo).toBe('api-gateway');
    expect(fm.type).toBe('error');
    expect(fm.severity).toBe('P1');
    expect(fm.confidence).toBe(0.78);
    expect(fm.triage_status).toBe('pending');
    expect(fm.triage_decision).toBeNull();
    expect(fm.triage_by).toBeNull();
    expect(fm.triage_at).toBeNull();
    expect(fm.triage_reason).toBeNull();
    expect(fm.defer_until).toBeNull();
    expect(fm.cooldown_active).toBe(false);
    expect(fm.linked_prd).toBeNull();
    expect(fm.linked_deployment).toBeNull();
    expect(fm.effectiveness).toBeNull();
    expect(fm.effectiveness_detail).toBeNull();
    expect(fm.observation_run_id).toBe('run-20260408-143000');
    expect(fm.tokens_consumed).toBe(1250);
    expect(fm.fingerprint).toBeTruthy();
    expect(fm.occurrence_count).toBe(3);
    expect(fm.oscillation_warning).toBe(false);
  });

  it('uses overridden severity when LLM override is accepted', () => {
    const input = buildReportInput({
      severity: buildSeverityResult({
        severity: 'P2',
        override: {
          original_severity: 'P2',
          new_severity: 'P1',
          justification: 'Test override',
          accepted: true,
        },
      }),
    });
    const fm = buildFrontmatter('OBS-20260408-143022-abcd', input, FIXED_TIME);
    expect(fm.severity).toBe('P1');
  });

  it('keeps original severity when LLM override is rejected', () => {
    const input = buildReportInput({
      severity: buildSeverityResult({
        severity: 'P2',
        override: {
          original_severity: 'P2',
          new_severity: 'P0',
          justification: 'Attempted two-level jump',
          accepted: false,
        },
      }),
    });
    const fm = buildFrontmatter('OBS-20260408-143022-abcd', input, FIXED_TIME);
    expect(fm.severity).toBe('P2');
  });
});

// ---------------------------------------------------------------------------
// findServiceRepo
// ---------------------------------------------------------------------------

describe('findServiceRepo', () => {
  it('converts service name to repo-style name', () => {
    expect(findServiceRepo('api-gateway')).toBe('api-gateway');
    expect(findServiceRepo('Payment Service')).toBe('payment-service');
    expect(findServiceRepo('user_auth_service')).toBe('user-auth-service');
  });
});
