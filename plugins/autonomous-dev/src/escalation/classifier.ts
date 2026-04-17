/**
 * Escalation classifier -- maps pipeline failure contexts to escalation types.
 *
 * The classifier is the entry point for all escalation decisions. Every
 * pipeline failure passes through it to determine the type and urgency
 * of human intervention needed.
 *
 * Classification rules are evaluated in strict priority order (first match
 * wins). This guarantees deterministic ambiguity resolution when a failure
 * matches multiple conditions.
 *
 * Based on SPEC-009-2-1 (TDD Section 3.2).
 */

import type { EscalationType, EscalationUrgency } from "./types";

// ---------------------------------------------------------------------------
// Failure context
// ---------------------------------------------------------------------------

/** The contextual data about a pipeline failure used for classification. */
export interface FailureContext {
  /** Pipeline phase where the failure occurred (e.g. "code_review", "deployment"). */
  pipelinePhase: string;

  /** Machine-readable error type identifier. */
  errorType: string;

  /** Human-readable error message. */
  errorMessage: string;

  /** Additional structured error details. */
  errorDetails?: Record<string, unknown>;

  /** Number of retries already attempted for this failure. */
  retryCount: number;

  /** Maximum retries allowed before escalation. */
  maxRetries: number;

  /** Cost data, present when the failure has financial implications. */
  costData?: { estimated: number; threshold: number };

  /** Security scan findings, present when security checks have run. */
  securityFindings?: { severity: string; count: number }[];

  /** Whether this failure originated from CI/CD infrastructure. */
  cicdFailure?: boolean;

  /** Whether this failure originated from environment provisioning. */
  environmentFailure?: boolean;
}

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

/** The result of classifying a pipeline failure. */
export interface ClassificationResult {
  type: EscalationType;
  urgency: EscalationUrgency;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Security severity levels considered "high" or above for escalation. */
const HIGH_SEVERITY_LEVELS: ReadonlySet<string> = new Set([
  "high",
  "critical",
]);

/** Pipeline phases that correspond to review gates. */
const REVIEW_GATE_PHASES: ReadonlySet<string> = new Set([
  "code_review",
  "test_review",
  "quality_gate",
  "security_review",
  "prd_approval",
]);

/** Pipeline phases that correspond to implementation work. */
const IMPLEMENTATION_PHASES: ReadonlySet<string> = new Set([
  "implementation",
  "coding",
  "build",
  "compilation",
  "testing",
  "deployment",
]);

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Maps pipeline failure contexts to escalation types and urgency levels.
 *
 * Rules are evaluated in priority order (1 = highest). The first matching
 * rule determines the classification. This ensures deterministic resolution
 * when a failure matches multiple conditions simultaneously.
 *
 * Priority table:
 *   1. Security findings (severity >= "high")  -> security / immediate
 *   2. CI/CD or environment failure             -> infrastructure / soon
 *   3. Cost threshold exceeded                  -> cost / soon
 *   4. Review gate failed after max retries     -> quality / soon
 *   5. Implementation failure after max retries -> technical / soon
 *   6. Everything else                          -> product / informational
 *
 * Invariant: security type always forces urgency to "immediate".
 */
export class EscalationClassifier {
  /**
   * Classify a pipeline failure into an escalation type and urgency.
   *
   * @param context  The failure context describing what went wrong.
   * @returns The escalation type and urgency level.
   */
  classify(context: FailureContext): ClassificationResult {
    // Priority 1: Security findings with severity >= "high"
    if (this.hasHighSeveritySecurityFindings(context)) {
      return { type: "security", urgency: "immediate" };
    }

    // Priority 2: CI/CD or environment infrastructure failure
    if (context.cicdFailure === true || context.environmentFailure === true) {
      return { type: "infrastructure", urgency: "soon" };
    }

    // Priority 3: Cost threshold exceeded
    if (
      context.costData != null &&
      context.costData.estimated > context.costData.threshold
    ) {
      return { type: "cost", urgency: "soon" };
    }

    // Priority 4: Review gate failure after exhausting retries
    if (this.isReviewGatePhase(context) && this.retriesExhausted(context)) {
      return { type: "quality", urgency: "soon" };
    }

    // Priority 5: Implementation failure after exhausting retries
    if (
      this.isImplementationPhase(context) &&
      this.retriesExhausted(context)
    ) {
      return { type: "technical", urgency: "soon" };
    }

    // Priority 6: Catch-all -- ambiguous requirements, unclear specs, etc.
    return { type: "product", urgency: "informational" };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Returns true if the context contains security findings with at least
   * one finding at severity "high" or "critical".
   *
   * An empty findings array does NOT qualify.
   */
  private hasHighSeveritySecurityFindings(context: FailureContext): boolean {
    if (
      context.securityFindings == null ||
      context.securityFindings.length === 0
    ) {
      return false;
    }

    return context.securityFindings.some((finding) =>
      HIGH_SEVERITY_LEVELS.has(finding.severity.toLowerCase()),
    );
  }

  /** Returns true if the pipeline phase is a review gate. */
  private isReviewGatePhase(context: FailureContext): boolean {
    return REVIEW_GATE_PHASES.has(context.pipelinePhase);
  }

  /** Returns true if the pipeline phase is an implementation phase. */
  private isImplementationPhase(context: FailureContext): boolean {
    return IMPLEMENTATION_PHASES.has(context.pipelinePhase);
  }

  /** Returns true if retryCount >= maxRetries (retry budget exhausted). */
  private retriesExhausted(context: FailureContext): boolean {
    return context.retryCount >= context.maxRetries;
  }
}
