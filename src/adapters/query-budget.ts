/**
 * Per-source per-service query budget counter with timeout enforcement.
 *
 * The QueryBudgetTracker wraps every MCP query call. It enforces per-source
 * per-service limits from intelligence.yaml and per-query timeouts.
 *
 * Based on SPEC-007-1-2, Task 5.
 */

import {
  BudgetState,
  QueryBudgetConfig,
  DEFAULT_BUDGETS,
  DataSourceName,
  QueryBudgetTracker as IQueryBudgetTracker,
} from './types';

// ---------------------------------------------------------------------------
// Logger interface (dependency-injected to avoid hard coupling)
// ---------------------------------------------------------------------------

/** Minimal logging contract so the budget tracker can emit warnings. */
export interface BudgetLogger {
  warn(message: string): void;
}

/** No-op logger used when no logger is supplied. */
const NOOP_LOGGER: BudgetLogger = { warn: () => {} };

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

/**
 * Returns a promise that rejects after `ms` milliseconds.
 */
function timeout(ms: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Query timed out after ${ms}ms`)), ms);
  });
}

// ---------------------------------------------------------------------------
// QueryBudgetTracker
// ---------------------------------------------------------------------------

/**
 * Tracks and enforces per-source per-service query budgets.
 *
 * This is the full-featured implementation used by the observation runner.
 * It implements the `IQueryBudgetTracker` interface from `types.ts` so that
 * individual data-source adapters can consume it without depending on the
 * concrete class.
 *
 * Usage:
 * ```ts
 * const tracker = new QueryBudgetEnforcer(budgets, logger);
 *
 * if (tracker.canQuery('prometheus', 'my-api')) {
 *   const result = await tracker.executeQuery('prometheus', 'my-api', () =>
 *     prometheusQuery({ query: 'up{service="my-api"}' }),
 *   );
 * }
 * ```
 */
export class QueryBudgetEnforcer implements IQueryBudgetTracker {
  /**
   * Nested map: source -> (service -> executed count).
   * @internal
   */
  private counts: Map<string, Map<string, number>> = new Map();

  /**
   * Nested map: source -> (service -> blocked count).
   * @internal
   */
  private blocked: Map<string, Map<string, number>> = new Map();

  private readonly logger: BudgetLogger;

  /**
   * @param budgets  Per-source budget configuration.  Defaults to the
   *                 canonical budgets from TDD section 3.1.4.
   * @param logger   Optional logger for warning messages.
   */
  constructor(
    private readonly budgets: Record<string, QueryBudgetConfig> = DEFAULT_BUDGETS,
    logger?: BudgetLogger,
  ) {
    this.logger = logger ?? NOOP_LOGGER;
  }

  // -----------------------------------------------------------------------
  // Core budget API
  // -----------------------------------------------------------------------

  /**
   * Returns `true` if the budget for `source`/`service` has not been
   * exhausted, i.e. the executed count is below the configured maximum.
   *
   * Returns `false` when:
   *   - The source has no budget configuration.
   *   - The per-service limit has been reached.
   */
  canQuery(source: string, service: string): boolean {
    const budget = this.budgets[source];
    if (!budget) return false;
    const current = this.getCount(source, service);
    return current < budget.max_queries_per_service;
  }

  /**
   * Increments the executed-query counter for the given source/service pair.
   */
  recordQuery(source: string, service: string): void {
    if (!this.counts.has(source)) {
      this.counts.set(source, new Map());
    }
    const serviceMap = this.counts.get(source)!;
    serviceMap.set(service, (serviceMap.get(service) ?? 0) + 1);
  }

  /**
   * Increments the blocked-query counter for the given source/service pair.
   */
  recordBlocked(source: string, service: string): void {
    if (!this.blocked.has(source)) {
      this.blocked.set(source, new Map());
    }
    const serviceMap = this.blocked.get(source)!;
    serviceMap.set(service, (serviceMap.get(service) ?? 0) + 1);
  }

  /**
   * Returns the timeout (in milliseconds) configured for the given source.
   * Falls back to 30 000 ms when the source has no explicit configuration.
   */
  getTimeoutMs(source: string): number {
    return (this.budgets[source]?.timeout_seconds ?? 30) * 1000;
  }

  /**
   * Returns the number of remaining queries allowed for this source/service.
   * Returns 0 if the source has no budget configuration.
   */
  remaining(source: string, service: string): number {
    const budget = this.budgets[source];
    if (!budget) return 0;
    const used = this.getCount(source, service);
    return Math.max(0, budget.max_queries_per_service - used);
  }

  // -----------------------------------------------------------------------
  // Query execution with budget + timeout enforcement
  // -----------------------------------------------------------------------

  /**
   * Executes a query call if the budget allows, enforcing the per-source
   * timeout via `Promise.race`.
   *
   * If the budget is exhausted a warning is logged, the blocked counter is
   * incremented, and `null` is returned without executing the call.
   *
   * @param source   Canonical source name (e.g. "prometheus").
   * @param service  Service identifier within the source.
   * @param queryCall  Async function that performs the actual MCP query.
   * @returns The query result, or `null` if the budget was exhausted.
   * @throws Re-throws errors from `queryCall` (including timeouts) so they
   *         can be handled by the MCP error handling layer (SPEC-007-1-4).
   */
  async executeQuery<T>(
    source: string,
    service: string,
    queryCall: () => Promise<T>,
  ): Promise<T | null> {
    if (!this.canQuery(source, service)) {
      const budget = this.budgets[source];
      const current = this.getCount(source, service);
      const max = budget?.max_queries_per_service ?? 0;
      this.logger.warn(
        `Query budget exhausted for ${source}/${service} (${current}/${max})`,
      );
      this.recordBlocked(source, service);
      return null;
    }

    const timeoutMs = this.getTimeoutMs(source);
    this.recordQuery(source, service);

    // Enforce per-query timeout.
    return Promise.race([queryCall(), timeout(timeoutMs)]);
  }

  // -----------------------------------------------------------------------
  // State inspection
  // -----------------------------------------------------------------------

  /**
   * Returns the current executed-query count for a source/service pair.
   */
  getCount(source: string, service: string): number {
    return this.counts.get(source)?.get(service) ?? 0;
  }

  /**
   * Returns the current blocked-query count for a source/service pair.
   */
  getBlockedCount(source: string, service: string): number {
    return this.blocked.get(source)?.get(service) ?? 0;
  }

  /**
   * Returns the full budget state for all source/service combinations that
   * have been touched during this run.
   *
   * This snapshot is intended for inclusion in run metadata at finalization.
   */
  getState(): BudgetState[] {
    const states: BudgetState[] = [];

    // Collect all source/service pairs from both maps.
    const allSources = new Set([...this.counts.keys(), ...this.blocked.keys()]);

    for (const source of allSources) {
      const executedMap = this.counts.get(source) ?? new Map<string, number>();
      const blockedMap = this.blocked.get(source) ?? new Map<string, number>();
      const allServices = new Set([...executedMap.keys(), ...blockedMap.keys()]);

      for (const service of allServices) {
        const queriesExecuted = executedMap.get(service) ?? 0;
        const queriesBlocked = blockedMap.get(service) ?? 0;
        const budget = this.budgets[source];
        const budgetExhausted = budget
          ? queriesExecuted >= budget.max_queries_per_service
          : true;

        states.push({
          source,
          service,
          queries_executed: queriesExecuted,
          queries_blocked: queriesBlocked,
          budget_exhausted: budgetExhausted,
        });
      }
    }

    return states;
  }

  /**
   * Resets all counters. Useful between runs when the tracker is reused.
   */
  reset(): void {
    this.counts.clear();
    this.blocked.clear();
  }
}
