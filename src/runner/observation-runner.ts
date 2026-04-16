/**
 * Main runner lifecycle orchestrator (SPEC-007-1-4, Task 9; SPEC-007-2-3, Task 7;
 * SPEC-007-5-3, Task 5 -- governance integration;
 * SPEC-007-5-5, Task 9 -- Sentry MCP integration).
 *
 * Implements the 4-phase observation lifecycle from TDD section 3.2.2:
 *   1. INITIALIZE  -- generate run ID, load config, bootstrap dirs, validate connectivity
 *   2. TRIAGE + EFFECTIVENESS -- process pending triage, evaluate effectiveness for eligible observations
 *   3. SERVICE LOOP -- for each service: acquire lock, collect, **scrub**, analyze, enrich (Sentry), dedup, govern, report
 *   4. FINALIZE    -- build metadata, write audit log, close
 *
 * Services are processed sequentially within a single session to stay
 * within the 200K token budget (NFR-005).
 *
 * CRITICAL INVARIANT (SPEC-007-2-3): The scrub step between data collection
 * and analysis is NOT bypassable via configuration. `scrubCollectedData()`
 * is called unconditionally. If scrubbing fails, affected data is replaced
 * with `[SCRUB_FAILED:...]` -- raw text is NEVER passed through.
 */

import * as path from 'path';
import { generateRunId } from './run-id';
import { AuditLogger } from './audit-logger';
import { LockManager } from './lock-manager';
import type { LockManagerOptions } from './lock-manager';
import { bootstrapDirectories } from './directory-bootstrap';
import { loadConfig } from '../config/intelligence-config';
import type { IntelligenceConfig, ServiceConfig, QueryBudgetConfig } from '../config/intelligence-config.schema';
import {
  runEffectivenessEvaluations,
  applyGovernanceChecks as applyGovernanceChecksImpl,
  type EffectivenessRunSummary,
  type GovernanceFlags,
} from './governance-integration';
import type { DeploymentInfo, PrometheusClient } from '../governance/types';
import {
  validateConnectivity,
  type ConnectivityResult,
  type DataSourceStatus,
} from '../adapters/mcp-error-handler';
import {
  scrubCollectedData as scrubPipeline,
  buildSafetyConfig,
  type CollectedData as ScrubCollectedDataInput,
} from '../safety/scrub-pipeline';
import type { SentryAdapter } from '../adapters/sentry-adapter';
import { enrichWithSentry } from '../adapters/sentry-enrichment';
import type { SentryEnrichment } from '../adapters/sentry-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Metadata produced by a completed (or aborted) observation run.
 */
export interface RunMetadata {
  run_id: string;
  started_at: string;       // ISO 8601
  completed_at: string;     // ISO 8601
  services_in_scope: string[];
  data_source_status: Record<string, DataSourceStatus>;
  observations_generated: number;
  observations_deduplicated: number;
  observations_filtered: number;
  triage_decisions_processed: number;
  total_tokens_consumed: number;
  queries_executed: Record<string, number>;
  errors: string[];
}

/**
 * A candidate observation produced by the analysis step.
 * Placeholder interface -- the full shape is defined in PLAN-007-3.
 */
export interface CandidateObservation {
  id: string;
  service: string;
  severity: string;
  summary: string;
  data_sources: string[];
  tokens_consumed: number;
  error_class?: string;
  governanceFlags?: GovernanceFlags;
  /** Sentry enrichment data (SPEC-007-5-5). */
  sentryEnrichment?: SentryEnrichment;
}

/**
 * Raw data collected from MCP sources for a single service.
 * Placeholder interface -- adapters fill in the actual fields.
 */
export interface CollectedData {
  service: string;
  prometheus: unknown[];
  grafana: unknown[];
  opensearch: unknown[];
  sentry: unknown[];
  query_counts: Record<string, number>;
  tokens_consumed: number;
}

/**
 * Tracks query counts and budget limits per data source.
 */
export class QueryBudgetTracker {
  private counts: Record<string, number> = {};
  private readonly budgets: QueryBudgetConfig;

  constructor(budgets: QueryBudgetConfig) {
    this.budgets = budgets;
    this.counts = {
      prometheus: 0,
      grafana: 0,
      opensearch: 0,
      sentry: 0,
    };
  }

  /**
   * Records queries executed for a source.
   */
  record(source: string, count: number): void {
    this.counts[source] = (this.counts[source] ?? 0) + count;
  }

  /**
   * Returns the current query counts.
   */
  getCounts(): Record<string, number> {
    return { ...this.counts };
  }

  /**
   * Checks whether a source has remaining budget for a given service.
   */
  hasRemaining(source: string, perServiceLimit: number): boolean {
    return (this.counts[source] ?? 0) < perServiceLimit;
  }
}

// ---------------------------------------------------------------------------
// Delegate type definitions (for dependency injection)
// ---------------------------------------------------------------------------

/**
 * Function type for processing pending triage decisions.
 * Delegates to PLAN-007-4 triage processor.
 */
export type ProcessPendingTriageFn = (config: IntelligenceConfig) => Promise<number>;

/**
 * Function type for collecting data from MCP sources for a service.
 */
export type CollectDataFn = (
  service: ServiceConfig,
  connectivity: ConnectivityResult,
  budget: QueryBudgetTracker,
) => Promise<CollectedData>;

/**
 * Function type for scrubbing collected data (delegates to PLAN-007-2).
 *
 * NOTE (SPEC-007-2-3): The real scrub pipeline is called unconditionally
 * by the runner BEFORE this delegate. This delegate is for additional
 * post-scrub processing only. It cannot bypass the mandatory scrub step.
 */
export type ScrubCollectedDataFn = (data: CollectedData) => Promise<CollectedData>;

/**
 * Function type for analyzing data and producing candidates (delegates to PLAN-007-3).
 */
export type AnalyzeDataFn = (
  data: CollectedData,
  service: ServiceConfig,
  config: IntelligenceConfig,
) => Promise<CandidateObservation[]>;

/**
 * Function type for deduplicating candidate observations (delegates to PLAN-007-3).
 */
export type DeduplicateCandidatesFn = (
  candidates: CandidateObservation[],
  service: ServiceConfig,
) => Promise<CandidateObservation[]>;

/**
 * Function type for applying governance checks (delegates to PLAN-007-5).
 */
export type ApplyGovernanceChecksFn = (
  candidates: CandidateObservation[],
  service: ServiceConfig,
  config: IntelligenceConfig,
) => Promise<CandidateObservation[]>;

/**
 * Function type for generating reports (delegates to PLAN-007-4).
 */
export type GenerateReportsFn = (
  observations: CandidateObservation[],
  service: ServiceConfig,
  runId: string,
) => Promise<void>;

/**
 * Function type for providing health checks for connectivity validation.
 */
export type HealthCheckProviderFn = (
  config: IntelligenceConfig,
) => Record<string, () => Promise<DataSourceStatus>>;

// ---------------------------------------------------------------------------
// Runner configuration
// ---------------------------------------------------------------------------

/**
 * Function type for reading deployment metadata by deployment ID.
 * Used by effectiveness evaluations (SPEC-007-5-3).
 */
export type ReadDeploymentMetadataFn = (id: string) => DeploymentInfo | null;

/**
 * Function type for providing a Prometheus client.
 * Used by effectiveness evaluations (SPEC-007-5-3).
 */
export type PrometheusClientProvider = () => PrometheusClient;

export interface ObservationRunnerOptions {
  /** The project root directory. */
  rootDir: string;
  /** Absolute path to the intelligence.yaml config file. */
  configPath: string;
  /** Optional override for lock manager options. */
  lockManagerOptions?: LockManagerOptions;
  /** Optional override for run ID (mainly for testing). */
  overrideRunId?: string;

  // Delegates -- all injectable for testing
  processPendingTriage?: ProcessPendingTriageFn;
  collectData?: CollectDataFn;
  scrubCollectedData?: ScrubCollectedDataFn;
  analyzeData?: AnalyzeDataFn;
  deduplicateCandidates?: DeduplicateCandidatesFn;
  applyGovernanceChecks?: ApplyGovernanceChecksFn;
  generateReports?: GenerateReportsFn;
  healthCheckProvider?: HealthCheckProviderFn;

  // Governance integration delegates (SPEC-007-5-3)
  readDeploymentMetadata?: ReadDeploymentMetadataFn;
  prometheusClient?: PrometheusClientProvider;

  // Sentry integration (SPEC-007-5-5)
  /** Optional Sentry adapter instance. When provided, candidates are enriched with Sentry data. */
  sentryAdapter?: SentryAdapter;
}

// ---------------------------------------------------------------------------
// Default no-op delegates (real implementations provided by other plans)
// ---------------------------------------------------------------------------

const noopProcessPendingTriage: ProcessPendingTriageFn = async () => 0;

const noopCollectData: CollectDataFn = async (service) => ({
  service: service.name,
  prometheus: [],
  grafana: [],
  opensearch: [],
  sentry: [],
  query_counts: {},
  tokens_consumed: 0,
});

const noopScrubCollectedData: ScrubCollectedDataFn = async (data) => data;

const noopAnalyzeData: AnalyzeDataFn = async () => [];

const noopDeduplicateCandidates: DeduplicateCandidatesFn = async (c) => c;

const noopApplyGovernanceChecks: ApplyGovernanceChecksFn = async (c) => c;

const noopGenerateReports: GenerateReportsFn = async () => {};

const noopHealthCheckProvider: HealthCheckProviderFn = () => ({});

const noopReadDeploymentMetadata: ReadDeploymentMetadataFn = () => null;

const noopPrometheusClient: PrometheusClientProvider = () => ({
  queryRangeAverage: async () => null,
});

// ---------------------------------------------------------------------------
// ObservationRunner
// ---------------------------------------------------------------------------

export class ObservationRunner {
  private readonly rootDir: string;
  private readonly configPath: string;
  private readonly lockManager: LockManager;
  private readonly overrideRunId?: string;

  // Delegate functions
  private readonly processPendingTriage: ProcessPendingTriageFn;
  private readonly collectData: CollectDataFn;
  private readonly scrubCollectedData: ScrubCollectedDataFn;
  private readonly analyzeData: AnalyzeDataFn;
  private readonly deduplicateCandidates: DeduplicateCandidatesFn;
  private readonly applyGovernanceChecks: ApplyGovernanceChecksFn;
  private readonly generateReports: GenerateReportsFn;
  private readonly healthCheckProvider: HealthCheckProviderFn;
  private readonly readDeploymentMetadata: ReadDeploymentMetadataFn;
  private readonly prometheusClient: PrometheusClientProvider;
  private readonly sentryAdapter?: SentryAdapter;

  constructor(options: ObservationRunnerOptions) {
    this.rootDir = options.rootDir;
    this.configPath = options.configPath;
    this.overrideRunId = options.overrideRunId;

    const lockDir = path.join(options.rootDir, '.autonomous-dev/observations');
    this.lockManager = new LockManager(lockDir, options.lockManagerOptions);

    this.processPendingTriage = options.processPendingTriage ?? noopProcessPendingTriage;
    this.collectData = options.collectData ?? noopCollectData;
    this.scrubCollectedData = options.scrubCollectedData ?? noopScrubCollectedData;
    this.analyzeData = options.analyzeData ?? noopAnalyzeData;
    this.deduplicateCandidates = options.deduplicateCandidates ?? noopDeduplicateCandidates;
    this.applyGovernanceChecks = options.applyGovernanceChecks ?? noopApplyGovernanceChecks;
    this.generateReports = options.generateReports ?? noopGenerateReports;
    this.healthCheckProvider = options.healthCheckProvider ?? noopHealthCheckProvider;
    this.readDeploymentMetadata = options.readDeploymentMetadata ?? noopReadDeploymentMetadata;
    this.prometheusClient = options.prometheusClient ?? noopPrometheusClient;
    this.sentryAdapter = options.sentryAdapter;
  }

  /**
   * Exposes the lock manager for external use (e.g. stale lock cleanup).
   */
  getLockManager(): LockManager {
    return this.lockManager;
  }

  /**
   * Executes the full observation lifecycle.
   *
   * @param scope A specific service name, or "all" to process every configured service
   * @returns Run metadata including counts, errors, and timing
   */
  async run(scope: string | 'all'): Promise<RunMetadata> {
    const errors: string[] = [];
    const startedAt = new Date().toISOString();

    // -----------------------------------------------------------------------
    // 1. INITIALIZE
    // -----------------------------------------------------------------------
    const runId = this.overrideRunId ?? generateRunId();
    const logDir = path.join(this.rootDir, '.autonomous-dev/logs/intelligence');
    const auditLog = new AuditLogger(runId, logDir);

    auditLog.info(`Run ${runId} started`);

    // Load config
    let config: IntelligenceConfig;
    try {
      config = await loadConfig(this.configPath);
      auditLog.info(`Config loaded: ${config.services.length} services in scope`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      auditLog.critical(`Failed to load config: ${msg}`);
      await auditLog.close();
      return this.abortedRunMetadata(runId, startedAt, {}, [], msg);
    }

    // Bootstrap directories
    await bootstrapDirectories(this.rootDir);

    // Clean stale locks before starting
    const cleanedLocks = await this.lockManager.cleanStaleLocks();
    if (cleanedLocks.length > 0) {
      auditLog.info(`Cleaned ${cleanedLocks.length} stale lock(s): ${cleanedLocks.join(', ')}`);
    }

    // Validate connectivity
    const healthChecks = this.healthCheckProvider(config);
    const connectivity = await validateConnectivity(healthChecks);

    if (connectivity.all_unreachable) {
      auditLog.critical('All MCP servers unreachable. Aborting run.');
      await auditLog.close();
      return this.abortedRunMetadata(
        runId,
        startedAt,
        connectivity.results,
        config.services.map((s) => s.name),
        'All MCP servers unreachable',
      );
    }

    auditLog.info(`Connectivity: ${JSON.stringify(connectivity.results)}`);

    // -----------------------------------------------------------------------
    // 2. PROCESS PENDING TRIAGE
    // -----------------------------------------------------------------------
    let triageCount = 0;
    try {
      triageCount = await this.processPendingTriage(config);
      if (triageCount > 0) {
        auditLog.info(`Processed ${triageCount} pending triage decisions`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      auditLog.warn(`Triage processing failed: ${msg}`);
      errors.push(`Triage: ${msg}`);
    }

    // -----------------------------------------------------------------------
    // 2b. EFFECTIVENESS EVALUATIONS (SPEC-007-5-3, Task 5 -- Point A)
    // -----------------------------------------------------------------------
    let effectivenessSummary: EffectivenessRunSummary | null = null;
    try {
      effectivenessSummary = await runEffectivenessEvaluations(
        this.rootDir,
        config.governance,
        (id) => this.readDeploymentMetadata(id),
        this.prometheusClient(),
        auditLog,
      );
      auditLog.info(`Effectiveness evaluations: ${JSON.stringify(effectivenessSummary)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      auditLog.warn(`Effectiveness evaluation failed: ${msg}`);
      errors.push(`Effectiveness: ${msg}`);
    }

    // -----------------------------------------------------------------------
    // 3. FOR EACH SERVICE IN SCOPE
    // -----------------------------------------------------------------------
    const services =
      scope === 'all'
        ? config.services
        : config.services.filter((s) => s.name === scope);

    const budget = new QueryBudgetTracker(config.query_budgets);

    // Reset Sentry adapter budget at the start of each run (SPEC-007-5-5, AC-10)
    if (this.sentryAdapter) {
      this.sentryAdapter.resetBudget();
    }

    const allObservations: CandidateObservation[] = [];
    let totalTokens = 0;
    let totalDeduped = 0;
    let totalFiltered = 0;

    for (const service of services) {
      auditLog.info(`Service ${service.name}: acquiring lock...`);

      // 3a. Acquire lock
      const lockAcquired = await this.lockManager.acquire(service.name);
      if (!lockAcquired) {
        auditLog.warn(`Skipping ${service.name}: lock held by another session`);
        errors.push(`Lock conflict: ${service.name}`);
        continue;
      }

      try {
        // 3a. DATA COLLECTION
        auditLog.info(`Service ${service.name}: collecting data...`);
        const rawData = await this.collectData(service, connectivity, budget);

        // Record query counts
        for (const [source, count] of Object.entries(rawData.query_counts)) {
          budget.record(source, count);
        }
        totalTokens += rawData.tokens_consumed;

        const querySummary = Object.entries(rawData.query_counts)
          .map(([src, cnt]) => `${cnt} ${src} queries`)
          .join(', ');
        if (querySummary) {
          auditLog.info(`Service ${service.name}: ${querySummary}`);
        }

        // 3b. DATA SAFETY -- MANDATORY scrub step (SPEC-007-2-3)
        //     This step is NOT bypassable. Raw production text never
        //     reaches analysis without passing through scrub().
        let scrubbedData: CollectedData;
        try {
          const safetyCfg = buildSafetyConfig();
          const scrubInput: ScrubCollectedDataInput = {
            prometheus: rawData.prometheus as any[],
            opensearch: rawData.opensearch as any[],
            grafana: rawData.grafana as any ?? { alerts: {}, annotations: { annotations: [] } },
          };
          const scrubResult = await scrubPipeline(scrubInput, safetyCfg, {
            runId,
            service: service.name,
          });
          // Merge scrubbed fields back into the CollectedData shape
          scrubbedData = {
            ...rawData,
            prometheus: scrubResult.prometheus as unknown[],
            opensearch: scrubResult.opensearch as unknown[],
            grafana: scrubResult.grafana as unknown[],
          };
          if (scrubResult.scrubAuditEntries.length > 0) {
            auditLog.info(
              `Service ${service.name}: scrubbed ${scrubResult.scrubAuditEntries.length} field(s)`,
            );
          }
        } catch (scrubErr) {
          // Scrub failure: replace ALL text data with failure tokens
          const msg = scrubErr instanceof Error ? scrubErr.message : String(scrubErr);
          auditLog.error(`Service ${service.name}: scrub pipeline failed: ${msg}`);
          scrubbedData = {
            ...rawData,
            prometheus: [],
            opensearch: [],
            grafana: [],
          };
        }

        // Optional post-scrub delegate (for additional custom processing)
        scrubbedData = await this.scrubCollectedData(scrubbedData);

        // 3c. ANALYSIS (delegates to PLAN-007-3 intelligence engine)
        const candidates = await this.analyzeData(scrubbedData, service, config);

        // 3c.v. SENTRY ENRICHMENT (SPEC-007-5-5, Task 9 -- Phase 3)
        //       Enrich candidates with Sentry error issues, stack traces,
        //       and release health data when the adapter is available.
        if (this.sentryAdapter) {
          const sentryConnectivity = connectivity.results.find(
            (r: ConnectivityResult) => r.source === 'sentry',
          );
          const sentryStatus = sentryConnectivity?.status ?? 'not_configured';

          if (sentryStatus === 'available' || sentryStatus === 'degraded') {
            for (const candidate of candidates) {
              try {
                const sentryData = await enrichWithSentry(
                  this.sentryAdapter,
                  service.name,
                  candidate.error_class ?? candidate.id,
                  (service as Record<string, unknown>).release_version as string | undefined,
                  5,
                  service.name,
                );
                candidate.sentryEnrichment = sentryData;
                if (sentryData.issues.length > 0) {
                  auditLog.info(
                    `Sentry enrichment for ${service.name}/${candidate.id}: ` +
                    `${sentryData.issues.length} issues, ${sentryData.user_count_total} users, ` +
                    `${sentryData.queries_used} queries used`,
                  );
                }
              } catch (sentryErr) {
                const msg = sentryErr instanceof Error ? sentryErr.message : String(sentryErr);
                auditLog.warn(`Sentry enrichment failed for ${candidate.id}: ${msg}`);
              }
            }
          }
        }

        // 3d. DEDUPLICATION (delegates to PLAN-007-3)
        const deduped = await this.deduplicateCandidates(candidates, service);
        totalDeduped += candidates.length - deduped.length;

        // 3e. GOVERNANCE CHECKS (SPEC-007-5-3, Task 5 -- Point B)
        //     Apply per-candidate cooldown + oscillation flags
        for (const candidate of deduped) {
          try {
            const governanceFlags = await applyGovernanceChecksImpl(
              service.name,
              candidate.error_class ?? candidate.id,
              config.governance,
              this.rootDir,
              (id) => this.readDeploymentMetadata(id),
              auditLog,
            );
            candidate.governanceFlags = governanceFlags;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            auditLog.warn(`Governance check failed for ${candidate.id}: ${msg}`);
          }
        }

        //     Apply delegate-based governance filtering (may remove candidates)
        const governed = await this.applyGovernanceChecks(deduped, service, config);
        totalFiltered += deduped.length - governed.length;

        // 3f. REPORT GENERATION (delegates to PLAN-007-4)
        //     Report generator uses candidate.governanceFlags for frontmatter
        await this.generateReports(governed, service, runId);

        allObservations.push(...governed);

        // Accumulate token counts from observations
        for (const obs of governed) {
          totalTokens += obs.tokens_consumed;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        auditLog.error(`Service ${service.name} processing failed: ${msg}`);
        errors.push(`${service.name}: ${msg}`);
      } finally {
        await this.lockManager.release(service.name);
      }
    }

    // -----------------------------------------------------------------------
    // 4. FINALIZE
    // -----------------------------------------------------------------------
    const metadata: RunMetadata = {
      run_id: runId,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      services_in_scope: services.map((s) => s.name),
      data_source_status: connectivity.results,
      observations_generated: allObservations.length,
      observations_deduplicated: totalDeduped,
      observations_filtered: totalFiltered,
      triage_decisions_processed: triageCount,
      total_tokens_consumed: totalTokens,
      queries_executed: budget.getCounts(),
      errors,
    };

    await auditLog.writeMetadata(metadata);
    await auditLog.close();

    return metadata;
  }

  /**
   * Builds metadata for an aborted run.
   */
  private abortedRunMetadata(
    runId: string,
    startedAt: string,
    dataSourceStatus: Record<string, DataSourceStatus>,
    servicesInScope: string[],
    errorMessage: string,
  ): RunMetadata {
    return {
      run_id: runId,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      services_in_scope: servicesInScope,
      data_source_status: dataSourceStatus,
      observations_generated: 0,
      observations_deduplicated: 0,
      observations_filtered: 0,
      triage_decisions_processed: 0,
      total_tokens_consumed: 0,
      queries_executed: {},
      errors: [errorMessage],
    };
  }
}
