import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  ObservationRunner,
  QueryBudgetTracker,
  type RunMetadata,
  type CandidateObservation,
  type CollectedData,
  type ObservationRunnerOptions,
} from '../../src/runner/observation-runner';
import type { DataSourceStatus } from '../../src/adapters/mcp-error-handler';
import type { IntelligenceConfig, ServiceConfig } from '../../src/config/intelligence-config.schema';
import { generateRunId } from '../../src/runner/run-id';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid intelligence config for testing. */
function makeTestConfig(overrides: Partial<IntelligenceConfig> = {}): IntelligenceConfig {
  return {
    schedule: { type: 'cron', expression: '0 */4 * * *' },
    services: [
      {
        name: 'api-gateway',
        repo: 'org/api-gateway',
        prometheus_job: 'api-gateway',
        grafana_dashboard_uid: 'abc123',
        opensearch_index: 'api-gateway-*',
        criticality: 'critical',
      },
      {
        name: 'auth-service',
        repo: 'org/auth-service',
        prometheus_job: 'auth-service',
        grafana_dashboard_uid: 'def456',
        opensearch_index: 'auth-service-*',
        criticality: 'high',
      },
    ],
    default_thresholds: {
      error_rate_percent: 1,
      sustained_duration_minutes: 15,
      p99_latency_ms: 500,
      availability_percent: 99.9,
    },
    per_service_overrides: {},
    query_budgets: {
      prometheus: { max_queries_per_service: 10, timeout_seconds: 30 },
      grafana: { max_queries_per_service: 5, timeout_seconds: 30 },
      opensearch: { max_queries_per_service: 5, timeout_seconds: 30 },
      sentry: { max_queries_per_service: 3, timeout_seconds: 30 },
    },
    anomaly_detection: { method: 'zscore', sensitivity: 2.5, consecutive_runs_required: 3 },
    trend_analysis: { windows: ['1h', '24h', '7d'], min_slope_threshold: 0.1 },
    false_positive_filters: { maintenance_windows: [], excluded_error_patterns: [], load_test_markers: [] },
    governance: {
      cooldown_days: 7,
      oscillation_window_days: 14,
      oscillation_threshold: 3,
      effectiveness_comparison_days: 30,
      effectiveness_improvement_threshold: 0.1,
    },
    retention: { observation_days: 90, archive_days: 365 },
    custom_pii_patterns: [],
    custom_secret_patterns: [],
    auto_promote: { enabled: false, override_hours: 48 },
    notifications: { enabled: false, webhook_url: null, severity_filter: ['P0', 'P1'] },
    ...overrides,
  } as IntelligenceConfig;
}

/** Writes a minimal valid config YAML to disk. */
async function writeTestConfig(configPath: string, config?: IntelligenceConfig): Promise<void> {
  const c = config ?? makeTestConfig();
  // Write as YAML-like JSON (loadConfig parses YAML, and JSON is valid YAML)
  // Actually we need proper YAML. Use a simple approach.
  const yaml = `
schedule:
  type: cron
  expression: "0 */4 * * *"
services:
  - name: ${c.services[0].name}
    repo: ${c.services[0].repo}
    prometheus_job: ${c.services[0].prometheus_job}
    grafana_dashboard_uid: ${c.services[0].grafana_dashboard_uid}
    opensearch_index: "${c.services[0].opensearch_index}"
    criticality: ${c.services[0].criticality}
${c.services.length > 1 ? `  - name: ${c.services[1].name}
    repo: ${c.services[1].repo}
    prometheus_job: ${c.services[1].prometheus_job}
    grafana_dashboard_uid: ${c.services[1].grafana_dashboard_uid}
    opensearch_index: "${c.services[1].opensearch_index}"
    criticality: ${c.services[1].criticality}` : ''}
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
    grafana: [{ alert: 'none' }],
    opensearch: [{ log: 'ok' }],
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
    summary: `Test observation for ${service}`,
    data_sources: ['prometheus', 'opensearch'],
    tokens_consumed: 500,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ObservationRunner', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-test-'));
    configPath = path.join(tmpDir, '.autonomous-dev/config/intelligence.yaml');
    await writeTestConfig(configPath);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Helper: create a runner with reasonable defaults and overrides. */
  function createRunner(
    overrides: Partial<ObservationRunnerOptions> = {},
  ): ObservationRunner {
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
        delayFn: async () => {}, // Don't actually wait in tests
      },
      ...overrides,
    });
  }

  // --- TC-1-4-01: Run ID format ---
  describe('TC-1-4-01: run ID format', () => {
    it('generates RUN-YYYYMMDD-HHMMSS format', () => {
      const now = new Date('2026-04-08T14:30:00Z');
      const id = generateRunId(now);
      expect(id).toBe('RUN-20260408-143000');
    });
  });

  // --- TC-1-4-02: Full lifecycle happy path ---
  describe('TC-1-4-02: full lifecycle happy path', () => {
    it('completes run with 2 services processed and metadata written', async () => {
      const servicesProcessed: string[] = [];

      const runner = createRunner({
        collectData: async (service) => {
          servicesProcessed.push(service.name);
          return makeCollectedData(service.name);
        },
        analyzeData: async (_data, service) => [
          makeObservation(service.name, `obs-${service.name}`),
        ],
      });

      const metadata = await runner.run('all');

      expect(metadata.run_id).toBe('RUN-20260408-143000');
      expect(metadata.services_in_scope).toEqual(['api-gateway', 'auth-service']);
      expect(servicesProcessed).toEqual(['api-gateway', 'auth-service']);
      expect(metadata.observations_generated).toBe(2);
      expect(metadata.errors).toEqual([]);

      // Audit log should have been written
      const logPath = path.join(
        tmpDir,
        '.autonomous-dev/logs/intelligence/RUN-20260408-143000.log',
      );
      const logContent = await fs.readFile(logPath, 'utf-8');
      expect(logContent).toContain('[INFO]');
      expect(logContent).toContain('Run RUN-20260408-143000 started');
    });
  });

  // --- TC-1-4-03: Partial source availability ---
  describe('TC-1-4-03: partial source availability', () => {
    it('completes run with available sources only', async () => {
      const runner = createRunner({
        healthCheckProvider: () => ({
          prometheus: async () => 'available' as DataSourceStatus,
          grafana: async () => 'unreachable' as DataSourceStatus,
          opensearch: async () => 'available' as DataSourceStatus,
        }),
        collectData: async (service) => makeCollectedData(service.name),
      });

      const metadata = await runner.run('all');

      expect(metadata.data_source_status.prometheus).toBe('available');
      expect(metadata.data_source_status.grafana).toBe('unreachable');
      expect(metadata.errors).toEqual([]);
    });
  });

  // --- TC-1-4-04: All sources unreachable ---
  describe('TC-1-4-04: all sources unreachable', () => {
    it('aborts run cleanly with critical log and no observations', async () => {
      const runner = createRunner({
        healthCheckProvider: () => ({
          prometheus: async () => 'unreachable' as DataSourceStatus,
          grafana: async () => 'unreachable' as DataSourceStatus,
          opensearch: async () => 'unreachable' as DataSourceStatus,
        }),
      });

      const metadata = await runner.run('all');

      expect(metadata.observations_generated).toBe(0);
      expect(metadata.errors).toContain('All MCP servers unreachable');

      // Audit log should exist with critical entry
      const logPath = path.join(
        tmpDir,
        '.autonomous-dev/logs/intelligence/RUN-20260408-143000.log',
      );
      const logContent = await fs.readFile(logPath, 'utf-8');
      expect(logContent).toContain('[CRITICAL]');
      expect(logContent).toContain('All MCP servers unreachable');
    });
  });

  // --- TC-1-4-12: Sequential service processing ---
  describe('TC-1-4-12: sequential service processing', () => {
    it('processes services one at a time, not in parallel', async () => {
      const timeline: Array<{ service: string; phase: string; time: number }> = [];
      let callOrder = 0;

      const runner = createRunner({
        collectData: async (service) => {
          timeline.push({ service: service.name, phase: 'start', time: callOrder++ });
          const data = makeCollectedData(service.name);
          timeline.push({ service: service.name, phase: 'end', time: callOrder++ });
          return data;
        },
      });

      await runner.run('all');

      // First service should complete before second starts
      const firstEnd = timeline.find(
        (e) => e.service === 'api-gateway' && e.phase === 'end',
      )!;
      const secondStart = timeline.find(
        (e) => e.service === 'auth-service' && e.phase === 'start',
      )!;
      expect(firstEnd.time).toBeLessThan(secondStart.time);
    });
  });

  // --- TC-1-4-13: Audit log completeness ---
  describe('TC-1-4-13: audit log completeness', () => {
    it('contains init, connectivity, per-service entries, and finalize', async () => {
      const runner = createRunner({
        collectData: async (service) => makeCollectedData(service.name),
        analyzeData: async (_data, service) => [
          makeObservation(service.name, `obs-${service.name}`),
        ],
      });

      await runner.run('all');

      const logPath = path.join(
        tmpDir,
        '.autonomous-dev/logs/intelligence/RUN-20260408-143000.log',
      );
      const logContent = await fs.readFile(logPath, 'utf-8');

      // Init
      expect(logContent).toContain('Run RUN-20260408-143000 started');
      expect(logContent).toContain('Config loaded');

      // Connectivity
      expect(logContent).toContain('Connectivity:');
      expect(logContent).toContain('prometheus');

      // Per-service entries
      expect(logContent).toContain('Service api-gateway');
      expect(logContent).toContain('Service auth-service');

      // Finalize
      expect(logContent).toContain('observations generated');
      expect(logContent).toContain('tokens consumed');
    });
  });

  // --- TC-1-4-14: Token tracking ---
  describe('TC-1-4-14: token tracking', () => {
    it('reflects sum of tokens in metadata', async () => {
      const runner = createRunner({
        collectData: async (service) => ({
          ...makeCollectedData(service.name),
          tokens_consumed: 2000,
        }),
        analyzeData: async (_data, service) => [
          { ...makeObservation(service.name, 'obs1'), tokens_consumed: 300 },
        ],
      });

      const metadata = await runner.run('all');

      // 2 services * 2000 (collection) + 2 services * 300 (observation) = 4600
      expect(metadata.total_tokens_consumed).toBe(4600);
    });
  });

  // --- TC-1-4-15: Lock release on error ---
  describe('TC-1-4-15: lock release on error', () => {
    it('releases lock even when service processing throws', async () => {
      const runner = createRunner({
        collectData: async (service) => {
          if (service.name === 'api-gateway') {
            throw new Error('Collection explosion');
          }
          return makeCollectedData(service.name);
        },
      });

      const metadata = await runner.run('all');

      // Error should be recorded but second service should still process
      expect(metadata.errors.some((e) => e.includes('Collection explosion'))).toBe(true);

      // Lock files should not remain
      const lockDir = path.join(tmpDir, '.autonomous-dev/observations');
      const files = await fs.readdir(lockDir).catch(() => []);
      const lockFiles = (files as string[]).filter((f: string) => f.startsWith('.lock-'));
      expect(lockFiles).toEqual([]);
    });
  });

  // --- Scope filtering ---
  describe('scope filtering', () => {
    it('processes only the specified service when scope is a service name', async () => {
      const servicesProcessed: string[] = [];

      const runner = createRunner({
        collectData: async (service) => {
          servicesProcessed.push(service.name);
          return makeCollectedData(service.name);
        },
      });

      const metadata = await runner.run('api-gateway');

      expect(metadata.services_in_scope).toEqual(['api-gateway']);
      expect(servicesProcessed).toEqual(['api-gateway']);
    });
  });

  // --- Deduplication and filtering counts ---
  describe('deduplication and filtering counts', () => {
    it('tracks deduplicated and filtered observation counts', async () => {
      const runner = createRunner({
        collectData: async (service) => makeCollectedData(service.name),
        analyzeData: async (_data, service) => [
          makeObservation(service.name, 'obs1'),
          makeObservation(service.name, 'obs2'),
          makeObservation(service.name, 'obs3'),
        ],
        deduplicateCandidates: async (candidates) => {
          // Simulate removing 1 duplicate
          return candidates.slice(0, 2);
        },
        applyGovernanceChecks: async (candidates) => {
          // Simulate filtering 1 observation
          return candidates.slice(0, 1);
        },
      });

      const metadata = await runner.run('all');

      // 2 services, each: 3 candidates -> 2 after dedup (1 deduped) -> 1 after gov (1 filtered)
      expect(metadata.observations_generated).toBe(2); // 1 per service
      expect(metadata.observations_deduplicated).toBe(2); // 1 per service
      expect(metadata.observations_filtered).toBe(2); // 1 per service
    });
  });

  // --- Triage processing ---
  describe('triage processing', () => {
    it('reports triage decisions processed count', async () => {
      const runner = createRunner({
        processPendingTriage: async () => 5,
        collectData: async (service) => makeCollectedData(service.name),
      });

      const metadata = await runner.run('all');
      expect(metadata.triage_decisions_processed).toBe(5);
    });

    it('continues when triage processing fails', async () => {
      const runner = createRunner({
        processPendingTriage: async () => {
          throw new Error('Triage DB connection failed');
        },
        collectData: async (service) => makeCollectedData(service.name),
      });

      const metadata = await runner.run('all');
      expect(metadata.errors.some((e) => e.includes('Triage'))).toBe(true);
      // Run should still complete
      expect(metadata.services_in_scope.length).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// QueryBudgetTracker
// ---------------------------------------------------------------------------

describe('QueryBudgetTracker', () => {
  const budgets = {
    prometheus: { max_queries_per_service: 10, timeout_seconds: 30 },
    grafana: { max_queries_per_service: 5, timeout_seconds: 30 },
    opensearch: { max_queries_per_service: 5, timeout_seconds: 30 },
    sentry: { max_queries_per_service: 3, timeout_seconds: 30 },
  };

  it('starts with zero counts', () => {
    const tracker = new QueryBudgetTracker(budgets);
    const counts = tracker.getCounts();
    expect(counts.prometheus).toBe(0);
    expect(counts.grafana).toBe(0);
  });

  it('records query counts', () => {
    const tracker = new QueryBudgetTracker(budgets);
    tracker.record('prometheus', 5);
    tracker.record('prometheus', 3);
    expect(tracker.getCounts().prometheus).toBe(8);
  });

  it('reports remaining budget correctly', () => {
    const tracker = new QueryBudgetTracker(budgets);
    expect(tracker.hasRemaining('prometheus', 10)).toBe(true);
    tracker.record('prometheus', 10);
    expect(tracker.hasRemaining('prometheus', 10)).toBe(false);
  });
});
