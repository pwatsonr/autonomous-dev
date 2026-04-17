/**
 * Performance Analysis Orchestration and Decision Logic
 * (SPEC-005-3-2, Tasks 3 and 4).
 *
 * Collects metrics data for a target agent, formats a structured prompt,
 * invokes the `performance-analyst` agent, parses the output into a
 * `WeaknessReport`, and routes the result through the decision engine
 * (no action, propose modification, or log domain gap).
 *
 * Exports: `PerformanceAnalyzer`, `AnalyzerLogger`
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

import type { IAgentRegistry, AgentRecord } from '../types';
import type {
  IMetricsEngine,
  InvocationMetric,
} from '../metrics/types';
import type { ObservationTracker } from '../metrics/observation';
import type { AuditLogger } from '../audit';
import type { AgentRuntime } from '../runtime';

import type {
  AnalysisInput,
  AnalysisResult,
  DimensionBreakdown,
  DomainGapEntry,
  WeaknessReport,
} from './types';
import type { WeaknessReportStore } from './weakness-report-store';

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

export interface AnalyzerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const defaultLogger: AnalyzerLogger = {
  info: (msg: string) => console.log(`[performance-analyzer] ${msg}`),
  warn: (msg: string) => console.warn(`[performance-analyzer] ${msg}`),
  error: (msg: string) => console.error(`[performance-analyzer] ${msg}`),
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of recent invocations to include in the analysis input. */
const RECENT_INVOCATIONS_LIMIT = 20;

/** Name of the performance-analyst agent in the registry. */
const PERFORMANCE_ANALYST_AGENT = 'performance-analyst';

// ---------------------------------------------------------------------------
// PerformanceAnalyzer
// ---------------------------------------------------------------------------

export interface PerformanceAnalyzerOptions {
  registry: IAgentRegistry;
  metricsEngine: IMetricsEngine;
  observationTracker: ObservationTracker;
  auditLogger: AuditLogger;
  reportStore: WeaknessReportStore;
  /** Path to the domain-gaps JSONL file. Defaults to `data/domain-gaps.jsonl`. */
  domainGapsPath?: string;
  /** Optional logger. */
  logger?: AnalyzerLogger;
  /**
   * Optional factory for creating an AgentRuntime for the performance-analyst.
   * When omitted, the analyzer uses `runtime.invoke()` directly.
   * Primarily intended for testing / dependency injection.
   */
  createRuntime?: (agent: AgentRecord) => AgentRuntime;
}

/**
 * Orchestrates performance analysis for an agent.
 *
 * Flow:
 *   1. Collect input data (aggregate, recent invocations, dimension breakdown, alerts).
 *   2. Format a structured prompt for the `performance-analyst` agent.
 *   3. Invoke the agent via the registry + runtime.
 *   4. Parse the agent's JSON output into a `WeaknessReport`.
 *   5. Route through the decision engine to determine next action.
 */
export class PerformanceAnalyzer {
  private readonly registry: IAgentRegistry;
  private readonly metricsEngine: IMetricsEngine;
  private readonly observationTracker: ObservationTracker;
  private readonly auditLogger: AuditLogger;
  private readonly reportStore: WeaknessReportStore;
  private readonly domainGapsPath: string;
  private readonly logger: AnalyzerLogger;
  private readonly createRuntime?: (agent: AgentRecord) => AgentRuntime;

  constructor(opts: PerformanceAnalyzerOptions) {
    this.registry = opts.registry;
    this.metricsEngine = opts.metricsEngine;
    this.observationTracker = opts.observationTracker;
    this.auditLogger = opts.auditLogger;
    this.reportStore = opts.reportStore;
    this.domainGapsPath = opts.domainGapsPath
      ? path.resolve(opts.domainGapsPath)
      : path.resolve('data/domain-gaps.jsonl');
    this.logger = opts.logger ?? defaultLogger;
    this.createRuntime = opts.createRuntime;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Run a complete performance analysis for the named agent.
   *
   * On failure the method returns a result with `success: false` and
   * `nextAction: 'error'` -- it never throws.  The observation counter
   * is NOT reset on failure so that the next threshold crossing (or
   * manual trigger) will retry.
   */
  async analyze(agentName: string): Promise<AnalysisResult> {
    try {
      // Step 1: Look up the target agent in the registry
      const agentRecord = this.registry.get(agentName);
      if (!agentRecord) {
        return this.errorResult(`Agent '${agentName}' not found in registry`);
      }

      // Step 2: Look up the performance-analyst agent
      const analystRecord = this.registry.get(PERFORMANCE_ANALYST_AGENT);
      if (!analystRecord) {
        return this.errorResult(
          `Performance-analyst agent '${PERFORMANCE_ANALYST_AGENT}' not found in registry`,
        );
      }
      if (analystRecord.state === 'FROZEN') {
        return this.errorResult(
          `Performance-analyst agent '${PERFORMANCE_ANALYST_AGENT}' is FROZEN`,
        );
      }

      // Step 3: Collect analysis input data
      const input = this.collectInput(agentRecord);
      if (!input) {
        return this.errorResult(
          `No aggregate metrics available for agent '${agentName}'`,
        );
      }

      // Step 4: Format the structured prompt
      const prompt = this.formatPrompt(input);

      // Step 5: Invoke the performance-analyst agent
      const agentOutput = await this.invokeAnalyst(analystRecord, prompt);
      if (agentOutput === null) {
        return this.errorResult(
          `Performance-analyst invocation failed for agent '${agentName}'`,
        );
      }

      // Step 6: Parse the agent's output into a WeaknessReport
      const report = this.parseReport(agentOutput, agentRecord);
      if (!report) {
        return this.errorResult(
          `Failed to parse performance-analyst output for agent '${agentName}'`,
        );
      }

      // Step 7: Persist the report
      this.reportStore.append(report);
      this.logger.info(
        `Weakness report ${report.report_id} persisted for '${agentName}'`,
      );

      // Step 8: Decide the next action
      const nextAction = decideNextAction(report);

      // Step 9: Execute the action side effects
      this.executeAction(nextAction, report, agentName, agentRecord.agent.version);

      // Step 10: Audit log the completed analysis
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        event_type: 'domain_gap_detected' as const, // closest existing audit event type
        agent_name: agentName,
        details: {
          event: 'analysis_complete',
          report_id: report.report_id,
          overall_assessment: report.overall_assessment,
          recommendation: report.recommendation,
          next_action: nextAction,
          weakness_count: report.weaknesses.length,
          strength_count: report.strengths.length,
        },
      });

      return {
        success: true,
        report,
        nextAction,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Analysis failed for '${agentName}': ${message}`);

      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        event_type: 'domain_gap_detected' as const,
        agent_name: agentName,
        details: {
          event: 'analysis_error',
          error: message,
        },
      });

      return this.errorResult(message);
    }
  }

  // -----------------------------------------------------------------------
  // Step 1: Collect input data
  // -----------------------------------------------------------------------

  /**
   * Gather all input data for the performance-analyst agent.
   *
   * Returns null if no aggregate metrics are available (the agent
   * has not been invoked enough to produce aggregates).
   */
  collectInput(agentRecord: AgentRecord): AnalysisInput | null {
    const agentName = agentRecord.agent.name;

    // Aggregate metrics
    const aggregate = this.metricsEngine.getAggregate(agentName);
    if (!aggregate) {
      this.logger.warn(`No aggregate metrics for '${agentName}'`);
      return null;
    }

    // Recent invocations (last 20)
    const recentInvocations = this.metricsEngine.getInvocations(agentName, {
      limit: RECENT_INVOCATIONS_LIMIT,
    });

    // Per-dimension scores
    const perDimensionScores = computeDimensionBreakdowns(recentInvocations);

    // Domain breakdown
    const domainBreakdown = aggregate.domain_breakdown;

    // Active alerts
    const activeAlerts = this.metricsEngine.getAlerts({
      agentName,
      activeOnly: true,
    });

    // Trend
    const trend = aggregate.trend;

    return {
      agent: {
        name: agentRecord.agent.name,
        version: agentRecord.agent.version,
        role: agentRecord.agent.role,
        expertise: agentRecord.agent.expertise,
        evaluation_rubric: agentRecord.agent.evaluation_rubric,
      },
      metrics: {
        aggregate,
        recent_invocations: recentInvocations,
        per_dimension_scores: perDimensionScores,
        domain_breakdown: domainBreakdown,
        active_alerts: activeAlerts,
        trend,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Step 2: Format prompt
  // -----------------------------------------------------------------------

  /**
   * Construct a structured prompt for the performance-analyst agent.
   */
  formatPrompt(input: AnalysisInput): string {
    const { agent, metrics } = input;
    const { aggregate, per_dimension_scores, domain_breakdown, active_alerts, recent_invocations } = metrics;

    // Header
    const lines: string[] = [
      `You are analyzing the performance of agent '${agent.name}' (v${agent.version}, role: ${agent.role}).`,
      '',
      '## Current Metrics',
      `- Invocations (${aggregate.window_days}d): ${aggregate.invocation_count}`,
      `- Approval rate: ${(aggregate.approval_rate * 100).toFixed(1)}%`,
      `- Average quality score: ${aggregate.avg_quality_score.toFixed(2)} / 5.0`,
      `- Trend: ${aggregate.trend.direction} (slope: ${aggregate.trend.slope.toFixed(4)}, confidence: ${aggregate.trend.confidence.toFixed(2)})`,
      '',
    ];

    // Per-Dimension Performance
    lines.push('## Per-Dimension Performance');
    lines.push('| Dimension | Avg Score | Median | Stddev | Trend | Worst Domains |');
    lines.push('|-----------|-----------|--------|--------|-------|---------------|');
    for (const dim of per_dimension_scores) {
      const worstDomains = dim.worst_domains.length > 0
        ? dim.worst_domains.join(', ')
        : 'none';
      lines.push(
        `| ${dim.dimension} | ${dim.avg_score.toFixed(2)} | ${dim.median_score.toFixed(2)} | ${dim.stddev.toFixed(2)} | ${dim.trend_slope >= 0 ? '+' : ''}${dim.trend_slope.toFixed(4)} | ${worstDomains} |`,
      );
    }
    lines.push('');

    // Domain Breakdown
    lines.push('## Domain Breakdown');
    lines.push('| Domain | Invocations | Approval Rate | Avg Quality |');
    lines.push('|--------|-------------|---------------|-------------|');
    for (const [domain, stats] of Object.entries(domain_breakdown)) {
      lines.push(
        `| ${domain} | ${stats.invocation_count} | ${(stats.approval_rate * 100).toFixed(1)}% | ${stats.avg_quality_score.toFixed(2)} |`,
      );
    }
    lines.push('');

    // Active Alerts
    lines.push('## Active Alerts');
    if (active_alerts.length === 0) {
      lines.push('No active alerts.');
    } else {
      for (const alert of active_alerts) {
        lines.push(`- [${alert.severity}] ${alert.rule_id}: ${alert.message}`);
      }
    }
    lines.push('');

    // Recent Invocations
    lines.push(`## Recent Invocations (last ${recent_invocations.length})`);
    lines.push('| Timestamp | Domain | Quality Score | Review Outcome | Iterations |');
    lines.push('|-----------|--------|---------------|----------------|------------|');
    for (const inv of recent_invocations) {
      lines.push(
        `| ${inv.timestamp} | ${inv.input_domain} | ${inv.output_quality_score.toFixed(2)} | ${inv.review_outcome} | ${inv.review_iteration_count} |`,
      );
    }
    lines.push('');

    // Instructions
    lines.push('---');
    lines.push('');
    lines.push('Produce a structured weakness report with:');
    lines.push('1. overall_assessment: "healthy" | "needs_improvement" | "critical"');
    lines.push('2. weaknesses: array of { dimension, severity, evidence, affected_domains, suggested_focus }');
    lines.push('3. strengths: array of strings');
    lines.push('4. recommendation: "no_action" | "propose_modification" | "propose_specialist"');
    lines.push('');
    lines.push('Format your response as a JSON code block.');

    return lines.join('\n');
  }

  // -----------------------------------------------------------------------
  // Step 3: Invoke the performance-analyst agent
  // -----------------------------------------------------------------------

  /**
   * Invoke the performance-analyst agent with the formatted prompt.
   *
   * Returns the agent's text output, or null on failure.
   */
  private async invokeAnalyst(
    analystRecord: AgentRecord,
    prompt: string,
  ): Promise<string | null> {
    try {
      if (this.createRuntime) {
        const runtime = this.createRuntime(analystRecord);
        const result = await runtime.invoke(prompt, {
          workingDirectory: process.cwd(),
        });

        if (!result.success) {
          this.logger.error(
            `Performance-analyst invocation failed: ${result.output ?? 'unknown error'}`,
          );
          return null;
        }

        return result.output ?? null;
      }

      // Fallback: no runtime factory provided; this is a structural
      // placeholder.  In production the createRuntime factory is required.
      this.logger.warn(
        'No runtime factory provided; returning null from analyst invocation',
      );
      return null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Performance-analyst invocation error: ${message}`);
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Step 4: Parse output into WeaknessReport
  // -----------------------------------------------------------------------

  /**
   * Parse the performance-analyst agent's output into a WeaknessReport.
   *
   * Handles:
   *   - Raw JSON string
   *   - JSON wrapped in ```json ... ``` code blocks
   *   - JSON wrapped in ``` ... ``` code blocks (no language tag)
   *
   * Returns null if parsing fails.
   */
  parseReport(
    output: string,
    agentRecord: AgentRecord,
  ): WeaknessReport | null {
    const json = extractJson(output);
    if (!json) {
      this.logger.error('Failed to extract JSON from performance-analyst output');
      return null;
    }

    try {
      const parsed = JSON.parse(json) as Partial<WeaknessReport>;

      // Validate required fields
      if (!isValidOverallAssessment(parsed.overall_assessment)) {
        this.logger.error(
          `Invalid overall_assessment: '${parsed.overall_assessment}'`,
        );
        return null;
      }
      if (!isValidRecommendation(parsed.recommendation)) {
        this.logger.error(
          `Invalid recommendation: '${parsed.recommendation}'`,
        );
        return null;
      }
      if (!Array.isArray(parsed.weaknesses)) {
        this.logger.error('Missing or invalid weaknesses array');
        return null;
      }
      if (!Array.isArray(parsed.strengths)) {
        this.logger.error('Missing or invalid strengths array');
        return null;
      }

      // Build the MetricsSummary from current data
      const aggregate = this.metricsEngine.getAggregate(agentRecord.agent.name);
      const activeAlerts = this.metricsEngine.getAlerts({
        agentName: agentRecord.agent.name,
        activeOnly: true,
      });

      const report: WeaknessReport = {
        report_id: randomUUID(),
        agent_name: agentRecord.agent.name,
        agent_version: agentRecord.agent.version,
        analysis_date: new Date().toISOString(),
        overall_assessment: parsed.overall_assessment,
        weaknesses: parsed.weaknesses.map((w) => ({
          dimension: w.dimension ?? '',
          severity: isValidWeaknessSeverity(w.severity) ? w.severity : 'low',
          evidence: w.evidence ?? '',
          affected_domains: Array.isArray(w.affected_domains)
            ? w.affected_domains
            : [],
          suggested_focus: w.suggested_focus ?? '',
        })),
        strengths: parsed.strengths,
        recommendation: parsed.recommendation,
        metrics_summary: {
          invocation_count: aggregate?.invocation_count ?? 0,
          approval_rate: aggregate?.approval_rate ?? 0,
          avg_quality_score: aggregate?.avg_quality_score ?? 0,
          trend_direction: aggregate?.trend.direction ?? 'stable',
          active_alerts: activeAlerts.length,
        },
      };

      return report;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`JSON parse failed: ${message}`);
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Step 5 + 9: Execute action side effects
  // -----------------------------------------------------------------------

  /**
   * Execute the side effects for the decided action.
   *
   * - `no_action`: reset observation counter.
   * - `propose_modification`: transition agent to UNDER_REVIEW.
   * - `log_domain_gap`: write domain gap entry + audit log.
   */
  private executeAction(
    nextAction: string,
    report: WeaknessReport,
    agentName: string,
    currentVersion: string,
  ): void {
    switch (nextAction) {
      case 'no_action':
        this.observationTracker.resetForPromotion(agentName, currentVersion);
        this.logger.info(
          `Agent '${agentName}' is healthy; observation counter reset`,
        );
        break;

      case 'propose_modification':
        this.registry.setState(agentName, 'UNDER_REVIEW');
        this.logger.info(
          `Agent '${agentName}' transitioned to UNDER_REVIEW for modification proposal`,
        );
        break;

      case 'log_domain_gap':
        this.logDomainGap(report, agentName);
        break;

      default:
        // 'error' or unexpected -- no side effects
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Domain gap logging
  // -----------------------------------------------------------------------

  /**
   * Append a domain gap entry to `data/domain-gaps.jsonl` and emit an
   * audit event.
   */
  private logDomainGap(report: WeaknessReport, agentName: string): void {
    // Collect affected domains and descriptions from weaknesses
    const affectedDomains = new Set<string>();
    const descriptions: string[] = [];

    for (const weakness of report.weaknesses) {
      for (const domain of weakness.affected_domains) {
        affectedDomains.add(domain);
      }
      if (weakness.suggested_focus) {
        descriptions.push(weakness.suggested_focus);
      }
    }

    const taskDomain = affectedDomains.size > 0
      ? Array.from(affectedDomains).join(', ')
      : 'unknown';

    const description = descriptions.length > 0
      ? descriptions.join('; ')
      : 'Specialist agent recommended based on performance analysis';

    const entry: DomainGapEntry = {
      gap_id: randomUUID(),
      task_domain: taskDomain,
      description,
      detected_at: new Date().toISOString(),
      source_agent: agentName,
      status: 'specialist_recommended',
      closest_agent: agentName,
      analysis_report_id: report.report_id,
    };

    // Write to JSONL
    try {
      const dir = path.dirname(this.domainGapsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const line = JSON.stringify(entry) + '\n';
      fs.appendFileSync(this.domainGapsPath, line, { encoding: 'utf-8' });

      this.logger.info(
        `Domain gap ${entry.gap_id} logged for '${agentName}' (domain: ${taskDomain})`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to write domain gap entry: ${message}`);
    }

    // Audit log
    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      event_type: 'domain_gap_detected',
      agent_name: agentName,
      details: {
        event: 'domain_gap_specialist_recommended',
        gap_id: entry.gap_id,
        task_domain: entry.task_domain,
        description: entry.description,
        analysis_report_id: report.report_id,
      },
    });
  }

  // -----------------------------------------------------------------------
  // Error helper
  // -----------------------------------------------------------------------

  private errorResult(error: string): AnalysisResult {
    this.logger.error(error);
    return {
      success: false,
      nextAction: 'error',
      error,
    };
  }
}

// ---------------------------------------------------------------------------
// Decision logic (SPEC-005-3-2, Task 4)
// ---------------------------------------------------------------------------

/**
 * Determine the next action based on a weakness report.
 *
 * Routing:
 *   - `healthy` -> `no_action`
 *   - `propose_specialist` recommendation -> `log_domain_gap`
 *   - `propose_modification` + (`needs_improvement` | `critical`) -> `propose_modification`
 *   - default -> `no_action` (unexpected state)
 */
export function decideNextAction(
  report: WeaknessReport,
): 'no_action' | 'propose_modification' | 'log_domain_gap' {
  if (report.overall_assessment === 'healthy') {
    return 'no_action';
  }

  if (report.recommendation === 'propose_specialist') {
    return 'log_domain_gap';
  }

  if (
    report.recommendation === 'propose_modification' &&
    (report.overall_assessment === 'needs_improvement' ||
      report.overall_assessment === 'critical')
  ) {
    return 'propose_modification';
  }

  // Default: no action (unexpected state)
  return 'no_action';
}

// ---------------------------------------------------------------------------
// Dimension breakdown computation
// ---------------------------------------------------------------------------

/**
 * Compute per-dimension breakdowns from recent invocations.
 *
 * Groups `quality_dimensions` across all invocations by dimension name,
 * then computes average, median, standard deviation, trend slope, and
 * identifies worst-performing domains for each dimension.
 */
export function computeDimensionBreakdowns(
  invocations: InvocationMetric[],
): DimensionBreakdown[] {
  if (invocations.length === 0) return [];

  // Group scores by dimension
  const dimMap = new Map<
    string,
    Array<{ score: number; domain: string; index: number }>
  >();

  for (let i = 0; i < invocations.length; i++) {
    const inv = invocations[i];
    for (const dim of inv.quality_dimensions) {
      if (!dimMap.has(dim.dimension)) {
        dimMap.set(dim.dimension, []);
      }
      dimMap.get(dim.dimension)!.push({
        score: dim.score,
        domain: inv.input_domain,
        index: i,
      });
    }
  }

  const breakdowns: DimensionBreakdown[] = [];

  for (const [dimension, entries] of dimMap) {
    const scores = entries.map((e) => e.score);

    const avg = mean(scores);
    const med = median(scores);
    const std = stddev(scores, avg);
    const slope = linearRegressionSlope(entries.map((e) => e.score));

    // Find worst domains: compute avg score per domain, return bottom ones
    const domainScores = new Map<string, number[]>();
    for (const entry of entries) {
      if (!domainScores.has(entry.domain)) {
        domainScores.set(entry.domain, []);
      }
      domainScores.get(entry.domain)!.push(entry.score);
    }

    const domainAvgs: Array<{ domain: string; avg: number }> = [];
    for (const [domain, dScores] of domainScores) {
      domainAvgs.push({ domain, avg: mean(dScores) });
    }
    domainAvgs.sort((a, b) => a.avg - b.avg);

    // Worst domains: bottom half or domains below the overall average
    const worstDomains = domainAvgs
      .filter((d) => d.avg < avg)
      .map((d) => d.domain);

    breakdowns.push({
      dimension,
      avg_score: avg,
      median_score: med,
      stddev: std,
      trend_slope: slope,
      worst_domains: worstDomains,
    });
  }

  return breakdowns;
}

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/**
 * Extract JSON from agent output.
 *
 * Handles:
 *   - ```json { ... } ```
 *   - ``` { ... } ```
 *   - Raw JSON object/array at the start of the string
 */
export function extractJson(output: string): string | null {
  // Try to find JSON in a code block
  const codeBlockMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    const candidate = codeBlockMatch[1].trim();
    if (candidate.startsWith('{') || candidate.startsWith('[')) {
      return candidate;
    }
  }

  // Try raw JSON (first { to last })
  const trimmed = output.trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.substring(firstBrace, lastBrace + 1);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isValidOverallAssessment(value: unknown): value is 'healthy' | 'needs_improvement' | 'critical' {
  return value === 'healthy' || value === 'needs_improvement' || value === 'critical';
}

function isValidRecommendation(value: unknown): value is 'no_action' | 'propose_modification' | 'propose_specialist' {
  return value === 'no_action' || value === 'propose_modification' || value === 'propose_specialist';
}

function isValidWeaknessSeverity(value: unknown): value is 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high';
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function stddev(values: number[], avg?: number): number {
  if (values.length < 2) return 0;
  const m = avg ?? mean(values);
  const sumSqDiffs = values.reduce((sum, v) => sum + (v - m) ** 2, 0);
  return Math.sqrt(sumSqDiffs / (values.length - 1));
}

/**
 * Compute the slope of a simple linear regression over the given values.
 *
 * Values are treated as evenly spaced points (x = 0, 1, 2, ...).
 * Returns 0 if fewer than 2 data points.
 */
function linearRegressionSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;

  return (n * sumXY - sumX * sumY) / denominator;
}
