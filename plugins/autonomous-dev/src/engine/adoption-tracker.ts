/**
 * Feature adoption tracking engine (SPEC-007-3-5, Task 12).
 *
 * Monitors traffic to newly deployed endpoints by correlating Grafana
 * deploy annotations with Prometheus HTTP request metrics. For each
 * deploy in the last 7 days, identifies new/changed endpoints, queries
 * their current traffic, and compares to similar existing endpoints.
 */

import type { ServiceConfig, IntelligenceConfig } from '../config/intelligence-config.schema';
import type { GrafanaAdapter } from '../adapters/grafana-adapter';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Traffic and adoption state for a single newly deployed endpoint.
 */
export interface EndpointAdoption {
  /** The endpoint path (e.g., "/api/v2/orders"). */
  endpoint: string;

  /** ISO 8601 timestamp of first observed traffic, or null if no traffic yet. */
  first_traffic_at: string | null;

  /** Current requests per second. */
  current_rps: number;

  /** Current error rate as a percentage. */
  error_rate: number;

  /** Comparison against a similar, pre-existing endpoint. */
  comparison?: {
    similar_endpoint: string;
    similar_endpoint_rps: number;
    similar_endpoint_error_rate: number;
    /** Ratio of new endpoint RPS to similar endpoint RPS. */
    traffic_ratio: number;
  };
}

/**
 * Aggregate adoption result for a service after a deployment.
 */
export interface AdoptionResult {
  /** True when at least one new endpoint was found and tracked. */
  detected: boolean;

  /** Metadata about the most recent deploy. */
  deploy_info: {
    commit: string;
    deployed_at: string;
    days_since_deploy: number;
  };

  /** Per-endpoint adoption details. */
  endpoints: EndpointAdoption[];
}

// ---------------------------------------------------------------------------
// Endpoint extraction helpers
// ---------------------------------------------------------------------------

/**
 * Regular expression matching endpoint paths in deploy annotation text.
 *
 * Matches patterns like:
 *   - "endpoint: /api/v2/new"
 *   - "endpoints: /api/v2/foo, /api/v2/bar"
 *   - "/api/v2/new" standalone in text
 */
const ENDPOINT_REGEX = /\/[a-zA-Z0-9/_-]+/g;

/**
 * Extracts new endpoint paths from a deploy annotation text body.
 *
 * Looks for URL-like path patterns (starting with `/`) in the annotation
 * text and returns unique paths.
 */
export function extractNewEndpoints(annotationText: string): string[] {
  if (!annotationText) return [];

  const matches = annotationText.match(ENDPOINT_REGEX);
  if (!matches) return [];

  // Deduplicate
  return [...new Set(matches)];
}

/**
 * Finds a similar pre-existing endpoint for comparison.
 *
 * Heuristic: swaps version numbers in the path (e.g., v2 -> v1) and
 * checks against the service's known endpoint patterns.
 *
 * @param endpoint   The new endpoint path
 * @param _service   The service configuration (for future expansion)
 * @returns A similar endpoint path, or null if none found
 */
export function findSimilarEndpoint(
  endpoint: string,
  _service: ServiceConfig,
): string | null {
  // Try to find a versioned path segment and decrement the version
  const versionMatch = endpoint.match(/\/v(\d+)\//);
  if (versionMatch) {
    const currentVersion = parseInt(versionMatch[1], 10);
    if (currentVersion > 1) {
      return endpoint.replace(
        `/v${currentVersion}/`,
        `/v${currentVersion - 1}/`,
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prometheus query helpers
// ---------------------------------------------------------------------------

/**
 * Builds a PromQL instant query for endpoint traffic rate.
 */
function buildTrafficQuery(job: string, endpoint: string): string {
  return `sum(rate(http_requests_total{job="${job}",handler="${endpoint}"}[1h]))`;
}

/**
 * Builds a PromQL instant query for endpoint error rate.
 */
function buildErrorRateQuery(job: string, endpoint: string): string {
  return `sum(rate(http_requests_total{job="${job}",handler="${endpoint}",status=~"5.."}[1h])) / sum(rate(http_requests_total{job="${job}",handler="${endpoint}"}[1h])) * 100`;
}

// ---------------------------------------------------------------------------
// Prometheus query delegate
// ---------------------------------------------------------------------------

/**
 * Function type for executing an instant PromQL query.
 * Injected as a dependency so the tracker does not directly call MCP.
 */
export type ExecuteInstantQueryFn = (
  queryName: string,
  query: string,
) => Promise<{ value: number | null }>;

// ---------------------------------------------------------------------------
// Main tracker
// ---------------------------------------------------------------------------

/**
 * Options for constructing a FeatureAdoptionTracker.
 */
export interface FeatureAdoptionTrackerOptions {
  /** Grafana adapter for annotation queries. */
  grafanaAdapter: GrafanaAdapter;

  /** Function to execute instant Prometheus queries. */
  executeInstantQuery: ExecuteInstantQueryFn;

  /** Lookback window in days for deploy annotations. Default: 7. */
  lookbackDays?: number;
}

/**
 * Tracks feature adoption by correlating deploy annotations with
 * endpoint traffic data.
 */
export class FeatureAdoptionTracker {
  private readonly grafanaAdapter: GrafanaAdapter;
  private readonly executeInstantQuery: ExecuteInstantQueryFn;
  private readonly lookbackDays: number;

  constructor(options: FeatureAdoptionTrackerOptions) {
    this.grafanaAdapter = options.grafanaAdapter;
    this.executeInstantQuery = options.executeInstantQuery;
    this.lookbackDays = options.lookbackDays ?? 7;
  }

  /**
   * Tracks feature adoption for a service by querying recent deploy
   * annotations and measuring traffic to newly deployed endpoints.
   *
   * @param service  Service configuration
   * @param _config  Intelligence configuration (for future expansion)
   * @returns AdoptionResult if deploys found, null otherwise
   */
  async trackFeatureAdoption(
    service: ServiceConfig,
    _config: IntelligenceConfig,
  ): Promise<AdoptionResult | null> {
    // Step 1: Get recent deploy annotations from Grafana (last N days)
    const windowHours = this.lookbackDays * 24;
    const annotations = await this.grafanaAdapter.getAnnotations(
      service.grafana_dashboard_uid,
      windowHours,
      ['deploy', 'release'],
      service.name,
    );

    if (annotations.annotations.length === 0) {
      return null; // No recent deploys
    }

    const results: EndpointAdoption[] = [];

    // Step 2: For each deploy within the lookback window
    for (const annotation of annotations.annotations) {
      const deployDate = new Date(annotation.time);

      // Step 3: Identify new/changed endpoints from deploy metadata
      const newEndpoints = extractNewEndpoints(annotation.text);

      // Step 4: Query Prometheus for traffic to new endpoints
      for (const endpoint of newEndpoints) {
        const trafficQuery = buildTrafficQuery(
          service.prometheus_job,
          endpoint,
        );
        const errorQuery = buildErrorRateQuery(
          service.prometheus_job,
          endpoint,
        );

        const traffic = await this.executeInstantQuery(
          'adoption_traffic',
          trafficQuery,
        );
        const errors = await this.executeInstantQuery(
          'adoption_errors',
          errorQuery,
        );

        const adoption: EndpointAdoption = {
          endpoint,
          first_traffic_at:
            traffic.value !== null && traffic.value > 0
              ? deployDate.toISOString()
              : null,
          current_rps: traffic.value ?? 0,
          error_rate: errors.value ?? 0,
        };

        // Step 5: Compare to similar endpoints (same service, similar path)
        const similarEndpoint = findSimilarEndpoint(endpoint, service);
        if (similarEndpoint) {
          const similarTraffic = await this.executeInstantQuery(
            'similar_traffic',
            buildTrafficQuery(service.prometheus_job, similarEndpoint),
          );
          const similarErrors = await this.executeInstantQuery(
            'similar_errors',
            buildErrorRateQuery(service.prometheus_job, similarEndpoint),
          );
          adoption.comparison = {
            similar_endpoint: similarEndpoint,
            similar_endpoint_rps: similarTraffic.value ?? 0,
            similar_endpoint_error_rate: similarErrors.value ?? 0,
            traffic_ratio:
              similarTraffic.value !== null && similarTraffic.value > 0
                ? (traffic.value ?? 0) / similarTraffic.value
                : 0,
          };
        }

        results.push(adoption);
      }
    }

    if (results.length === 0) {
      return null;
    }

    // Use the most recent annotation for deploy_info
    const latestAnnotation = annotations.annotations[0];
    const latestDeployDate = new Date(latestAnnotation.time);

    return {
      detected: true,
      deploy_info: {
        commit:
          latestAnnotation.text.match(/commit[:\s]+([a-f0-9]+)/i)?.[1] ??
          'unknown',
        deployed_at: latestAnnotation.time,
        days_since_deploy:
          (Date.now() - latestDeployDate.getTime()) /
          (24 * 60 * 60 * 1000),
      },
      endpoints: results,
    };
  }
}
