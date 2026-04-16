/**
 * Unit tests for TrustEngine facade (SPEC-009-1-4, Task 8).
 *
 * All dependencies are mocked. Tests verify:
 *   - checkGate returns correct authority for various levels/gates
 *   - Pending trust changes are applied at gate boundaries
 *   - Audit events are emitted correctly
 *   - Triple-layer security_review defense-in-depth
 *   - requestTrustChange delegates to change manager
 *   - getEffectiveLevel resolves without gate_decision event
 */

import { TrustEngine } from "../trust-engine";
import * as gateMatrix from "../gate-matrix";
import type { TrustResolutionContext } from "../trust-resolver";
import type { TrustConfig, TrustLevel, TrustLevelChangeRequest } from "../types";
import { DEFAULT_TRUST_CONFIG } from "../trust-config";

// ---------------------------------------------------------------------------
// Mock types
// ---------------------------------------------------------------------------

interface CapturedEvent {
  event_type: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockAuditTrail() {
  const events: CapturedEvent[] = [];
  return {
    events,
    append: jest.fn(async (event: CapturedEvent) => {
      events.push(event);
    }),
  };
}

function createMockResolver(level: TrustLevel) {
  return {
    resolve: jest.fn(
      (_context: TrustResolutionContext, _config: TrustConfig): TrustLevel =>
        level,
    ),
  };
}

function createMockChangeManager(overrides: {
  resolveAtGateBoundary?: (requestId: string, currentLevel: TrustLevel) => TrustLevel;
  requestChange?: jest.Mock;
} = {}) {
  return {
    resolveAtGateBoundary: jest.fn(
      overrides.resolveAtGateBoundary ??
        ((_requestId: string, currentLevel: TrustLevel) => currentLevel),
    ),
    requestChange: overrides.requestChange ?? jest.fn(),
    confirmUpgrade: jest.fn(),
    rejectUpgrade: jest.fn(),
    getPendingChange: jest.fn(() => null),
  };
}

function createMockConfigLoader(config: TrustConfig = DEFAULT_TRUST_CONFIG) {
  return {
    load: jest.fn(() => config),
    onConfigChange: jest.fn(() => () => {}),
    destroy: jest.fn(),
  };
}

function makeContext(overrides: Partial<TrustResolutionContext> = {}): TrustResolutionContext {
  return {
    requestId: overrides.requestId ?? "req-1",
    repositoryId: overrides.repositoryId ?? "repo-a",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TrustEngine", () => {
  // -------------------------------------------------------------------------
  // Test Case 1: checkGate at L0 returns human for prd_approval
  // -------------------------------------------------------------------------
  test("checkGate at L0 returns human for prd_approval", () => {
    const audit = createMockAuditTrail();
    const resolver = createMockResolver(0);
    const changeManager = createMockChangeManager();
    const configLoader = createMockConfigLoader();

    const engine = new TrustEngine(
      resolver as any,
      changeManager as any,
      configLoader as any,
      audit,
    );

    const result = engine.checkGate("prd_approval", makeContext());

    expect(result.gate).toBe("prd_approval");
    expect(result.authority).toBe("human");
    expect(result.effectiveLevel).toBe(0);
    expect(result.pendingChangeApplied).toBe(false);
    expect(result.securityOverrideRejected).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test Case 2: checkGate at L3 returns system for code_review
  // -------------------------------------------------------------------------
  test("checkGate at L3 returns system for code_review", () => {
    const audit = createMockAuditTrail();
    const resolver = createMockResolver(3);
    const changeManager = createMockChangeManager();
    const configLoader = createMockConfigLoader();

    const engine = new TrustEngine(
      resolver as any,
      changeManager as any,
      configLoader as any,
      audit,
    );

    const result = engine.checkGate("code_review", makeContext());

    expect(result.gate).toBe("code_review");
    expect(result.authority).toBe("system");
    expect(result.effectiveLevel).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Test Case 3: checkGate applies pending trust change
  // -------------------------------------------------------------------------
  test("checkGate applies pending trust change", () => {
    const audit = createMockAuditTrail();
    const resolver = createMockResolver(2);
    // Change manager returns a different level (simulating a downgrade to L0)
    const changeManager = createMockChangeManager({
      resolveAtGateBoundary: (_requestId: string, _currentLevel: TrustLevel) => 0,
    });
    const configLoader = createMockConfigLoader();

    const engine = new TrustEngine(
      resolver as any,
      changeManager as any,
      configLoader as any,
      audit,
    );

    const result = engine.checkGate("prd_approval", makeContext());

    // Should use L0 (from change manager), not L2 (from resolver)
    expect(result.effectiveLevel).toBe(0);
    expect(result.authority).toBe("human"); // L0 prd_approval = human
    expect(result.pendingChangeApplied).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test Case 4: checkGate emits gate_decision audit event
  // -------------------------------------------------------------------------
  test("checkGate emits gate_decision audit event", () => {
    const audit = createMockAuditTrail();
    const resolver = createMockResolver(1);
    const changeManager = createMockChangeManager();
    const configLoader = createMockConfigLoader();

    const engine = new TrustEngine(
      resolver as any,
      changeManager as any,
      configLoader as any,
      audit,
    );

    engine.checkGate("test_review", makeContext({ requestId: "req-42" }));

    const gateEvents = audit.events.filter(
      (e) => e.event_type === "gate_decision",
    );
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0].payload).toEqual({
      gate: "test_review",
      authority: "system", // L1 test_review = system
      effectiveLevel: 1,
      requestId: "req-42",
      pendingChangeApplied: false,
      securityOverrideRejected: false,
    });
  });

  // -------------------------------------------------------------------------
  // Test Case 5: security_review override defense-in-depth
  // -------------------------------------------------------------------------
  test("security_review normal path: lookupGateAuthority already returns human", () => {
    const audit = createMockAuditTrail();
    const resolver = createMockResolver(3);
    const changeManager = createMockChangeManager();
    const configLoader = createMockConfigLoader();

    const engine = new TrustEngine(
      resolver as any,
      changeManager as any,
      configLoader as any,
      audit,
    );

    const result = engine.checkGate("security_review", makeContext());

    expect(result.gate).toBe("security_review");
    expect(result.authority).toBe("human");
    // Under normal operation, lookupGateAuthority already returns "human",
    // so the defense-in-depth layer is not triggered
    expect(result.securityOverrideRejected).toBe(false);
  });

  test("security_review defense-in-depth: catches bypass when lookupGateAuthority returns system", () => {
    // Spy on the module's lookupGateAuthority to simulate a hypothetical bug
    // where the function returns "system" for security_review.
    // TrustEngine uses `import * as gateMatrix` so patching the module
    // export affects the engine's call site.
    const spy = jest.spyOn(gateMatrix, "lookupGateAuthority").mockImplementation(
      (level, gate) => {
        if (gate === "security_review") return "system";
        // Fall through to real implementation for other gates
        return gateMatrix.TRUST_GATE_MATRIX[level][gate];
      },
    );

    try {
      const audit = createMockAuditTrail();
      const resolver = createMockResolver(3);
      const changeManager = createMockChangeManager();
      const configLoader = createMockConfigLoader();

      const engine = new TrustEngine(
        resolver as any,
        changeManager as any,
        configLoader as any,
        audit,
      );

      const result = engine.checkGate("security_review", makeContext());

      // Defense-in-depth should catch the "system" and override to "human"
      expect(result.authority).toBe("human");
      expect(result.securityOverrideRejected).toBe(true);

      // Verify security_override_rejected audit event was emitted
      const overrideEvents = audit.events.filter(
        (e) => e.event_type === "security_override_rejected",
      );
      expect(overrideEvents).toHaveLength(1);
      expect(overrideEvents[0].payload.gate).toBe("security_review");
      expect(overrideEvents[0].payload.attemptedAuthority).toBe("system");

      // gate_decision event should also be emitted with human authority
      const gateEvents = audit.events.filter(
        (e) => e.event_type === "gate_decision",
      );
      expect(gateEvents).toHaveLength(1);
      expect(gateEvents[0].payload.authority).toBe("human");
      expect(gateEvents[0].payload.securityOverrideRejected).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // Test Case 6: requestTrustChange delegates to change manager
  // -------------------------------------------------------------------------
  test("requestTrustChange delegates to change manager", () => {
    const audit = createMockAuditTrail();
    const resolver = createMockResolver(1);
    const requestChangeMock = jest.fn();
    const changeManager = createMockChangeManager({
      requestChange: requestChangeMock,
    });
    const configLoader = createMockConfigLoader();

    const engine = new TrustEngine(
      resolver as any,
      changeManager as any,
      configLoader as any,
      audit,
    );

    const change: TrustLevelChangeRequest = {
      requestId: "req-1",
      fromLevel: 2,
      toLevel: 0,
      requestedBy: "admin",
      requestedAt: new Date("2026-04-08T12:00:00Z"),
      reason: "emergency downgrade",
      status: "pending",
    };

    engine.requestTrustChange(change);

    expect(requestChangeMock).toHaveBeenCalledTimes(1);
    expect(requestChangeMock).toHaveBeenCalledWith("req-1", change);
  });

  // -------------------------------------------------------------------------
  // Test Case 7: getEffectiveLevel resolves without gate check
  // -------------------------------------------------------------------------
  test("getEffectiveLevel resolves without emitting gate_decision event", () => {
    const audit = createMockAuditTrail();
    const resolver = createMockResolver(2);
    const changeManager = createMockChangeManager();
    const configLoader = createMockConfigLoader();

    const engine = new TrustEngine(
      resolver as any,
      changeManager as any,
      configLoader as any,
      audit,
    );

    const level = engine.getEffectiveLevel(makeContext());

    expect(level).toBe(2);

    // Should NOT have emitted any gate_decision events
    const gateEvents = audit.events.filter(
      (e) => e.event_type === "gate_decision",
    );
    expect(gateEvents).toHaveLength(0);
  });

  test("getEffectiveLevel applies pending changes", () => {
    const audit = createMockAuditTrail();
    const resolver = createMockResolver(2);
    const changeManager = createMockChangeManager({
      resolveAtGateBoundary: (_requestId: string, _currentLevel: TrustLevel) => 0,
    });
    const configLoader = createMockConfigLoader();

    const engine = new TrustEngine(
      resolver as any,
      changeManager as any,
      configLoader as any,
      audit,
    );

    const level = engine.getEffectiveLevel(makeContext());

    // Should return the level after pending change application
    expect(level).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Additional coverage: checkGate uses configLoader.load()
  // -------------------------------------------------------------------------
  test("checkGate calls configLoader.load() each invocation", () => {
    const audit = createMockAuditTrail();
    const resolver = createMockResolver(1);
    const changeManager = createMockChangeManager();
    const configLoader = createMockConfigLoader();

    const engine = new TrustEngine(
      resolver as any,
      changeManager as any,
      configLoader as any,
      audit,
    );

    engine.checkGate("prd_approval", makeContext());
    engine.checkGate("code_review", makeContext());

    expect(configLoader.load).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Additional coverage: checkGate passes config to resolver
  // -------------------------------------------------------------------------
  test("checkGate passes loaded config to resolver", () => {
    const customConfig: TrustConfig = {
      ...DEFAULT_TRUST_CONFIG,
      system_default_level: 3,
    };
    const audit = createMockAuditTrail();
    const resolver = createMockResolver(3);
    const changeManager = createMockChangeManager();
    const configLoader = createMockConfigLoader(customConfig);

    const engine = new TrustEngine(
      resolver as any,
      changeManager as any,
      configLoader as any,
      audit,
    );

    const ctx = makeContext();
    engine.checkGate("prd_approval", ctx);

    expect(resolver.resolve).toHaveBeenCalledWith(ctx, customConfig);
  });

  // -------------------------------------------------------------------------
  // Additional: all 7 gates at L0 return human
  // -------------------------------------------------------------------------
  test("all 7 gates at L0 return human authority", () => {
    const gates = [
      "prd_approval",
      "code_review",
      "test_review",
      "deployment_approval",
      "security_review",
      "cost_approval",
      "quality_gate",
    ] as const;

    const audit = createMockAuditTrail();
    const resolver = createMockResolver(0);
    const changeManager = createMockChangeManager();
    const configLoader = createMockConfigLoader();

    const engine = new TrustEngine(
      resolver as any,
      changeManager as any,
      configLoader as any,
      audit,
    );

    for (const gate of gates) {
      const result = engine.checkGate(gate, makeContext());
      expect(result.authority).toBe("human");
    }
  });

  // -------------------------------------------------------------------------
  // Additional: security_review at every trust level returns human
  // -------------------------------------------------------------------------
  test("security_review returns human at every trust level", () => {
    for (const level of [0, 1, 2, 3] as const) {
      const audit = createMockAuditTrail();
      const resolver = createMockResolver(level);
      const changeManager = createMockChangeManager();
      const configLoader = createMockConfigLoader();

      const engine = new TrustEngine(
        resolver as any,
        changeManager as any,
        configLoader as any,
        audit,
      );

      const result = engine.checkGate("security_review", makeContext());
      expect(result.authority).toBe("human");
    }
  });
});
