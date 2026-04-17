/**
 * Unit tests for the feature adoption tracker (SPEC-007-3-5, Task 12).
 *
 * Test case IDs correspond to the spec's test case table:
 *   TC-3-5-01: Adoption: new endpoint found
 *   TC-3-5-02: Adoption: no deploys
 *   TC-3-5-03: Adoption: endpoint comparison
 */

import {
  FeatureAdoptionTracker,
  extractNewEndpoints,
  findSimilarEndpoint,
} from '../../src/engine/adoption-tracker';
import type {
  ExecuteInstantQueryFn,
} from '../../src/engine/adoption-tracker';
import type { ServiceConfig, IntelligenceConfig } from '../../src/config/intelligence-config.schema';
import type { GrafanaAnnotationResult } from '../../src/adapters/types';

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

function buildConfig(overrides: Partial<IntelligenceConfig> = {}): IntelligenceConfig {
  return {
    schedule: { type: 'cron', expression: '0 */4 * * *' },
    services: [buildService()],
    default_thresholds: {
      error_rate_percent: 5.0,
      sustained_duration_minutes: 10,
      p99_latency_ms: 5000,
      availability_percent: 99.9,
    },
    per_service_overrides: {},
    query_budgets: {
      prometheus: { max_queries_per_service: 20, timeout_seconds: 30 },
      grafana: { max_queries_per_service: 10, timeout_seconds: 30 },
      opensearch: { max_queries_per_service: 15, timeout_seconds: 60 },
      sentry: { max_queries_per_service: 10, timeout_seconds: 30 },
    },
    anomaly_detection: { method: 'zscore', sensitivity: 2.5, consecutive_runs_required: 2 },
    trend_analysis: { windows: ['24h', '7d'], min_slope_threshold: 0.01 },
    false_positive_filters: {
      maintenance_windows: [],
      excluded_error_patterns: [],
      load_test_markers: [],
    },
    governance: {
      cooldown_days: 7,
      oscillation_window_days: 30,
      oscillation_threshold: 3,
      effectiveness_comparison_days: 14,
      effectiveness_improvement_threshold: 0.1,
    },
    retention: { observation_days: 90, archive_days: 365 },
    custom_pii_patterns: [],
    custom_secret_patterns: [],
    auto_promote: { enabled: false, override_hours: 0 },
    notifications: { enabled: false, webhook_url: null, severity_filter: ['P0', 'P1'] },
    ...overrides,
  } as IntelligenceConfig;
}

/** Creates a mock GrafanaAdapter with configurable annotation responses. */
function buildMockGrafanaAdapter(annotationResult: GrafanaAnnotationResult) {
  return {
    getAnnotations: async () => annotationResult,
    listAlerts: async () => ({ alerts: [] }),
  } as unknown as import('../../src/adapters/grafana-adapter').GrafanaAdapter;
}

/** Creates a mock executeInstantQuery function with configurable responses. */
function buildMockQueryFn(
  responses: Record<string, { value: number | null }>,
): ExecuteInstantQueryFn {
  return async (queryName: string) => {
    return responses[queryName] ?? { value: null };
  };
}

// ---------------------------------------------------------------------------
// extractNewEndpoints
// ---------------------------------------------------------------------------

describe('extractNewEndpoints', () => {
  it('extracts endpoint paths from annotation text', () => {
    const text = 'Deploy commit abc123: new endpoints /api/v2/orders, /api/v2/users';
    const endpoints = extractNewEndpoints(text);
    expect(endpoints).toContain('/api/v2/orders');
    expect(endpoints).toContain('/api/v2/users');
  });

  it('returns empty array for empty text', () => {
    expect(extractNewEndpoints('')).toEqual([]);
  });

  it('deduplicates repeated endpoints', () => {
    const text = '/api/v2/orders appears twice: /api/v2/orders';
    const endpoints = extractNewEndpoints(text);
    expect(endpoints).toEqual(['/api/v2/orders']);
  });

  it('returns empty array for text with no paths', () => {
    expect(extractNewEndpoints('just a plain deploy message')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findSimilarEndpoint
// ---------------------------------------------------------------------------

describe('findSimilarEndpoint', () => {
  const service = buildService();

  it('decrements version number v2 -> v1', () => {
    expect(findSimilarEndpoint('/api/v2/orders', service)).toBe('/api/v1/orders');
  });

  it('decrements version number v3 -> v2', () => {
    expect(findSimilarEndpoint('/api/v3/users', service)).toBe('/api/v2/users');
  });

  it('returns null for v1 (no lower version)', () => {
    expect(findSimilarEndpoint('/api/v1/orders', service)).toBeNull();
  });

  it('returns null for unversioned paths', () => {
    expect(findSimilarEndpoint('/health', service)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FeatureAdoptionTracker
// ---------------------------------------------------------------------------

describe('FeatureAdoptionTracker', () => {
  const service = buildService();
  const config = buildConfig();

  // TC-3-5-01: Adoption: new endpoint found
  it('TC-3-5-01: detects new endpoint with traffic after deploy', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const grafanaAdapter = buildMockGrafanaAdapter({
      annotations: [
        {
          id: 1,
          time: twoDaysAgo,
          text: 'Deploy commit: abc123 endpoint /api/v2/new',
          tags: ['deploy'],
          dashboard_uid: 'abc123',
        },
      ],
    });

    const queryFn = buildMockQueryFn({
      adoption_traffic: { value: 42.5 },
      adoption_errors: { value: 1.2 },
    });

    const tracker = new FeatureAdoptionTracker({
      grafanaAdapter,
      executeInstantQuery: queryFn,
    });

    const result = await tracker.trackFeatureAdoption(service, config);

    expect(result).not.toBeNull();
    expect(result!.detected).toBe(true);
    expect(result!.deploy_info.commit).toBe('abc123');
    expect(result!.endpoints).toHaveLength(1);
    expect(result!.endpoints[0].endpoint).toBe('/api/v2/new');
    expect(result!.endpoints[0].current_rps).toBe(42.5);
    expect(result!.endpoints[0].current_rps).toBeGreaterThan(0);
    expect(result!.endpoints[0].error_rate).toBe(1.2);
    expect(result!.endpoints[0].first_traffic_at).not.toBeNull();
  });

  // TC-3-5-02: Adoption: no deploys
  it('TC-3-5-02: returns null when no deploy annotations found', async () => {
    const grafanaAdapter = buildMockGrafanaAdapter({
      annotations: [],
    });

    const queryFn = buildMockQueryFn({});

    const tracker = new FeatureAdoptionTracker({
      grafanaAdapter,
      executeInstantQuery: queryFn,
    });

    const result = await tracker.trackFeatureAdoption(service, config);

    expect(result).toBeNull();
  });

  // TC-3-5-03: Adoption: endpoint comparison
  it('TC-3-5-03: computes traffic_ratio for versioned endpoints', async () => {
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const grafanaAdapter = buildMockGrafanaAdapter({
      annotations: [
        {
          id: 1,
          time: oneDayAgo,
          text: 'Deploy commit: def456 new /api/v2/orders',
          tags: ['deploy'],
          dashboard_uid: 'abc123',
        },
      ],
    });

    const queryFn: ExecuteInstantQueryFn = async (queryName: string) => {
      switch (queryName) {
        case 'adoption_traffic':
          return { value: 50.0 };
        case 'adoption_errors':
          return { value: 0.5 };
        case 'similar_traffic':
          return { value: 200.0 };
        case 'similar_errors':
          return { value: 0.1 };
        default:
          return { value: null };
      }
    };

    const tracker = new FeatureAdoptionTracker({
      grafanaAdapter,
      executeInstantQuery: queryFn,
    });

    const result = await tracker.trackFeatureAdoption(service, config);

    expect(result).not.toBeNull();
    expect(result!.endpoints).toHaveLength(1);

    const ep = result!.endpoints[0];
    expect(ep.endpoint).toBe('/api/v2/orders');
    expect(ep.comparison).toBeDefined();
    expect(ep.comparison!.similar_endpoint).toBe('/api/v1/orders');
    expect(ep.comparison!.similar_endpoint_rps).toBe(200.0);
    expect(ep.comparison!.traffic_ratio).toBe(0.25); // 50/200
  });

  it('returns null when annotation text has no endpoints', async () => {
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const grafanaAdapter = buildMockGrafanaAdapter({
      annotations: [
        {
          id: 1,
          time: oneDayAgo,
          text: 'Deploy completed successfully',
          tags: ['deploy'],
          dashboard_uid: 'abc123',
        },
      ],
    });

    const queryFn = buildMockQueryFn({});

    const tracker = new FeatureAdoptionTracker({
      grafanaAdapter,
      executeInstantQuery: queryFn,
    });

    const result = await tracker.trackFeatureAdoption(service, config);
    expect(result).toBeNull();
  });

  it('sets first_traffic_at to null when no traffic observed', async () => {
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const grafanaAdapter = buildMockGrafanaAdapter({
      annotations: [
        {
          id: 1,
          time: oneDayAgo,
          text: 'Deploy /api/v1/new-feature',
          tags: ['deploy'],
          dashboard_uid: 'abc123',
        },
      ],
    });

    const queryFn = buildMockQueryFn({
      adoption_traffic: { value: 0 },
      adoption_errors: { value: 0 },
    });

    const tracker = new FeatureAdoptionTracker({
      grafanaAdapter,
      executeInstantQuery: queryFn,
    });

    const result = await tracker.trackFeatureAdoption(service, config);

    expect(result).not.toBeNull();
    expect(result!.endpoints[0].first_traffic_at).toBeNull();
    expect(result!.endpoints[0].current_rps).toBe(0);
  });

  it('extracts commit hash from annotation text', async () => {
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const grafanaAdapter = buildMockGrafanaAdapter({
      annotations: [
        {
          id: 1,
          time: oneDayAgo,
          text: 'Deploy commit: a1b2c3d endpoint /api/v1/test',
          tags: ['deploy'],
          dashboard_uid: 'abc123',
        },
      ],
    });

    const queryFn = buildMockQueryFn({
      adoption_traffic: { value: 10 },
      adoption_errors: { value: 0 },
    });

    const tracker = new FeatureAdoptionTracker({
      grafanaAdapter,
      executeInstantQuery: queryFn,
    });

    const result = await tracker.trackFeatureAdoption(service, config);

    expect(result!.deploy_info.commit).toBe('a1b2c3d');
  });

  it('sets commit to "unknown" when no commit hash in annotation', async () => {
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const grafanaAdapter = buildMockGrafanaAdapter({
      annotations: [
        {
          id: 1,
          time: oneDayAgo,
          text: 'New deployment /api/v1/test',
          tags: ['deploy'],
          dashboard_uid: 'abc123',
        },
      ],
    });

    const queryFn = buildMockQueryFn({
      adoption_traffic: { value: 10 },
      adoption_errors: { value: 0 },
    });

    const tracker = new FeatureAdoptionTracker({
      grafanaAdapter,
      executeInstantQuery: queryFn,
    });

    const result = await tracker.trackFeatureAdoption(service, config);

    expect(result!.deploy_info.commit).toBe('unknown');
  });
});
