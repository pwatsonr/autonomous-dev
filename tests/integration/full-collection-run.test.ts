/**
 * End-to-end integration test with mock MCP servers (SPEC-007-1-4, Task 11).
 *
 * Tests the full observation runner lifecycle from initialize through finalize,
 * using mock delegates that simulate MCP server responses, retries, failures,
 * and concurrent lock scenarios.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  ObservationRunner,
  type CandidateObservation,
  type CollectedData,
  type ObservationRunnerOptions,
} from '../../src/runner/observation-runner';
import type { DataSourceStatus } from '../../src/adapters/mcp-error-handler';
import { withMcpRetry, type McpErrorPolicy } from '../../src/adapters/mcp-error-handler';
import { AuditLogger } from '../../src/runner/audit-logger';
import { LockManager } from '../../src/runner/lock-manager';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let configPath: string;

/** Writes a minimal valid YAML config. */
async function writeConfig(serviceCount: number = 3): Promise<void> {
  const services = [
    { name: 'api-gateway', repo: 'org/api-gateway', job: 'api-gateway', uid: 'abc', index: 'api-gateway-*', crit: 'critical' },
    { name: 'auth-service', repo: 'org/auth-service', job: 'auth-service', uid: 'def', index: 'auth-service-*', crit: 'high' },
    { name: 'billing', repo: 'org/billing', job: 'billing', uid: 'ghi', index: 'billing-*', crit: 'medium' },
  ].slice(0, serviceCount);

  const svcYaml = services
    .map(
      (s) => `  - name: ${s.name}
    repo: ${s.repo}
    prometheus_job: ${s.job}
    grafana_dashboard_uid: ${s.uid}
    opensearch_index: "${s.index}"
    criticality: ${s.crit}`,
    )
    .join('\n');

  const yaml = `
schedule:
  type: cron
  expression: "0 */4 * * *"
services:
${svcYaml}
default_thresholds:
  error_rate_percent: 1
  sustained_duration_minutes: 15
  p99_latency_ms: 500
  availability_percent: 99.9
per_service_overrides: {}
query_budgets:
  prometheus:
    max_queries_per_service: 10
    timeout_seconds: 30
  grafana:
    max_queries_per_service: 5
    timeout_seconds: 30
  opensearch:
    max_queries_per_service: 5
    timeout_seconds: 30
  sentry:
    max_queries_per_service: 3
    timeout_seconds: 30
anomaly_detection:
  method: zscore
  sensitivity: 2.5
  consecutive_runs_required: 3
trend_analysis:
  windows:
    - "1h"
    - "24h"
    - "7d"
  min_slope_threshold: 0.1
false_positive_filters:
  maintenance_windows: []
  excluded_error_patterns: []
  load_test_markers: []
governance:
  cooldown_days: 7
  oscillation_window_days: 14
  oscillation_threshold: 3
  effectiveness_comparison_days: 30
  effectiveness_improvement_threshold: 0.1
retention:
  observation_days: 90
  archive_days: 365
custom_pii_patterns: []
custom_secret_patterns: []
auto_promote:
  enabled: false
  override_hours: 48
notifications:
  enabled: false
  webhook_url: null
  severity_filter:
    - P0
    - P1
`;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, yaml, 'utf-8');
}

function makeCollectedData(service: string): CollectedData {
  return {
    service,
    prometheus: [{ metric: 'up', value: 1 }],
    grafana: [{ alert: 'high_latency' }],
    opensearch: [{ log: 'error in request handler' }],
    sentry: [],
    query_counts: { prometheus: 7, grafana: 2, opensearch: 2 },
    tokens_consumed: 1500,
  };
}

function makeObservation(service: string, id: string): CandidateObservation {
  return {
    id,
    service,
    severity: 'P2',
    summary: `Observation for ${service}`,
    data_sources: ['prometheus', 'opensearch'],
    tokens_consumed: 500,
  };
}

function createRunner(overrides: Partial<ObservationRunnerOptions> = {}): ObservationRunner {
  return new ObservationRunner({
    rootDir: tmpDir,
    configPath,
    overrideRunId: 'RUN-20260408-143000',
    healthCheckProvider: () => ({
      prometheus: async () => 'available' as DataSourceStatus,
      grafana: async () => 'available' as DataSourceStatus,
      opensearch: async () => 'available' as DataSourceStatus,
    }),
    lockManagerOptions: {
      delayFn: async () => {},
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('Full collection run integration', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-test-'));
    configPath = path.join(tmpDir, '.autonomous-dev/config/intelligence.yaml');
    await writeConfig(3);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --- Full lifecycle with all MCP servers mocked as available ---
  it('completes full lifecycle with all sources available', async () => {
    const servicesProcessed: string[] = [];
    const reportsGenerated: string[] = [];

    const runner = createRunner({
      collectData: async (service) => {
        servicesProcessed.push(service.name);
        return makeCollectedData(service.name);
      },
      analyzeData: async (_data, service) => [
        makeObservation(service.name, `obs-${service.name}`),
      ],
      generateReports: async (_obs, service, runId) => {
        reportsGenerated.push(`${service.name}:${runId}`);
      },
    });

    const metadata = await runner.run('all');

    // All 3 services processed
    expect(servicesProcessed).toEqual(['api-gateway', 'auth-service', 'billing']);

    // Reports generated for each service
    expect(reportsGenerated).toEqual([
      'api-gateway:RUN-20260408-143000',
      'auth-service:RUN-20260408-143000',
      'billing:RUN-20260408-143000',
    ]);

    // Metadata
    expect(metadata.run_id).toBe('RUN-20260408-143000');
    expect(metadata.observations_generated).toBe(3);
    expect(metadata.errors).toEqual([]);
    expect(metadata.data_source_status.prometheus).toBe('available');
    expect(metadata.data_source_status.grafana).toBe('available');
    expect(metadata.data_source_status.opensearch).toBe('available');

    // Audit log file exists
    const logPath = path.join(
      tmpDir,
      '.autonomous-dev/logs/intelligence/RUN-20260408-143000.log',
    );
    const stat = await fs.stat(logPath);
    expect(stat.isFile()).toBe(true);
  });

  // --- Runner with one source unavailable (partial data collection) ---
  it('completes run with partial data when one source is unavailable', async () => {
    const runner = createRunner({
      healthCheckProvider: () => ({
        prometheus: async () => 'available' as DataSourceStatus,
        grafana: async () => 'unreachable' as DataSourceStatus,
        opensearch: async () => 'available' as DataSourceStatus,
      }),
      collectData: async (service, connectivity) => {
        // Simulate: no grafana data since it's unreachable
        const data = makeCollectedData(service.name);
        if (connectivity.results.grafana === 'unreachable') {
          data.grafana = [];
          delete data.query_counts.grafana;
        }
        return data;
      },
      analyzeData: async (_data, service) => [
        makeObservation(service.name, `obs-${service.name}`),
      ],
    });

    const metadata = await runner.run('all');

    expect(metadata.data_source_status.grafana).toBe('unreachable');
    expect(metadata.observations_generated).toBe(3);
    expect(metadata.errors).toEqual([]);
  });

  // --- Runner with all sources unavailable (abort) ---
  it('aborts cleanly when all sources are unreachable', async () => {
    const collectCalled = { value: false };

    const runner = createRunner({
      healthCheckProvider: () => ({
        prometheus: async () => 'unreachable' as DataSourceStatus,
        grafana: async () => 'unreachable' as DataSourceStatus,
        opensearch: async () => 'unreachable' as DataSourceStatus,
      }),
      collectData: async (service) => {
        collectCalled.value = true;
        return makeCollectedData(service.name);
      },
    });

    const metadata = await runner.run('all');

    expect(metadata.observations_generated).toBe(0);
    expect(metadata.errors).toContain('All MCP servers unreachable');
    // Data collection should NOT have been called
    expect(collectCalled.value).toBe(false);
  });

  // --- Lock file prevents concurrent writes to same service ---
  it('skips service when lock is held by another session', async () => {
    // Pre-create a lock file for api-gateway
    const lockDir = path.join(tmpDir, '.autonomous-dev/observations');
    await fs.mkdir(lockDir, { recursive: true });
    const lockFile = path.join(lockDir, '.lock-api-gateway');
    await fs.writeFile(
      lockFile,
      JSON.stringify({
        pid: process.pid + 999,
        acquired_at: new Date().toISOString(),
        service: 'api-gateway',
      }),
      'utf-8',
    );

    const servicesProcessed: string[] = [];
    const runner = createRunner({
      lockManagerOptions: {
        waitTimeoutMs: 100, // Short timeout
        initialBackoffMs: 10,
        maxBackoffMs: 20,
        delayFn: async () => {},
      },
      collectData: async (service) => {
        servicesProcessed.push(service.name);
        return makeCollectedData(service.name);
      },
    });

    const metadata = await runner.run('all');

    // api-gateway should have been skipped
    expect(servicesProcessed).not.toContain('api-gateway');
    expect(servicesProcessed).toContain('auth-service');
    expect(servicesProcessed).toContain('billing');
    expect(metadata.errors.some((e) => e.includes('Lock conflict'))).toBe(true);
  });

  // --- Stale lock cleanup after 60 minutes ---
  it('cleans stale locks and proceeds normally', async () => {
    const lockDir = path.join(tmpDir, '.autonomous-dev/observations');
    await fs.mkdir(lockDir, { recursive: true });
    const lockFile = path.join(lockDir, '.lock-api-gateway');
    const ninetyMinutesAgo = new Date(Date.now() - 90 * 60 * 1000);
    await fs.writeFile(
      lockFile,
      JSON.stringify({
        pid: 99999,
        acquired_at: ninetyMinutesAgo.toISOString(),
        service: 'api-gateway',
      }),
      'utf-8',
    );

    const servicesProcessed: string[] = [];
    const runner = createRunner({
      collectData: async (service) => {
        servicesProcessed.push(service.name);
        return makeCollectedData(service.name);
      },
    });

    const metadata = await runner.run('all');

    // Stale lock should have been cleaned; api-gateway should be processed
    expect(servicesProcessed).toContain('api-gateway');
    expect(metadata.errors).toEqual([]);
  });

  // --- Query budget exhaustion mid-service ---
  it('proceeds with partial data when query budget is exhausted', async () => {
    const runner = createRunner({
      collectData: async (service, _connectivity, budget) => {
        const data = makeCollectedData(service.name);
        // Simulate: first service exhausts prometheus budget
        if (service.name === 'api-gateway') {
          data.query_counts.prometheus = 10;
        }
        return data;
      },
      analyzeData: async (_data, service) => [
        makeObservation(service.name, `obs-${service.name}`),
      ],
    });

    const metadata = await runner.run('all');

    // Should still complete for all services
    expect(metadata.observations_generated).toBe(3);
    expect(metadata.queries_executed.prometheus).toBeGreaterThanOrEqual(10);
  });

  // --- MCP retry on timeout (first fail, second succeed) ---
  it('succeeds after retry when MCP call times out once', async () => {
    const auditLog = new AuditLogger('RUN-20260408-143000', '/tmp/test-logs');
    let callCount = 0;

    const result = await withMcpRetry(
      async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Connection timeout');
        }
        return { data: [1, 2, 3] };
      },
      { max_retries: 1, retry_delay_ms: 10, timeout_ms: 5000 },
      { source: 'prometheus', query: 'up', service: 'api-gateway' },
      auditLog,
      async () => {}, // no-op delay for test speed
    );

    expect(result).toEqual({ data: [1, 2, 3] });
    expect(callCount).toBe(2);
  });

  // --- MCP retry exhaustion (both attempts fail, graceful skip) ---
  it('returns null gracefully when both MCP attempts fail', async () => {
    const auditLog = new AuditLogger('RUN-20260408-143000', '/tmp/test-logs');

    const result = await withMcpRetry(
      async () => {
        throw new Error('Server unavailable');
      },
      { max_retries: 1, retry_delay_ms: 10, timeout_ms: 5000 },
      { source: 'opensearch', query: 'logs-*', service: 'billing' },
      auditLog,
      async () => {},
    );

    expect(result).toBeNull();

    const entries = auditLog.getEntries();
    expect(entries.some((e) => e.level === 'WARN')).toBe(true);
    expect(entries.some((e) => e.level === 'ERROR')).toBe(true);
    expect(entries.some((e) => e.message.includes('Skipping query'))).toBe(true);
  });

  // --- End-to-end with deduplication and governance ---
  it('end-to-end: collect -> scrub -> analyze -> dedup -> govern -> report', async () => {
    const phases: string[] = [];

    const runner = createRunner({
      collectData: async (service) => {
        phases.push(`collect:${service.name}`);
        return makeCollectedData(service.name);
      },
      scrubCollectedData: async (data) => {
        phases.push(`scrub:${data.service}`);
        return data;
      },
      analyzeData: async (_data, service) => {
        phases.push(`analyze:${service.name}`);
        return [
          makeObservation(service.name, 'obs1'),
          makeObservation(service.name, 'obs2'),
        ];
      },
      deduplicateCandidates: async (candidates, service) => {
        phases.push(`dedup:${service.name}`);
        return candidates.slice(0, 1); // Remove 1 duplicate
      },
      applyGovernanceChecks: async (candidates, service) => {
        phases.push(`govern:${service.name}`);
        return candidates; // All pass governance
      },
      generateReports: async (_obs, service) => {
        phases.push(`report:${service.name}`);
      },
    });

    const metadata = await runner.run('api-gateway');

    // Verify phase ordering for single service
    expect(phases).toEqual([
      'collect:api-gateway',
      'scrub:api-gateway',
      'analyze:api-gateway',
      'dedup:api-gateway',
      'govern:api-gateway',
      'report:api-gateway',
    ]);

    expect(metadata.observations_generated).toBe(1);
    expect(metadata.observations_deduplicated).toBe(1);
  });
});
