/**
 * Weighted severity scoring matrix and LLM override mechanism
 * (SPEC-007-3-2, Tasks 4 & 5).
 *
 * Deterministically assigns P0-P3 severity based on five weighted factors:
 *   1. Error rate          (weight 0.30)
 *   2. Affected users      (weight 0.25)
 *   3. Service criticality (weight 0.20)
 *   4. Duration            (weight 0.15)
 *   5. Data integrity risk (weight 0.10)
 *
 * An optional LLM override allows at most one-level adjustment with
 * written justification. Overrides exceeding one level are rejected.
 */

import type { ServiceConfig } from '../config/intelligence-config.schema';
import type { CandidateObservation } from './types';
import { SEVERITY_OVERRIDE_PROMPT } from './prompts/severity-override';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = 'P0' | 'P1' | 'P2' | 'P3';

export interface SeverityFactorDetail {
  value: number | string;
  sub_score: number;
  weighted: number;
}

export interface SeverityBreakdown {
  error_rate: SeverityFactorDetail & { value: number };
  affected_users: SeverityFactorDetail & { value: number };
  service_criticality: SeverityFactorDetail & { value: string };
  duration: SeverityFactorDetail & { value: number };
  data_integrity: SeverityFactorDetail & { value: string };
}

export interface SeverityOverride {
  original_severity: string;
  new_severity: string;
  justification: string;
  /** false if the override was rejected (more than 1 level). */
  accepted: boolean;
}

export interface SeverityResult {
  severity: Severity;
  score: number;
  breakdown: SeverityBreakdown;
  override?: SeverityOverride;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Factor weights as specified in TDD section 3.5.3. */
const WEIGHTS = {
  error_rate: 0.30,
  affected_users: 0.25,
  service_criticality: 0.20,
  duration: 0.15,
  data_integrity: 0.10,
} as const;

/** Severity order used for level-distance validation. */
const SEVERITY_ORDER: readonly Severity[] = ['P0', 'P1', 'P2', 'P3'];

/** Service criticality to sub-score mapping. */
const CRITICALITY_SCORES: Record<string, number> = {
  critical: 1.0,
  high: 0.75,
  medium: 0.50,
  low: 0.25,
};

// ---------------------------------------------------------------------------
// LLM query delegate
// ---------------------------------------------------------------------------

/**
 * Function type for querying an LLM with a prompt string.
 * Injected as a dependency so the scorer does not directly call any LLM API.
 */
export type LlmQueryFn = (prompt: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Affected users estimation
// ---------------------------------------------------------------------------

/**
 * Estimates the number of affected users from throughput, error rate, and
 * duration.
 *
 * Formula: (throughputRps * durationMinutes * 60 * errorRatePercent / 100) / 3
 *
 * The divisor of 3 is a rough heuristic assuming each user makes ~3 requests
 * during the observation window.
 */
export function estimateAffectedUsers(
  throughputRps: number,
  errorRatePercent: number,
  durationMinutes: number,
): number {
  const totalRequests = throughputRps * durationMinutes * 60;
  const erroredRequests = totalRequests * (errorRatePercent / 100);
  return Math.round(erroredRequests / 3);
}

// ---------------------------------------------------------------------------
// Sub-score helpers
// ---------------------------------------------------------------------------

function computeErrorRateSubScore(errorRate: number): number {
  if (errorRate > 50)  return 1.0;
  if (errorRate > 20)  return 0.75;
  if (errorRate > 5)   return 0.50;
  if (errorRate > 1)   return 0.25;
  return 0.0;
}

function computeUserSubScore(affected: number): number {
  if (affected > 10000) return 1.0;
  if (affected > 1000)  return 0.75;
  if (affected > 100)   return 0.50;
  return 0.25;
}

function computeDurationSubScore(durationMinutes: number): number {
  if (durationMinutes > 60)  return 1.0;
  if (durationMinutes > 30)  return 0.75;
  if (durationMinutes > 10)  return 0.50;
  return 0.25;
}

function computeDataIntegritySubScore(
  candidate: CandidateObservation,
): { sub_score: number; label: string } {
  if (candidate.has_data_loss_indicator) {
    return { sub_score: 1.0, label: 'data_loss_confirmed' };
  }
  if (candidate.has_data_corruption_indicator) {
    return { sub_score: 0.75, label: 'data_corruption_possible' };
  }
  return { sub_score: 0.0, label: 'no_data_risk' };
}

function mapScoreToSeverity(score: number): Severity {
  if (score >= 0.75)  return 'P0';
  if (score >= 0.55)  return 'P1';
  if (score >= 0.35)  return 'P2';
  return 'P3';
}

// ---------------------------------------------------------------------------
// Core scoring function
// ---------------------------------------------------------------------------

/**
 * Computes the weighted severity score for a candidate observation.
 *
 * @param candidate      The candidate observation from the detection layer.
 * @param serviceConfig  Service configuration (provides criticality level).
 * @param throughputRps  Current throughput in requests per second.
 * @returns Deterministic severity result with full breakdown.
 */
export function computeSeverity(
  candidate: CandidateObservation,
  serviceConfig: ServiceConfig,
  throughputRps: number,
): SeverityResult {
  let score = 0.0;

  // Factor 1: Error rate (weight 0.30)
  const errorRate = candidate.metric_value;
  const errorRateSubScore = computeErrorRateSubScore(errorRate);
  const errorRateWeighted = WEIGHTS.error_rate * errorRateSubScore;
  score += errorRateWeighted;

  // Factor 2: Affected users (weight 0.25)
  const affected = estimateAffectedUsers(
    throughputRps,
    errorRate,
    candidate.sustained_minutes,
  );
  const userSubScore = computeUserSubScore(affected);
  const usersWeighted = WEIGHTS.affected_users * userSubScore;
  score += usersWeighted;

  // Factor 3: Service criticality (weight 0.20)
  const critSubScore = CRITICALITY_SCORES[serviceConfig.criticality] ?? 0.25;
  const critWeighted = WEIGHTS.service_criticality * critSubScore;
  score += critWeighted;

  // Factor 4: Duration (weight 0.15)
  const duration = candidate.sustained_minutes;
  const durationSubScore = computeDurationSubScore(duration);
  const durationWeighted = WEIGHTS.duration * durationSubScore;
  score += durationWeighted;

  // Factor 5: Data integrity (weight 0.10)
  const { sub_score: dataSubScore, label: dataLabel } =
    computeDataIntegritySubScore(candidate);
  const dataWeighted = WEIGHTS.data_integrity * dataSubScore;
  score += dataWeighted;

  const severity = mapScoreToSeverity(score);

  const breakdown: SeverityBreakdown = {
    error_rate: {
      value: errorRate,
      sub_score: errorRateSubScore,
      weighted: errorRateWeighted,
    },
    affected_users: {
      value: affected,
      sub_score: userSubScore,
      weighted: usersWeighted,
    },
    service_criticality: {
      value: serviceConfig.criticality,
      sub_score: critSubScore,
      weighted: critWeighted,
    },
    duration: {
      value: duration,
      sub_score: durationSubScore,
      weighted: durationWeighted,
    },
    data_integrity: {
      value: dataLabel,
      sub_score: dataSubScore,
      weighted: dataWeighted,
    },
  };

  return { severity, score, breakdown };
}

// ---------------------------------------------------------------------------
// LLM override response parsing
// ---------------------------------------------------------------------------

export interface ParsedOverrideResponse {
  override: 'yes' | 'no';
  new_severity: Severity;
  justification: string;
}

/**
 * Parses the structured LLM response for severity override.
 * Returns null if the response cannot be parsed.
 */
export function parseSeverityOverrideResponse(
  response: string,
): ParsedOverrideResponse | null {
  const overrideMatch = response.match(/OVERRIDE:\s*(yes|no)/i);
  const severityMatch = response.match(/NEW_SEVERITY:\s*(P[0-3])/i);
  const justificationMatch = response.match(/JUSTIFICATION:\s*(.+)/i);

  if (!overrideMatch || !severityMatch || !justificationMatch) {
    return null;
  }

  return {
    override: overrideMatch[1].toLowerCase() as 'yes' | 'no',
    new_severity: severityMatch[1].toUpperCase() as Severity,
    justification: justificationMatch[1].trim(),
  };
}

// ---------------------------------------------------------------------------
// LLM override request
// ---------------------------------------------------------------------------

/**
 * Builds the fully-interpolated LLM prompt from a severity result and
 * evidence summary.
 */
export function buildOverridePrompt(
  result: SeverityResult,
  evidenceSummary: string,
): string {
  return SEVERITY_OVERRIDE_PROMPT
    .replace('{severity}', result.severity)
    .replace('{score}', result.score.toFixed(4))
    .replace('{error_rate_value}', String(result.breakdown.error_rate.value))
    .replace('{error_rate_subscore}', String(result.breakdown.error_rate.sub_score))
    .replace('{error_rate_weighted}', result.breakdown.error_rate.weighted.toFixed(4))
    .replace('{affected_users}', String(result.breakdown.affected_users.value))
    .replace('{users_subscore}', String(result.breakdown.affected_users.sub_score))
    .replace('{users_weighted}', result.breakdown.affected_users.weighted.toFixed(4))
    .replace('{criticality}', String(result.breakdown.service_criticality.value))
    .replace('{criticality_subscore}', String(result.breakdown.service_criticality.sub_score))
    .replace('{criticality_weighted}', result.breakdown.service_criticality.weighted.toFixed(4))
    .replace('{duration_minutes}', String(result.breakdown.duration.value))
    .replace('{duration_subscore}', String(result.breakdown.duration.sub_score))
    .replace('{duration_weighted}', result.breakdown.duration.weighted.toFixed(4))
    .replace('{data_integrity}', String(result.breakdown.data_integrity.value))
    .replace('{data_subscore}', String(result.breakdown.data_integrity.sub_score))
    .replace('{data_weighted}', result.breakdown.data_integrity.weighted.toFixed(4))
    .replace('{evidence_summary}', evidenceSummary);
}

/**
 * Requests an LLM severity override for a deterministic result.
 *
 * The LLM may propose an adjustment of exactly one level (up or down).
 * Overrides of more than one level are rejected and returned with
 * `accepted: false`. The caller should keep the deterministic severity
 * when the override is rejected.
 *
 * @param result          The deterministic severity result.
 * @param candidate       The candidate observation (for evidence context).
 * @param evidenceSummary Human-readable summary of supporting evidence.
 * @param llmQuery        Injected LLM query function.
 * @returns The override descriptor, or null if the LLM chose not to override.
 */
export async function requestLlmOverride(
  result: SeverityResult,
  candidate: CandidateObservation,
  evidenceSummary: string,
  llmQuery: LlmQueryFn,
): Promise<SeverityOverride | null> {
  const prompt = buildOverridePrompt(result, evidenceSummary);
  const response = await llmQuery(prompt);
  const parsed = parseSeverityOverrideResponse(response);

  if (!parsed || parsed.override === 'no') {
    return null;
  }

  // Validate: at most one level difference
  const originalIdx = SEVERITY_ORDER.indexOf(result.severity);
  const newIdx = SEVERITY_ORDER.indexOf(parsed.new_severity);
  const diff = Math.abs(originalIdx - newIdx);

  if (diff > 1) {
    // Reject: more than one level change
    return {
      original_severity: result.severity,
      new_severity: parsed.new_severity,
      justification: parsed.justification,
      accepted: false,
    };
  }

  return {
    original_severity: result.severity,
    new_severity: parsed.new_severity,
    justification: parsed.justification,
    accepted: true,
  };
}
