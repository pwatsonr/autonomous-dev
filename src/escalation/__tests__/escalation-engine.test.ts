/**
 * Unit tests for EscalationEngine facade (SPEC-009-2-4, Task 9).
 *
 * All dependencies are mocked. Tests verify:
 *   1. raise() classifies and formats
 *   2. raise() routes and starts chain
 *   3. Security type halts immediately
 *   4. Infrastructure pauses immediately
 *   5. Cost pauses before incurring
 *   6. Product/technical/quality pause at boundary
 *   7. Re-escalation links previous ID
 *   8. cancelPending delegates to chain manager
 */

import { EscalationEngine, resolvePipelineBehavior } from "../escalation-engine";
import type { FailureContext, ClassificationResult } from "../classifier";
import type {
  AuditTrail,
  EscalationMessage,
  FormatterInput,
  ResolvedRoute,
  RequestContext,
  ChainState,
  RoutingTarget,
} from "../types";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockClassifier(result: ClassificationResult) {
  return {
    classify: jest.fn((_ctx: FailureContext) => result),
  };
}

function createMockFormatter() {
  let callCount = 0;
  return {
    format: jest.fn((input: FormatterInput): EscalationMessage => {
      callCount++;
      return {
        schema_version: "v1",
        escalation_id: `esc-20260408-${String(callCount).padStart(3, "0")}`,
        timestamp: new Date().toISOString(),
        request_id: input.requestId,
        repository: input.repository,
        pipeline_phase: input.pipelinePhase,
        escalation_type: input.escalationType,
        urgency: input.urgency,
        summary: `[${input.escalationType}] ${input.pipelinePhase}: ${input.failureReason}`.slice(0, 200),
        failure_reason: input.failureReason,
        options: input.options,
        retry_count: input.retryCount,
        ...(input.previousEscalationId != null
          ? { previous_escalation_id: input.previousEscalationId }
          : {}),
        ...(input.costImpact != null ? { cost_impact: input.costImpact } : {}),
      } as EscalationMessage;
    }),
  };
}

function createMockRoutingEngine(route?: Partial<ResolvedRoute>) {
  const defaultRoute: ResolvedRoute = {
    primary: { target_id: "default", display_name: "Default", channel: "slack" },
    timeoutMinutes: 60,
    timeoutBehavior: "pause",
    ...route,
  };
  return {
    resolveRouting: jest.fn(() => defaultRoute),
  };
}

function createMockChainManager() {
  return {
    startChain: jest.fn(
      (msg: EscalationMessage, route: ResolvedRoute): ChainState => ({
        escalationId: msg.escalation_id,
        requestId: msg.request_id,
        status: "primary_dispatched",
        primaryTarget: route.primary,
        secondaryTarget: route.secondary,
        primaryDispatchedAt: new Date(),
        timeoutBehavior: route.timeoutBehavior,
        timeoutMinutes: route.timeoutMinutes,
      }),
    ),
    cancelChain: jest.fn(),
    cancelAllPendingForRequest: jest.fn(),
    cancelAllPending: jest.fn(),
    getChainState: jest.fn(() => null),
  };
}

function createMockAuditTrail(): AuditTrail {
  return {
    append: jest.fn(async () => {}),
  };
}

function makeFailureContext(overrides: Partial<FailureContext> = {}): FailureContext {
  return {
    pipelinePhase: "code_review",
    errorType: "review_failed",
    errorMessage: "Code review failed after retries",
    retryCount: 3,
    maxRetries: 3,
    ...overrides,
  };
}

function makeRequestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: "req-1",
    repository: "my-repo",
    pipelinePhase: "code_review",
    retryCount: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EscalationEngine", () => {
  // =========================================================================
  // Test Case 1: raise() classifies and formats
  // =========================================================================
  test("raise() calls classifier with failure context and formatter with correct inputs", () => {
    const classifier = createMockClassifier({ type: "quality", urgency: "soon" });
    const formatter = createMockFormatter();
    const routing = createMockRoutingEngine();
    const chain = createMockChainManager();
    const audit = createMockAuditTrail();

    const engine = new EscalationEngine(
      classifier as any,
      formatter as any,
      routing as any,
      chain as any,
      audit,
    );

    const failureCtx = makeFailureContext();
    const reqCtx = makeRequestContext();

    engine.raise(failureCtx, reqCtx);

    expect(classifier.classify).toHaveBeenCalledWith(failureCtx);
    expect(formatter.format).toHaveBeenCalledTimes(1);

    const formatCall = formatter.format.mock.calls[0][0];
    expect(formatCall.escalationType).toBe("quality");
    expect(formatCall.urgency).toBe("soon");
    expect(formatCall.requestId).toBe("req-1");
    expect(formatCall.repository).toBe("my-repo");
  });

  // =========================================================================
  // Test Case 2: raise() routes and starts chain
  // =========================================================================
  test("raise() calls routing engine and chain manager", () => {
    const classifier = createMockClassifier({ type: "quality", urgency: "soon" });
    const formatter = createMockFormatter();
    const routing = createMockRoutingEngine();
    const chain = createMockChainManager();
    const audit = createMockAuditTrail();

    const engine = new EscalationEngine(
      classifier as any,
      formatter as any,
      routing as any,
      chain as any,
      audit,
    );

    engine.raise(makeFailureContext(), makeRequestContext());

    expect(routing.resolveRouting).toHaveBeenCalledWith("quality");
    expect(chain.startChain).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // Test Case 3: Security type halts immediately
  // =========================================================================
  test("security failure returns halt_immediately pipeline behavior", () => {
    const classifier = createMockClassifier({ type: "security", urgency: "immediate" });
    const formatter = createMockFormatter();
    const routing = createMockRoutingEngine();
    const chain = createMockChainManager();
    const audit = createMockAuditTrail();

    const engine = new EscalationEngine(
      classifier as any,
      formatter as any,
      routing as any,
      chain as any,
      audit,
    );

    const result = engine.raise(
      makeFailureContext({
        securityFindings: [{ severity: "critical", count: 1 }],
      }),
      makeRequestContext(),
    );

    expect(result.pipelineBehavior).toBe("halt_immediately");
  });

  // =========================================================================
  // Test Case 4: Infrastructure pauses immediately
  // =========================================================================
  test("infrastructure failure returns pause_immediately pipeline behavior", () => {
    const classifier = createMockClassifier({ type: "infrastructure", urgency: "soon" });
    const formatter = createMockFormatter();
    const routing = createMockRoutingEngine();
    const chain = createMockChainManager();
    const audit = createMockAuditTrail();

    const engine = new EscalationEngine(
      classifier as any,
      formatter as any,
      routing as any,
      chain as any,
      audit,
    );

    const result = engine.raise(
      makeFailureContext({ cicdFailure: true }),
      makeRequestContext(),
    );

    expect(result.pipelineBehavior).toBe("pause_immediately");
  });

  // =========================================================================
  // Test Case 5: Cost pauses before incurring
  // =========================================================================
  test("cost failure returns pause_before_incurring pipeline behavior", () => {
    const classifier = createMockClassifier({ type: "cost", urgency: "soon" });
    const formatter = createMockFormatter();
    const routing = createMockRoutingEngine();
    const chain = createMockChainManager();
    const audit = createMockAuditTrail();

    const engine = new EscalationEngine(
      classifier as any,
      formatter as any,
      routing as any,
      chain as any,
      audit,
    );

    const result = engine.raise(
      makeFailureContext({
        costData: { estimated: 200, threshold: 100 },
      }),
      makeRequestContext(),
    );

    expect(result.pipelineBehavior).toBe("pause_before_incurring");
  });

  // =========================================================================
  // Test Case 6: Product/technical/quality pause at boundary
  // =========================================================================
  test("product failure returns pause_at_boundary", () => {
    const classifier = createMockClassifier({ type: "product", urgency: "informational" });
    const formatter = createMockFormatter();
    const routing = createMockRoutingEngine();
    const chain = createMockChainManager();
    const audit = createMockAuditTrail();

    const engine = new EscalationEngine(
      classifier as any,
      formatter as any,
      routing as any,
      chain as any,
      audit,
    );

    const result = engine.raise(makeFailureContext(), makeRequestContext());
    expect(result.pipelineBehavior).toBe("pause_at_boundary");
  });

  test("technical failure returns pause_at_boundary", () => {
    const classifier = createMockClassifier({ type: "technical", urgency: "soon" });
    const formatter = createMockFormatter();
    const routing = createMockRoutingEngine();
    const chain = createMockChainManager();
    const audit = createMockAuditTrail();

    const engine = new EscalationEngine(
      classifier as any,
      formatter as any,
      routing as any,
      chain as any,
      audit,
    );

    const result = engine.raise(makeFailureContext(), makeRequestContext());
    expect(result.pipelineBehavior).toBe("pause_at_boundary");
  });

  test("quality failure returns pause_at_boundary", () => {
    const classifier = createMockClassifier({ type: "quality", urgency: "soon" });
    const formatter = createMockFormatter();
    const routing = createMockRoutingEngine();
    const chain = createMockChainManager();
    const audit = createMockAuditTrail();

    const engine = new EscalationEngine(
      classifier as any,
      formatter as any,
      routing as any,
      chain as any,
      audit,
    );

    const result = engine.raise(makeFailureContext(), makeRequestContext());
    expect(result.pipelineBehavior).toBe("pause_at_boundary");
  });

  // =========================================================================
  // Test Case 7: Re-escalation links previous ID
  // =========================================================================
  test("previousEscalationId is propagated to formatter", () => {
    const classifier = createMockClassifier({ type: "quality", urgency: "soon" });
    const formatter = createMockFormatter();
    const routing = createMockRoutingEngine();
    const chain = createMockChainManager();
    const audit = createMockAuditTrail();

    const engine = new EscalationEngine(
      classifier as any,
      formatter as any,
      routing as any,
      chain as any,
      audit,
    );

    engine.raise(
      makeFailureContext(),
      makeRequestContext({
        previousEscalationId: "esc-20260407-005",
      }),
    );

    const formatCall = formatter.format.mock.calls[0][0];
    expect(formatCall.previousEscalationId).toBe("esc-20260407-005");
  });

  // =========================================================================
  // Test Case 8: cancelPending delegates to chain manager
  // =========================================================================
  test("cancelPending delegates to cancelAllPendingForRequest", () => {
    const classifier = createMockClassifier({ type: "quality", urgency: "soon" });
    const formatter = createMockFormatter();
    const routing = createMockRoutingEngine();
    const chain = createMockChainManager();
    const audit = createMockAuditTrail();

    const engine = new EscalationEngine(
      classifier as any,
      formatter as any,
      routing as any,
      chain as any,
      audit,
    );

    engine.cancelPending("req-42");

    expect(chain.cancelAllPendingForRequest).toHaveBeenCalledWith("req-42");
  });

  // =========================================================================
  // Additional: cancelAllPending delegates
  // =========================================================================
  test("cancelAllPending delegates to chain manager cancelAllPending", () => {
    const classifier = createMockClassifier({ type: "quality", urgency: "soon" });
    const formatter = createMockFormatter();
    const routing = createMockRoutingEngine();
    const chain = createMockChainManager();
    const audit = createMockAuditTrail();

    const engine = new EscalationEngine(
      classifier as any,
      formatter as any,
      routing as any,
      chain as any,
      audit,
    );

    engine.cancelAllPending();

    expect(chain.cancelAllPending).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // Additional: raise() returns message with correct fields
  // =========================================================================
  test("raise() returns a result with a valid EscalationMessage", () => {
    const classifier = createMockClassifier({ type: "quality", urgency: "soon" });
    const formatter = createMockFormatter();
    const routing = createMockRoutingEngine();
    const chain = createMockChainManager();
    const audit = createMockAuditTrail();

    const engine = new EscalationEngine(
      classifier as any,
      formatter as any,
      routing as any,
      chain as any,
      audit,
    );

    const result = engine.raise(makeFailureContext(), makeRequestContext());

    expect(result.message.schema_version).toBe("v1");
    expect(result.message.escalation_type).toBe("quality");
    expect(result.message.urgency).toBe("soon");
    expect(result.message.request_id).toBe("req-1");
  });
});

// ---------------------------------------------------------------------------
// resolvePipelineBehavior standalone tests
// ---------------------------------------------------------------------------

describe("resolvePipelineBehavior", () => {
  test("security -> halt_immediately", () => {
    expect(resolvePipelineBehavior("security")).toBe("halt_immediately");
  });

  test("infrastructure -> pause_immediately", () => {
    expect(resolvePipelineBehavior("infrastructure")).toBe("pause_immediately");
  });

  test("cost -> pause_before_incurring", () => {
    expect(resolvePipelineBehavior("cost")).toBe("pause_before_incurring");
  });

  test("product -> pause_at_boundary", () => {
    expect(resolvePipelineBehavior("product")).toBe("pause_at_boundary");
  });

  test("technical -> pause_at_boundary", () => {
    expect(resolvePipelineBehavior("technical")).toBe("pause_at_boundary");
  });

  test("quality -> pause_at_boundary", () => {
    expect(resolvePipelineBehavior("quality")).toBe("pause_at_boundary");
  });
});
