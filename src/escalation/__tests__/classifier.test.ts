/**
 * Unit tests for EscalationClassifier (SPEC-009-2-1).
 *
 * Verifies the priority-based classification rules:
 *   P1: security findings (severity >= high) -> security/immediate
 *   P2: CI/CD or environment failure -> infrastructure/soon
 *   P3: cost threshold exceeded -> cost/soon
 *   P4: review gate failure after max retries -> quality/soon
 *   P5: implementation failure after max retries -> technical/soon
 *   P6: catch-all -> product/informational
 *
 * Also verifies ambiguity resolution (higher priority wins) and the
 * immutable security urgency invariant.
 */

import { EscalationClassifier } from "../classifier";
import type { FailureContext } from "../classifier";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<FailureContext> = {}): FailureContext {
  return {
    pipelinePhase: "implementation",
    errorType: "generic",
    errorMessage: "Something went wrong",
    retryCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EscalationClassifier", () => {
  let classifier: EscalationClassifier;

  beforeEach(() => {
    classifier = new EscalationClassifier();
  });

  // =========================================================================
  // Test Case 1: Security finding -> security/immediate
  // =========================================================================
  test("security finding with high severity classifies as security/immediate", () => {
    const result = classifier.classify(
      makeContext({
        securityFindings: [{ severity: "high", count: 2 }],
      }),
    );

    expect(result.type).toBe("security");
    expect(result.urgency).toBe("immediate");
  });

  // =========================================================================
  // Test Case 2: CI/CD failure -> infrastructure/soon
  // =========================================================================
  test("CI/CD failure classifies as infrastructure/soon", () => {
    const result = classifier.classify(
      makeContext({ cicdFailure: true }),
    );

    expect(result.type).toBe("infrastructure");
    expect(result.urgency).toBe("soon");
  });

  // =========================================================================
  // Test Case 3: Environment failure -> infrastructure/soon
  // =========================================================================
  test("environment failure classifies as infrastructure/soon", () => {
    const result = classifier.classify(
      makeContext({ environmentFailure: true }),
    );

    expect(result.type).toBe("infrastructure");
    expect(result.urgency).toBe("soon");
  });

  // =========================================================================
  // Test Case 4: Cost exceeded -> cost/soon
  // =========================================================================
  test("cost threshold exceeded classifies as cost/soon", () => {
    const result = classifier.classify(
      makeContext({
        costData: { estimated: 150, threshold: 100 },
      }),
    );

    expect(result.type).toBe("cost");
    expect(result.urgency).toBe("soon");
  });

  // =========================================================================
  // Test Case 5: Review gate failed after retries -> quality/soon
  // =========================================================================
  test("review gate failure after max retries classifies as quality/soon", () => {
    const result = classifier.classify(
      makeContext({
        pipelinePhase: "code_review",
        retryCount: 3,
        maxRetries: 3,
      }),
    );

    expect(result.type).toBe("quality");
    expect(result.urgency).toBe("soon");
  });

  // =========================================================================
  // Test Case 6: Implementation failure after retries -> technical/soon
  // =========================================================================
  test("implementation failure after max retries classifies as technical/soon", () => {
    const result = classifier.classify(
      makeContext({
        pipelinePhase: "implementation",
        retryCount: 5,
        maxRetries: 5,
      }),
    );

    expect(result.type).toBe("technical");
    expect(result.urgency).toBe("soon");
  });

  // =========================================================================
  // Test Case 7: Ambiguous requirements -> product/informational
  // =========================================================================
  test("no specific failure signals classifies as product/informational", () => {
    const result = classifier.classify(
      makeContext({
        pipelinePhase: "requirements_analysis",
        retryCount: 0,
        maxRetries: 3,
      }),
    );

    expect(result.type).toBe("product");
    expect(result.urgency).toBe("informational");
  });

  // =========================================================================
  // Test Case 8: Ambiguity resolution: security + infrastructure
  // =========================================================================
  test("security + infrastructure signals resolves to security (higher priority)", () => {
    const result = classifier.classify(
      makeContext({
        securityFindings: [{ severity: "critical", count: 1 }],
        cicdFailure: true,
      }),
    );

    expect(result.type).toBe("security");
    expect(result.urgency).toBe("immediate");
  });

  // =========================================================================
  // Test Case 9: Ambiguity resolution: cost + quality
  // =========================================================================
  test("cost + quality signals resolves to cost (higher priority)", () => {
    const result = classifier.classify(
      makeContext({
        pipelinePhase: "code_review",
        costData: { estimated: 200, threshold: 100 },
        retryCount: 3,
        maxRetries: 3,
      }),
    );

    expect(result.type).toBe("cost");
    expect(result.urgency).toBe("soon");
  });

  // =========================================================================
  // Test Case 10: Security urgency is immutable
  // =========================================================================
  test("security urgency is always immediate regardless of other signals", () => {
    const result = classifier.classify(
      makeContext({
        securityFindings: [{ severity: "high", count: 1 }],
        // No other signals that would suggest informational
      }),
    );

    expect(result.type).toBe("security");
    expect(result.urgency).toBe("immediate");
  });

  // =========================================================================
  // Test Case 11: No security findings = not security
  // =========================================================================
  test("empty security findings array does not classify as security", () => {
    const result = classifier.classify(
      makeContext({
        securityFindings: [],
      }),
    );

    expect(result.type).not.toBe("security");
  });

  // =========================================================================
  // Test Case 12: Low-severity security finding
  // =========================================================================
  test("low-severity security finding does not classify as security", () => {
    const result = classifier.classify(
      makeContext({
        securityFindings: [{ severity: "low", count: 1 }],
      }),
    );

    expect(result.type).not.toBe("security");
  });

  // =========================================================================
  // Additional: critical severity triggers security
  // =========================================================================
  test("critical severity security finding classifies as security", () => {
    const result = classifier.classify(
      makeContext({
        securityFindings: [{ severity: "critical", count: 1 }],
      }),
    );

    expect(result.type).toBe("security");
    expect(result.urgency).toBe("immediate");
  });

  // =========================================================================
  // Additional: retries not exhausted does not trigger quality
  // =========================================================================
  test("review gate failure before max retries does not classify as quality", () => {
    const result = classifier.classify(
      makeContext({
        pipelinePhase: "code_review",
        retryCount: 1,
        maxRetries: 3,
      }),
    );

    // Falls through to catch-all since retries are not exhausted
    expect(result.type).toBe("product");
  });

  // =========================================================================
  // Additional: cost at threshold is not exceeded
  // =========================================================================
  test("cost at threshold (not exceeded) does not classify as cost", () => {
    const result = classifier.classify(
      makeContext({
        costData: { estimated: 100, threshold: 100 },
      }),
    );

    expect(result.type).not.toBe("cost");
  });
});
