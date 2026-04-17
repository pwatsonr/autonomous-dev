/**
 * Markdown body section templates for observation reports
 * (SPEC-007-4-1, Task 1 — body builder helpers).
 *
 * Each helper renders a single Markdown section of the observation
 * report body. The main `buildMarkdownBody` orchestrator in
 * report-generator.ts calls these in order to assemble the full body.
 */

import type { SeverityResult } from '../engine/severity-scorer';
import type { PrometheusResult, GrafanaAlertResult } from '../adapters/types';
import type { BaselineMetrics } from '../engine/types';
import type { ScrubbedOpenSearchResult } from '../safety/scrub-pipeline';

// ---------------------------------------------------------------------------
// LLM analysis result (defined here as the spec references it)
// ---------------------------------------------------------------------------

/**
 * Result of LLM analysis for an observation.
 * Populated when LLM analysis is available; undefined otherwise.
 */
export interface LlmAnalysisResult {
  title: string;
  summary: string;
  rootCauseHypothesis: string;
  recommendedAction: string;
}

// ---------------------------------------------------------------------------
// Governance flags
// ---------------------------------------------------------------------------

/**
 * Governance flags for cooldown and oscillation tracking.
 */
export interface GovernanceFlags {
  cooldown_active: boolean;
  oscillation_warning: boolean;
  oscillation_data?: OscillationData;
}

/**
 * Oscillation data for the warning section.
 */
export interface OscillationData {
  flap_count: number;
  window_minutes: number;
  transitions: string[];
}

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

/**
 * Maps a sub_score to a human-readable severity range label.
 */
export function severityRange(subScore: number): string {
  if (subScore >= 1.0) return 'Critical';
  if (subScore >= 0.75) return 'High';
  if (subScore >= 0.50) return 'Medium';
  if (subScore >= 0.25) return 'Low';
  return 'None';
}

/**
 * Builds the severity rationale table showing all five factors.
 */
export function buildSeverityRationaleTable(severity: SeverityResult): string {
  const b = severity.breakdown;
  return `
| Factor | Value | Score |
|--------|-------|-------|
| Error rate | ${b.error_rate.value}% | ${severityRange(b.error_rate.sub_score)} |
| Estimated affected users | ~${b.affected_users.value.toLocaleString()} | ${severityRange(b.affected_users.sub_score)} |
| Service criticality | ${b.service_criticality.value} | ${severityRange(b.service_criticality.sub_score)} |
| Duration | ${b.duration.value} min | ${severityRange(b.duration.sub_score)} |
| Data integrity | ${b.data_integrity.value} | ${b.data_integrity.sub_score > 0 ? severityRange(b.data_integrity.sub_score) : 'N/A'} |
| **Weighted score** | **${severity.score.toFixed(2)}** | **${severity.severity}** |
`;
}

// ---------------------------------------------------------------------------
// Metrics table
// ---------------------------------------------------------------------------

/**
 * Formats a Prometheus query_name into a human-readable metric name.
 */
export function formatMetricName(queryName: string): string {
  return queryName
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Formats the current value from a Prometheus result for display.
 */
export function formatMetricValue(metric: PrometheusResult): string {
  if (metric.value === null) return 'N/A';
  const name = metric.query_name.toLowerCase();
  if (name.includes('rate') || name.includes('availability') || name.includes('percent')) {
    return `${metric.value.toFixed(2)}%`;
  }
  if (name.includes('latency') || name.includes('ms')) {
    return `${metric.value.toFixed(1)}ms`;
  }
  if (name.includes('throughput') || name.includes('rps')) {
    return `${metric.value.toFixed(1)} req/s`;
  }
  return metric.value.toFixed(2);
}

/**
 * Builds the metrics evidence table showing current values against baselines.
 */
export function buildMetricsTable(
  metrics: PrometheusResult[],
  baseline: BaselineMetrics,
): string {
  let table = '| Metric | Current | Baseline (7d) | Threshold |\n';
  table += '|--------|---------|---------------|----------|\n';
  for (const m of metrics) {
    if (m.value === null) continue;
    const bl = baseline.metrics[m.query_name];
    const baselineStr = bl
      ? `${bl.mean_7d.toFixed(2)} +/- ${bl.stddev_7d.toFixed(2)}`
      : 'N/A';
    table += `| ${formatMetricName(m.query_name)} | ${formatMetricValue(m)} | ${baselineStr} | N/A |\n`;
  }
  return table;
}

// ---------------------------------------------------------------------------
// Log section
// ---------------------------------------------------------------------------

/**
 * Builds the log evidence section from scrubbed OpenSearch results.
 */
export function buildLogSection(logs: ScrubbedOpenSearchResult[]): string {
  const lines: string[] = [];
  for (const result of logs) {
    for (const hit of result.hits) {
      lines.push(`\`\`\`\n${hit.message}\n\`\`\``);
      if (hit.stack_trace) {
        lines.push(`\`\`\`\n${hit.stack_trace}\n\`\`\``);
      }
    }
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Alert section
// ---------------------------------------------------------------------------

/**
 * Builds the alert evidence section from Grafana alert results.
 */
export function buildAlertSection(alerts: GrafanaAlertResult): string {
  const lines: string[] = [];
  for (const alert of alerts.alerts) {
    lines.push(
      `- **${alert.name}** — State: \`${alert.state}\`, Since: ${alert.since}, Dashboard: \`${alert.dashboard_uid}\``,
    );
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Oscillation warning
// ---------------------------------------------------------------------------

/**
 * Builds the oscillation warning section when state flapping is detected.
 */
export function buildOscillationWarning(data?: OscillationData): string {
  const sections: string[] = [];
  sections.push(`## Oscillation Warning\n`);
  sections.push(
    `> **Warning: This observation has been oscillating between states.**\n`,
  );
  if (data) {
    sections.push(
      `\nFlap count: ${data.flap_count} in the last ${data.window_minutes} minutes.\n`,
    );
    if (data.transitions.length > 0) {
      sections.push(`Transitions: ${data.transitions.join(' -> ')}\n`);
    }
  }
  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Title and summary generators (fallback when LLM is unavailable)
// ---------------------------------------------------------------------------

/**
 * Generates a fallback title from the candidate observation when
 * LLM analysis is unavailable.
 */
export function generateTitle(input: {
  candidate: { type: string; service: string; error_type?: string };
}): string {
  const { type, service, error_type } = input.candidate;
  if (error_type) {
    return `${error_type} detected on ${service}`;
  }
  return `${type} observation on ${service}`;
}

/**
 * Generates a fallback summary from the candidate observation when
 * LLM analysis is unavailable.
 */
export function generateSummary(input: {
  candidate: {
    type: string;
    service: string;
    metric_value: number;
    threshold_value: number;
    sustained_minutes: number;
  };
  severity: SeverityResult;
}): string {
  const { service, metric_value, threshold_value, sustained_minutes } = input.candidate;
  return (
    `${input.severity.severity} severity ${input.candidate.type} observation detected on ${service}. ` +
    `Current value ${metric_value.toFixed(2)} exceeds threshold ${threshold_value.toFixed(2)} ` +
    `for ${sustained_minutes} minutes.`
  );
}
