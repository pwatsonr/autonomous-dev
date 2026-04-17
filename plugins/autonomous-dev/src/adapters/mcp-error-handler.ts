/**
 * MCP error handling with retry logic and graceful degradation
 * (SPEC-007-1-4, Task 10).
 *
 * Wraps all MCP adapter calls with:
 *   - Configurable timeout per query
 *   - Exactly 1 retry after a 10-second delay on first failure
 *   - Graceful degradation: returns null on second failure (caller handles partial data)
 *
 * Error handling behaviors:
 *   | Failure                  | Behavior                                                     |
 *   |--------------------------|--------------------------------------------------------------|
 *   | Mid-query timeout        | Retry once after 10s. Second failure returns null              |
 *   | Error response (4xx/5xx) | Log error code, skip query, continue with remaining            |
 *   | All sources unavailable  | Abort run cleanly with critical log entry                      |
 *   | Partial data collection  | Proceed with available data; note gaps in observation sources  |
 */

import type { AuditLogger } from '../runner/audit-logger';

/** Policy controlling retry behavior for MCP calls. */
export interface McpErrorPolicy {
  /** Maximum number of retries after initial failure (default: 1). */
  max_retries: number;
  /** Delay between retries in milliseconds (default: 10_000). */
  retry_delay_ms: number;
  /** Timeout for each individual attempt in milliseconds. */
  timeout_ms: number;
}

/** Contextual information about the MCP operation being performed. */
export interface McpOperationContext {
  /** The data source name (e.g. "prometheus", "grafana", "opensearch"). */
  source: string;
  /** A description of the query being executed. */
  query: string;
  /** The service name the query pertains to. */
  service: string;
}

/** Default policy values aligned with TDD section 6.1. */
export const DEFAULT_MCP_ERROR_POLICY: McpErrorPolicy = {
  max_retries: 1,
  retry_delay_ms: 10_000,
  timeout_ms: 30_000,
};

/**
 * Creates a promise that rejects after the specified timeout.
 *
 * @param ms Timeout in milliseconds
 * @returns A promise that rejects with a timeout error
 */
export function rejectAfter(ms: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
  });
}

/**
 * Returns a promise that resolves after the specified delay.
 *
 * @param ms Delay in milliseconds
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps an MCP adapter call with retry and graceful degradation logic.
 *
 * On first failure:
 *   - Logs a warning
 *   - Waits retry_delay_ms (10 seconds by default)
 *   - Retries the operation exactly once
 *
 * On second failure:
 *   - Logs an error
 *   - Returns null (caller proceeds with partial data)
 *
 * @param operation The async MCP operation to execute
 * @param policy Retry and timeout configuration
 * @param context Contextual info for log messages
 * @param auditLog The audit logger instance
 * @param delayFn Injectable delay function for testing (defaults to real delay)
 * @returns The operation result, or null if both attempts failed
 */
export async function withMcpRetry<T>(
  operation: () => Promise<T>,
  policy: McpErrorPolicy,
  context: McpOperationContext,
  auditLog: AuditLogger,
  delayFn: (ms: number) => Promise<void> = delay,
): Promise<T | null> {
  // First attempt
  try {
    return await Promise.race([operation(), rejectAfter(policy.timeout_ms)]);
  } catch (firstError) {
    const firstMsg =
      firstError instanceof Error ? firstError.message : String(firstError);

    auditLog.warn(
      `MCP ${context.source} query failed for ${context.service}: ${firstMsg}. ` +
        `Retrying in ${policy.retry_delay_ms}ms...`,
    );

    // Wait before retry
    await delayFn(policy.retry_delay_ms);

    // Retry attempt
    try {
      return await Promise.race([operation(), rejectAfter(policy.timeout_ms)]);
    } catch (secondError) {
      const secondMsg =
        secondError instanceof Error ? secondError.message : String(secondError);

      auditLog.error(
        `MCP ${context.source} retry failed for ${context.service}: ${secondMsg}. ` +
          `Skipping query: ${context.query}`,
      );

      return null; // Graceful degradation
    }
  }
}

/**
 * Result of a connectivity check for a single data source.
 */
export type DataSourceStatus = 'available' | 'degraded' | 'unreachable' | 'not_configured';

/**
 * Aggregate connectivity check results.
 */
export interface ConnectivityResult {
  /** Per-source status. */
  results: Record<string, DataSourceStatus>;
  /** True if every configured source is unreachable. */
  all_unreachable: boolean;
}

/**
 * Validates connectivity to all configured MCP data sources.
 *
 * This is a lightweight probe -- it does not execute real queries,
 * just verifies that the MCP servers are reachable.
 *
 * @param healthChecks A map of source name to health-check function.
 *                     Each function should resolve if the source is reachable,
 *                     or reject/return a degraded status.
 * @returns Aggregated connectivity results
 */
export async function validateConnectivity(
  healthChecks: Record<string, () => Promise<DataSourceStatus>>,
): Promise<ConnectivityResult> {
  const results: Record<string, DataSourceStatus> = {};

  for (const [source, checkFn] of Object.entries(healthChecks)) {
    try {
      results[source] = await checkFn();
    } catch {
      results[source] = 'unreachable';
    }
  }

  const configuredSources = Object.entries(results).filter(
    ([, status]) => status !== 'not_configured',
  );

  const all_unreachable =
    configuredSources.length > 0 &&
    configuredSources.every(([, status]) => status === 'unreachable');

  return { results, all_unreachable };
}
