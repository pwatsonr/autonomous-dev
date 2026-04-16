/**
 * Intelligence engine failure handling (SPEC-007-3-6, Task 15).
 *
 * Three failure modes from TDD section 6.3:
 *   1. Claude session fails or times out -> retry once, then minimal observation
 *   2. Token budget exceeded mid-run -> complete current service, skip remaining
 *   3. Invalid observation structure -> validate and reject
 */

import type { CandidateObservation } from './types';
import type { ServiceConfig } from '../config/intelligence-config.schema';
import type { SeverityResult } from './severity-scorer';

// ---------------------------------------------------------------------------
// Audit logger interface
// ---------------------------------------------------------------------------

/**
 * Minimal audit logger interface used by error-handler functions.
 * Callers inject their concrete implementation.
 */
export interface AuditLogger {
  warn(message: string): void;
  error(message: string): void;
  info(message: string): void;
}

// ---------------------------------------------------------------------------
// LLM retry context
// ---------------------------------------------------------------------------

/**
 * Context for an LLM operation being retried.
 */
export interface LlmRetryContext {
  service: string;
  phase: string;
}

// ---------------------------------------------------------------------------
// Failure 1: Claude session fails or times out
// ---------------------------------------------------------------------------

/**
 * Wraps an LLM operation with a single retry.
 *
 * On first failure, logs a warning and retries once. On second failure,
 * logs an error and returns null. The caller is responsible for generating
 * a minimal observation when null is returned.
 *
 * @param operation  The async LLM operation to execute
 * @param context    Service and phase context for audit logging
 * @param auditLog   Audit logger for recording failures
 * @returns          The operation result, or null if both attempts fail
 */
export async function withLlmRetry<T>(
  operation: () => Promise<T>,
  context: LlmRetryContext,
  auditLog: AuditLogger,
): Promise<T | null> {
  try {
    return await operation();
  } catch (firstError) {
    auditLog.warn(
      `LLM session failed for ${context.service}/${context.phase}: ${firstError}. Retrying...`,
    );

    try {
      return await operation();
    } catch (secondError) {
      auditLog.error(
        `LLM retry failed for ${context.service}/${context.phase}: ${secondError}. Generating minimal observation.`,
      );
      return null; // Caller generates minimal observation
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal observation
// ---------------------------------------------------------------------------

/**
 * A minimal observation generated when the LLM is unavailable.
 * Contains metrics-only data with reduced confidence.
 */
export interface MinimalObservation extends CandidateObservation {
  summary: string;
  root_cause_hypothesis: string;
  recommended_action: string;
  llm_analysis_available: boolean;
  severity: string;
  confidence: number;
}

/**
 * Generates a minimal observation when the LLM is unavailable.
 *
 * The confidence is reduced by a 0.7x factor since the LLM was unable
 * to corroborate the detection.
 *
 * @param candidate  The candidate observation from the detection layer
 * @param severity   The deterministic severity result
 * @param service    Service configuration
 * @returns          A minimal observation with reduced confidence
 */
export function generateMinimalObservation(
  candidate: CandidateObservation,
  severity: SeverityResult,
  service: ServiceConfig,
): MinimalObservation {
  return {
    ...candidate,
    summary: `[Auto-generated] ${candidate.error_type ?? 'error'} detected on ${service.name}. LLM analysis unavailable.`,
    root_cause_hypothesis: 'LLM analysis unavailable. Manual investigation required.',
    recommended_action: 'Review metrics and logs manually.',
    llm_analysis_available: false,
    severity: severity.severity,
    confidence: severity.score * 0.7, // Reduce confidence without LLM corroboration
  };
}

// ---------------------------------------------------------------------------
// Failure 2: Token budget exceeded mid-run
// ---------------------------------------------------------------------------

/**
 * Tracks token consumption against a configured maximum budget.
 *
 * Used by the runner loop to decide whether to continue processing
 * additional services or halt early.
 */
export class TokenBudgetTracker {
  private consumed: number = 0;

  /**
   * @param maxTokens  Maximum token budget for the run (default: 200,000 per NFR-005)
   */
  constructor(private readonly maxTokens: number = 200_000) {}

  /**
   * Records tokens consumed by a service processing step.
   */
  record(tokens: number): void {
    this.consumed += tokens;
  }

  /**
   * Returns true when the entire budget has been consumed.
   */
  isExhausted(): boolean {
    return this.consumed >= this.maxTokens;
  }

  /**
   * Returns true when there is enough budget remaining to process
   * the next estimated service.
   *
   * @param estimatedNextServiceTokens  Estimated tokens for the next service (default: 30,000)
   */
  canContinue(estimatedNextServiceTokens: number = 30_000): boolean {
    return this.consumed + estimatedNextServiceTokens <= this.maxTokens;
  }

  /**
   * Returns the number of tokens remaining in the budget.
   */
  get remaining(): number {
    return Math.max(0, this.maxTokens - this.consumed);
  }

  /**
   * Returns the number of tokens consumed so far.
   */
  get tokensConsumed(): number {
    return this.consumed;
  }

  /**
   * Returns the maximum token budget.
   */
  get budget(): number {
    return this.maxTokens;
  }
}

// ---------------------------------------------------------------------------
// Runner loop integration helpers
// ---------------------------------------------------------------------------

/**
 * Metadata collected during a run, including any errors encountered.
 */
export interface RunMetadata {
  errors: string[];
  skipped_services: string[];
  completed_services: string[];
}

/**
 * Determines which services should be skipped due to token budget
 * exhaustion, given the list of remaining services.
 *
 * @param tokenBudget        The token budget tracker
 * @param currentService     The service currently being processed
 * @param remainingServices  Services not yet processed
 * @param auditLog           Audit logger
 * @param metadata           Run metadata to record skipped services
 * @returns                  True if processing should halt after current service
 */
export function shouldHaltForBudget(
  tokenBudget: TokenBudgetTracker,
  currentService: string,
  remainingServices: string[],
  auditLog: AuditLogger,
  metadata: RunMetadata,
): boolean {
  if (!tokenBudget.canContinue()) {
    auditLog.warn(
      `Token budget exhausted (${tokenBudget.tokensConsumed}/${tokenBudget.budget}). ` +
        `Completing current service ${currentService}, skipping remaining: ${remainingServices.join(', ')}`,
    );
    metadata.errors.push(
      `Token budget exceeded. Skipped: ${remainingServices.join(', ')}`,
    );
    metadata.skipped_services.push(...remainingServices);
    return true;
  }
  return false;
}
