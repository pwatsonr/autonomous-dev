/**
 * MCP server connectivity probe and status recording.
 *
 * At the start of every observation run (lifecycle step 1d), each configured
 * MCP server is probed with a lightweight call. The results determine which
 * data sources participate in the run.
 *
 * Based on SPEC-007-1-2, Task 4.
 */

import {
  ConnectivityResult,
  ConnectivityReport,
  DataSourceStatus,
  PROBE_HARD_TIMEOUT_MS,
  PROBE_DEGRADED_THRESHOLD_MS,
} from './types';

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

/**
 * Returns a promise that rejects after `ms` milliseconds with a timeout error.
 */
function timeout(ms: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Probe timed out after ${ms}ms`)), ms);
  });
}

// ---------------------------------------------------------------------------
// Probe function
// ---------------------------------------------------------------------------

/**
 * Probes a single data source by executing `probeCall` and racing it against
 * the hard timeout.
 *
 * Classification:
 *   - Response <= 5 000 ms  -> `available`
 *   - Response > 5 000 ms but < 30 000 ms -> `degraded`
 *   - Timeout or error      -> `unreachable`
 *
 * @param source  Canonical source name (e.g. "prometheus").
 * @param probeCall  Async function that performs the lightweight MCP probe.
 * @param hardTimeoutMs  Override for the hard timeout (default 30 000 ms).
 * @returns A ConnectivityResult describing the source's health.
 */
export async function probeSource(
  source: string,
  probeCall: () => Promise<unknown>,
  hardTimeoutMs: number = PROBE_HARD_TIMEOUT_MS,
): Promise<ConnectivityResult> {
  const start = Date.now();
  try {
    await Promise.race([probeCall(), timeout(hardTimeoutMs)]);
    const elapsed = Date.now() - start;
    const status: DataSourceStatus =
      elapsed > PROBE_DEGRADED_THRESHOLD_MS ? 'degraded' : 'available';
    return {
      source,
      status,
      response_time_ms: elapsed,
    };
  } catch (error) {
    return {
      source,
      status: 'unreachable',
      response_time_ms: null,
      error: String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Probe definitions per source
// ---------------------------------------------------------------------------

/** A descriptor that pairs a source name with the MCP call used to probe it. */
export interface ProbeDescriptor {
  /** Canonical source name. */
  source: string;
  /**
   * Factory that returns the probe promise.
   * The caller must supply implementations that invoke the actual MCP tool.
   */
  probeCall: () => Promise<unknown>;
}

/**
 * Builds the default set of probe descriptors from caller-supplied MCP
 * tool wrappers.
 *
 * Probe calls per source (from the spec):
 *   - Prometheus: `prometheus_query({ query: 'up' })`
 *   - Grafana:    `grafana_list_alerts({ state: 'all', limit: 1 })`
 *   - OpenSearch:  `opensearch_search({ index: '_cat/health', size: 0 })`
 *   - Sentry:     `sentry_list_issues({ project, limit: 1 })`
 *
 * @param mcpCalls  Object whose keys are source names and values are the
 *                  async probe functions.  Sources not present in this map
 *                  will be marked `not_configured`.
 * @param allSources  The full list of recognised source names.
 * @returns Array of ProbeDescriptors for every source in `allSources`.
 */
export function buildProbeDescriptors(
  mcpCalls: Record<string, () => Promise<unknown>>,
  allSources: string[] = ['prometheus', 'grafana', 'opensearch', 'sentry'],
): ProbeDescriptor[] {
  return allSources.map((source) => ({
    source,
    probeCall: mcpCalls[source] ?? (() => Promise.reject(new Error('not_configured'))),
  }));
}

// ---------------------------------------------------------------------------
// Full connectivity check
// ---------------------------------------------------------------------------

/**
 * Probes all configured MCP servers and produces a {@link ConnectivityReport}.
 *
 * Sources whose probe call is missing from `mcpCalls` are immediately
 * classified as `not_configured` without executing a network call.
 *
 * If every *configured* (non-`not_configured`) source is `unreachable` the
 * report's `all_unreachable` flag is set to `true`, signalling that the run
 * should abort.
 *
 * @param mcpCalls  Source-name-keyed map of async probe functions.
 * @param allSources  Recognised source names (defaults to the four canonical
 *                    sources).
 * @param hardTimeoutMs  Per-probe hard timeout override.
 * @returns A ConnectivityReport ready for inclusion in run metadata.
 */
export async function checkConnectivity(
  mcpCalls: Record<string, () => Promise<unknown>>,
  allSources: string[] = ['prometheus', 'grafana', 'opensearch', 'sentry'],
  hardTimeoutMs: number = PROBE_HARD_TIMEOUT_MS,
): Promise<ConnectivityReport> {
  const results: ConnectivityResult[] = await Promise.all(
    allSources.map(async (source) => {
      // If the source is not in the mcpCalls map it is not configured.
      if (!(source in mcpCalls)) {
        return {
          source,
          status: 'not_configured' as const,
          response_time_ms: null,
        };
      }
      return probeSource(source, mcpCalls[source], hardTimeoutMs);
    }),
  );

  // Determine abort condition: all *configured* sources are unreachable.
  const configuredResults = results.filter((r) => r.status !== 'not_configured');
  const allUnreachable =
    configuredResults.length > 0 &&
    configuredResults.every((r) => r.status === 'unreachable');

  return {
    results,
    all_unreachable: allUnreachable,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers for downstream consumers
// ---------------------------------------------------------------------------

/**
 * Returns the subset of sources that are eligible for data collection
 * (status is `available` or `degraded`).
 */
export function getEligibleSources(report: ConnectivityReport): ConnectivityResult[] {
  return report.results.filter(
    (r) => r.status === 'available' || r.status === 'degraded',
  );
}

/**
 * Returns the subset of sources classified as `degraded`.
 */
export function getDegradedSources(report: ConnectivityReport): ConnectivityResult[] {
  return report.results.filter((r) => r.status === 'degraded');
}

/**
 * Returns the subset of sources classified as `unreachable`.
 */
export function getUnreachableSources(report: ConnectivityReport): ConnectivityResult[] {
  return report.results.filter((r) => r.status === 'unreachable');
}
