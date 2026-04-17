import { OscillationResult, GovernanceConfig, ObservationSummary } from './types';

/**
 * Check whether a service+error class combination is oscillating.
 *
 * Oscillation = the same service+error class generates observations
 * at a rate of `threshold` or more within `window_days`.
 *
 * When detected, the observation report includes a structured warning
 * with previous observation history and a recommendation for
 * architectural investigation.
 */
export function checkOscillation(
  service: string,
  errorClass: string,
  config: GovernanceConfig,
  findObservations: (service: string, errorClass: string, afterDate: Date) => ObservationSummary[],
  now?: Date
): OscillationResult {
  const currentTime = now ?? new Date();
  const windowStart = new Date(currentTime);
  windowStart.setDate(windowStart.getDate() - config.oscillation_window_days);

  const recentObservations = findObservations(service, errorClass, windowStart);

  if (recentObservations.length >= config.oscillation_threshold) {
    return {
      oscillating: true,
      count: recentObservations.length,
      window_days: config.oscillation_window_days,
      observation_ids: recentObservations.map(obs => obs.id),
      observation_summaries: recentObservations,
      recommendation: 'systemic_investigation',
    };
  }

  return { oscillating: false };
}

/**
 * Build the Markdown section for oscillation warnings.
 * Matches TDD section 3.11.2 format exactly.
 */
export function buildOscillationWarningMarkdown(result: OscillationResult): string {
  if (!result.oscillating || !result.observation_summaries) {
    return '';
  }

  const lines: string[] = [];
  lines.push('## Oscillation Warning');
  lines.push('');
  lines.push(
    `This service + error class combination has generated ${result.count} observations in the ` +
    `last ${result.window_days} days. This suggests a systemic issue that incremental fixes are not ` +
    `resolving.`
  );
  lines.push('');
  lines.push('**Previous observations:**');

  for (const obs of result.observation_summaries) {
    const statusDetail = formatObservationStatus(obs);
    lines.push(`- ${obs.id} (${statusDetail})`);
  }

  lines.push('');
  lines.push(
    '**Recommendation:** Promote as an architectural investigation PRD rather than ' +
    'an incremental fix PRD.'
  );

  return lines.join('\n');
}

/**
 * Format a single observation's status for the oscillation warning list.
 * Examples:
 *   "promoted, fix deployed, not effective"
 *   "promoted, fix deployed, partially effective"
 *   "promoted, fix in progress"
 *   "this observation"
 *   "pending"
 *   "dismissed"
 */
function formatObservationStatus(obs: ObservationSummary): string {
  if (obs.is_current) {
    return 'this observation';
  }

  const parts: string[] = [];

  if (obs.triage_status === 'promoted') {
    parts.push('promoted');
    if (obs.effectiveness === 'improved') {
      parts.push('fix deployed, effective');
    } else if (obs.effectiveness === 'degraded') {
      parts.push('fix deployed, not effective');
    } else if (obs.effectiveness === 'unchanged') {
      parts.push('fix deployed, partially effective');
    } else if (obs.effectiveness === 'pending') {
      parts.push('fix in progress');
    } else {
      parts.push('fix deployed');
    }
  } else {
    parts.push(obs.triage_status);
  }

  return parts.join(', ');
}
