import { EscalationClassifier } from "../../src/escalation/classifier";
import type { FailureContext } from "../../src/escalation/classifier";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a FailureContext with sensible defaults, overridden by `overrides`. */
function makeContext(overrides: Partial<FailureContext> = {}): FailureContext {
  return {
    pipelinePhase: "implementation",
    errorType: "unknown",
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

  // -------------------------------------------------------------------------
  // Test Case 1: Security finding -> security/immediate (AC 5)
  // -------------------------------------------------------------------------
  test("security finding with high severity classifies as security/immediate", () => {
    const context = makeContext({
      securityFindings: [{ severity: "high", count: 2 }],
    });

    const result = classifier.classify(context);

    expect(result.type).toBe("security");
    expect(result.urgency).toBe("immediate");
  });

  // -------------------------------------------------------------------------
  // Test Case 2: CI/CD failure -> infrastructure/soon (AC 6)
  // -------------------------------------------------------------------------
  test("CI/CD failure classifies as infrastructure/soon", () => {
    const context = makeContext({
      cicdFailure: true,
    });

    const result = classifier.classify(context);

    expect(result.type).toBe("infrastructure");
    expect(result.urgency).toBe("soon");
  });

  // -------------------------------------------------------------------------
  // Test Case 3: Environment failure -> infrastructure/soon (AC 6)
  // -------------------------------------------------------------------------
  test("environment failure classifies as infrastructure/soon", () => {
    const context = makeContext({
      environmentFailure: true,
    });

    const result = classifier.classify(context);

    expect(result.type).toBe("infrastructure");
    expect(result.urgency).toBe("soon");
  });

  // -------------------------------------------------------------------------
  // Test Case 4: Cost exceeded -> cost/soon (AC 7)
  // -------------------------------------------------------------------------
  test("cost threshold exceeded classifies as cost/soon", () => {
    const context = makeContext({
      costData: { estimated: 150, threshold: 100 },
    });

    const result = classifier.classify(context);

    expect(result.type).toBe("cost");
    expect(result.urgency).toBe("soon");
  });

  // -------------------------------------------------------------------------
  // Test Case 5: Review gate failed after retries -> quality/soon (AC 8)
  // -------------------------------------------------------------------------
  test("review gate failure after max retries classifies as quality/soon", () => {
    const context = makeContext({
      pipelinePhase: "code_review",
      retryCount: 3,
      maxRetries: 3,
    });

    const result = classifier.classify(context);

    expect(result.type).toBe("quality");
    expect(result.urgency).toBe("soon");
  });

  // -------------------------------------------------------------------------
  // Test Case 6: Implementation failure after retries -> technical/soon (AC 9)
  // -------------------------------------------------------------------------
  test("implementation failure after max retries classifies as technical/soon", () => {
    const context = makeContext({
      pipelinePhase: "implementation",
      retryCount: 5,
      maxRetries: 5,
    });

    const result = classifier.classify(context);

    expect(result.type).toBe("technical");
    expect(result.urgency).toBe("soon");
  });

  // -------------------------------------------------------------------------
  // Test Case 7: Ambiguous requirements -> product/informational (AC 10)
  // -------------------------------------------------------------------------
  test("no specific failure signals classifies as product/informational", () => {
    const context = makeContext({
      pipelinePhase: "requirements",
      errorType: "ambiguous_spec",
      errorMessage: "Requirements are unclear",
    });

    const result = classifier.classify(context);

    expect(result.type).toBe("product");
    expect(result.urgency).toBe("informational");
  });

  // -------------------------------------------------------------------------
  // Test Case 8: Ambiguity resolution -- security + infrastructure (AC 11)
  // -------------------------------------------------------------------------
  test("security + infrastructure ambiguity resolves to security (higher priority)", () => {
    const context = makeContext({
      securityFindings: [{ severity: "critical", count: 1 }],
      cicdFailure: true,
    });

    const result = classifier.classify(context);

    expect(result.type).toBe("security");
    expect(result.urgency).toBe("immediate");
  });

  // -------------------------------------------------------------------------
  // Test Case 9: Ambiguity resolution -- cost + quality (AC 11)
  // -------------------------------------------------------------------------
  test("cost + quality ambiguity resolves to cost (higher priority)", () => {
    const context = makeContext({
      pipelinePhase: "code_review",
      costData: { estimated: 200, threshold: 100 },
      retryCount: 3,
      maxRetries: 3,
    });

    const result = classifier.classify(context);

    expect(result.type).toBe("cost");
    expect(result.urgency).toBe("soon");
  });

  // -------------------------------------------------------------------------
  // Test Case 10: Security urgency is immutable (AC 12)
  // -------------------------------------------------------------------------
  test("security urgency is always immediate even if other signals suggest informational", () => {
    const context = makeContext({
      pipelinePhase: "requirements",
      errorType: "ambiguous_spec",
      securityFindings: [{ severity: "high", count: 1 }],
      retryCount: 0,
      maxRetries: 10,
    });

    const result = classifier.classify(context);

    expect(result.type).toBe("security");
    expect(result.urgency).toBe("immediate");
  });

  // -------------------------------------------------------------------------
  // Test Case 11: No security findings = not security
  // -------------------------------------------------------------------------
  test("empty securityFindings array does not classify as security", () => {
    const context = makeContext({
      securityFindings: [],
    });

    const result = classifier.classify(context);

    expect(result.type).not.toBe("security");
  });

  // -------------------------------------------------------------------------
  // Test Case 12: Low-severity security finding is not security
  // -------------------------------------------------------------------------
  test("low-severity security finding does not classify as security", () => {
    const context = makeContext({
      securityFindings: [{ severity: "low", count: 1 }],
    });

    const result = classifier.classify(context);

    expect(result.type).not.toBe("security");
  });

  // -------------------------------------------------------------------------
  // Additional edge cases
  // -------------------------------------------------------------------------

  test("cost at threshold boundary does not classify as cost (estimated == threshold)", () => {
    const context = makeContext({
      costData: { estimated: 100, threshold: 100 },
    });

    const result = classifier.classify(context);

    // estimated must be strictly greater than threshold
    expect(result.type).not.toBe("cost");
  });

  test("review gate failure without exhausted retries does not classify as quality", () => {
    const context = makeContext({
      pipelinePhase: "code_review",
      retryCount: 1,
      maxRetries: 3,
    });

    const result = classifier.classify(context);

    // Retries not exhausted, falls through to catch-all
    expect(result.type).toBe("product");
    expect(result.urgency).toBe("informational");
  });

  test("implementation failure without exhausted retries does not classify as technical", () => {
    const context = makeContext({
      pipelinePhase: "implementation",
      retryCount: 2,
      maxRetries: 5,
    });

    const result = classifier.classify(context);

    expect(result.type).toBe("product");
    expect(result.urgency).toBe("informational");
  });

  test("medium-severity security finding does not classify as security", () => {
    const context = makeContext({
      securityFindings: [{ severity: "medium", count: 3 }],
    });

    const result = classifier.classify(context);

    expect(result.type).not.toBe("security");
  });

  test("critical severity security finding classifies as security", () => {
    const context = makeContext({
      securityFindings: [{ severity: "critical", count: 1 }],
    });

    const result = classifier.classify(context);

    expect(result.type).toBe("security");
    expect(result.urgency).toBe("immediate");
  });

  test("multiple security findings with mixed severity classifies as security when any is high", () => {
    const context = makeContext({
      securityFindings: [
        { severity: "low", count: 5 },
        { severity: "high", count: 1 },
      ],
    });

    const result = classifier.classify(context);

    expect(result.type).toBe("security");
    expect(result.urgency).toBe("immediate");
  });

  test("all review gate phases are recognized", () => {
    const reviewPhases = [
      "code_review",
      "test_review",
      "quality_gate",
      "security_review",
      "prd_approval",
    ];

    for (const phase of reviewPhases) {
      const context = makeContext({
        pipelinePhase: phase,
        retryCount: 3,
        maxRetries: 3,
      });
      const result = classifier.classify(context);
      expect(result.type).toBe("quality");
    }
  });

  test("all implementation phases are recognized", () => {
    const implPhases = [
      "implementation",
      "coding",
      "build",
      "compilation",
      "testing",
      "deployment",
    ];

    for (const phase of implPhases) {
      const context = makeContext({
        pipelinePhase: phase,
        retryCount: 5,
        maxRetries: 5,
      });
      const result = classifier.classify(context);
      expect(result.type).toBe("technical");
    }
  });
});
