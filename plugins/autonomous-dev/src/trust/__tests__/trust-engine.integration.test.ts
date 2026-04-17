/**
 * Integration tests for TrustEngine (SPEC-009-1-4, Task 9).
 *
 * Wires real sub-components (TrustResolver, TrustChangeManager, gate-matrix)
 * with a mock AuditTrail and ConfigProvider. Tests full pipeline gate check
 * sequences at L0, L1, and mid-pipeline downgrade.
 */

import { TrustEngine } from "../trust-engine";
import { TrustResolver } from "../trust-resolver";
import { TrustChangeManager } from "../trust-change-manager";
import { TrustConfigLoader, DEFAULT_TRUST_CONFIG } from "../trust-config";
import type { ConfigProvider } from "../trust-config";
import type { AuditTrail } from "../trust-change-manager";
import type { TrustResolutionContext } from "../trust-resolver";
import type {
  TrustConfig,
  TrustLevel,
  PipelineGate,
  GateAuthority,
  TrustLevelChangeRequest,
} from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_GATES: PipelineGate[] = [
  "prd_approval",
  "code_review",
  "test_review",
  "deployment_approval",
  "security_review",
  "cost_approval",
  "quality_gate",
];

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface CapturedEvent {
  event_type: string;
  payload: Record<string, unknown>;
}

function createMockAuditTrail(): AuditTrail & { events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  return {
    events,
    append: jest.fn(async (event: CapturedEvent) => {
      events.push(event);
    }),
  };
}

function createMockConfigProvider(
  trustSection: Record<string, unknown> | undefined = undefined,
): ConfigProvider & { setTrustSection: (s: Record<string, unknown> | undefined) => void; triggerChange: () => void } {
  let section = trustSection;
  const callbacks: Array<() => void> = [];

  return {
    getTrustSection: () => section,
    onConfigChange: (cb: () => void) => {
      callbacks.push(cb);
      return () => {
        const idx = callbacks.indexOf(cb);
        if (idx >= 0) callbacks.splice(idx, 1);
      };
    },
    setTrustSection: (s: Record<string, unknown> | undefined) => {
      section = s;
    },
    triggerChange: () => {
      for (const cb of callbacks) cb();
    },
  };
}

/**
 * Create a fully-wired TrustEngine with real sub-components and mock
 * AuditTrail/ConfigProvider. Returns all components for inspection.
 */
function createTestEngine(config: Partial<TrustConfig> = {}) {
  const fullConfig = { ...DEFAULT_TRUST_CONFIG, ...config };
  const configProvider = createMockConfigProvider(fullConfig as unknown as Record<string, unknown>);
  const audit = createMockAuditTrail();
  const configLoader = new TrustConfigLoader(configProvider);
  const resolver = new TrustResolver();
  const changeManager = new TrustChangeManager(audit);
  const engine = new TrustEngine(resolver, changeManager, configLoader, audit);

  return { engine, audit, configProvider, configLoader, changeManager };
}

function makeContext(overrides: Partial<TrustResolutionContext> = {}): TrustResolutionContext {
  return {
    requestId: overrides.requestId ?? "req-1",
    repositoryId: overrides.repositoryId ?? "repo-a",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Integration Test 1: Full pipeline at L0
// ---------------------------------------------------------------------------

describe("Integration: Full pipeline at L0", () => {
  test("every gate pauses for human", () => {
    const { engine, audit } = createTestEngine({
      system_default_level: 0,
    });

    const context = makeContext();

    for (const gate of ALL_GATES) {
      const result = engine.checkGate(gate, context);
      expect(result.authority).toBe("human");
      expect(result.effectiveLevel).toBe(0);
      expect(result.pendingChangeApplied).toBe(false);
      expect(result.securityOverrideRejected).toBe(false);
    }

    // Verify 7 gate_decision audit events emitted
    const gateEvents = audit.events.filter(
      (e) => e.event_type === "gate_decision",
    );
    expect(gateEvents).toHaveLength(7);

    // Each event should have authority "human"
    for (const event of gateEvents) {
      expect(event.payload.authority).toBe("human");
      expect(event.payload.effectiveLevel).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration Test 2: Full pipeline at L1
// ---------------------------------------------------------------------------

describe("Integration: Full pipeline at L1", () => {
  test("PRD and code gates pause, others auto where expected", () => {
    const { engine, audit } = createTestEngine({
      system_default_level: 1,
    });

    const context = makeContext();

    const expectedAuthorities: Record<PipelineGate, GateAuthority> = {
      prd_approval: "human",
      code_review: "human",
      test_review: "system",
      deployment_approval: "human",
      security_review: "human",
      cost_approval: "human",
      quality_gate: "system",
    };

    for (const gate of ALL_GATES) {
      const result = engine.checkGate(gate, context);
      expect(result.authority).toBe(expectedAuthorities[gate]);
      expect(result.effectiveLevel).toBe(1);
    }

    // Verify 7 gate_decision audit events emitted
    const gateEvents = audit.events.filter(
      (e) => e.event_type === "gate_decision",
    );
    expect(gateEvents).toHaveLength(7);

    // Verify each event matches expected authority
    for (const event of gateEvents) {
      const gate = event.payload.gate as PipelineGate;
      expect(event.payload.authority).toBe(expectedAuthorities[gate]);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration Test 3: Mid-pipeline downgrade from L2 to L0
// ---------------------------------------------------------------------------

describe("Integration: Mid-pipeline downgrade from L2 to L0", () => {
  test("first gates use L2, then downgrade takes effect at boundary", () => {
    const { engine, audit, changeManager } = createTestEngine({
      system_default_level: 2,
    });

    const context = makeContext();

    // L2 expected authorities
    const l2Authorities: Record<PipelineGate, GateAuthority> = {
      prd_approval: "system",
      code_review: "human",
      test_review: "system",
      deployment_approval: "human",
      security_review: "human",
      cost_approval: "system",
      quality_gate: "system",
    };

    // Check first 2 gates at L2
    const firstTwoGates: PipelineGate[] = ["prd_approval", "code_review"];
    for (const gate of firstTwoGates) {
      const result = engine.checkGate(gate, context);
      expect(result.authority).toBe(l2Authorities[gate]);
      expect(result.effectiveLevel).toBe(2);
      expect(result.pendingChangeApplied).toBe(false);
    }

    // Request downgrade from L2 to L0
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

    // Check remaining 5 gates -- should now use L0 authorities (all human)
    const remainingGates: PipelineGate[] = [
      "test_review",
      "deployment_approval",
      "security_review",
      "cost_approval",
      "quality_gate",
    ];

    // The first remaining gate should pick up the pending change
    let pendingChangeAppliedOnce = false;
    for (const gate of remainingGates) {
      const result = engine.checkGate(gate, context);
      expect(result.authority).toBe("human"); // L0: all human
      expect(result.effectiveLevel).toBe(0);

      if (result.pendingChangeApplied) {
        pendingChangeAppliedOnce = true;
      }
    }

    // The pending change should have been applied at least once
    expect(pendingChangeAppliedOnce).toBe(true);

    // Verify trust_level_changed audit event was emitted
    const changedEvents = audit.events.filter(
      (e) => e.event_type === "trust_level_changed",
    );
    expect(changedEvents.length).toBeGreaterThanOrEqual(1);
    expect(changedEvents[0].payload.fromLevel).toBe(2);
    expect(changedEvents[0].payload.toLevel).toBe(0);

    // Verify gate_decision events: 2 at L2 + 5 at L0 = 7 total
    const gateEvents = audit.events.filter(
      (e) => e.event_type === "gate_decision",
    );
    expect(gateEvents).toHaveLength(7);

    // First 2 events should be at L2
    expect(gateEvents[0].payload.effectiveLevel).toBe(2);
    expect(gateEvents[1].payload.effectiveLevel).toBe(2);

    // Remaining 5 events should be at L0
    for (let i = 2; i < 7; i++) {
      expect(gateEvents[i].payload.effectiveLevel).toBe(0);
    }
  });

  test("earlier gates are NOT retroactively affected by downgrade", () => {
    const { engine, audit } = createTestEngine({
      system_default_level: 2,
    });

    const context = makeContext();

    // Check prd_approval at L2 -- should be "system"
    const earlyResult = engine.checkGate("prd_approval", context);
    expect(earlyResult.authority).toBe("system");
    expect(earlyResult.effectiveLevel).toBe(2);

    // Request downgrade
    engine.requestTrustChange({
      requestId: "req-1",
      fromLevel: 2,
      toLevel: 0,
      requestedBy: "admin",
      requestedAt: new Date("2026-04-08T12:00:00Z"),
      reason: "downgrade",
      status: "pending",
    });

    // The early result should still show L2/system -- it was already returned
    // and cannot be retroactively changed
    expect(earlyResult.authority).toBe("system");
    expect(earlyResult.effectiveLevel).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Integration: createTrustEngine factory
// ---------------------------------------------------------------------------

describe("Integration: createTrustEngine factory", () => {
  test("factory wires all dependencies correctly", () => {
    // Import the factory from the barrel
    const { createTrustEngine } = require("../index");

    const configProvider = createMockConfigProvider({
      system_default_level: 1,
      repositories: {},
      auto_demotion: { enabled: false, failure_threshold: 3, window_hours: 24 },
      promotion: {
        require_human_approval: true,
        min_successful_runs: 10,
        cooldown_hours: 72,
      },
    });
    const audit = createMockAuditTrail();

    const engine = createTrustEngine(configProvider, audit);

    // Engine should work end-to-end
    const result = engine.checkGate("test_review", makeContext());
    expect(result.authority).toBe("system"); // L1 test_review = system
    expect(result.effectiveLevel).toBe(1);

    // Verify audit event was emitted
    const gateEvents = audit.events.filter(
      (e: CapturedEvent) => e.event_type === "gate_decision",
    );
    expect(gateEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: barrel exports
// ---------------------------------------------------------------------------

describe("Integration: barrel exports", () => {
  test("TrustEngine can be imported from barrel", () => {
    const barrel = require("../index");
    expect(barrel.TrustEngine).toBeDefined();
    expect(barrel.TrustResolver).toBeDefined();
    expect(barrel.TrustChangeManager).toBeDefined();
    expect(barrel.TrustConfigLoader).toBeDefined();
    expect(barrel.lookupGateAuthority).toBeDefined();
    expect(barrel.TRUST_GATE_MATRIX).toBeDefined();
    expect(barrel.createTrustEngine).toBeDefined();
    expect(barrel.isTrustLevel).toBeDefined();
    expect(barrel.TRUST_LEVELS).toBeDefined();
    expect(barrel.DEFAULT_TRUST_CONFIG).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: full 28 gate/level combinations
// ---------------------------------------------------------------------------

describe("Integration: all 28 gate/level combinations", () => {
  const expectedMatrix: Record<TrustLevel, Record<PipelineGate, GateAuthority>> = {
    0: {
      prd_approval: "human",
      code_review: "human",
      test_review: "human",
      deployment_approval: "human",
      security_review: "human",
      cost_approval: "human",
      quality_gate: "human",
    },
    1: {
      prd_approval: "human",
      code_review: "human",
      test_review: "system",
      deployment_approval: "human",
      security_review: "human",
      cost_approval: "human",
      quality_gate: "system",
    },
    2: {
      prd_approval: "system",
      code_review: "human",
      test_review: "system",
      deployment_approval: "human",
      security_review: "human",
      cost_approval: "system",
      quality_gate: "system",
    },
    3: {
      prd_approval: "system",
      code_review: "system",
      test_review: "system",
      deployment_approval: "system",
      security_review: "human",
      cost_approval: "system",
      quality_gate: "system",
    },
  };

  for (const level of [0, 1, 2, 3] as const) {
    for (const gate of ALL_GATES) {
      test(`L${level} + ${gate} = ${expectedMatrix[level][gate]}`, () => {
        const { engine } = createTestEngine({
          system_default_level: level,
        });

        const result = engine.checkGate(gate, makeContext());
        expect(result.authority).toBe(expectedMatrix[level][gate]);
        expect(result.effectiveLevel).toBe(level);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Integration: per-repo config override
// ---------------------------------------------------------------------------

describe("Integration: per-repo config override", () => {
  test("uses per-repo trust level instead of system default", () => {
    const { engine } = createTestEngine({
      system_default_level: 0,
      repositories: {
        "repo-a": { default_level: 3 },
      },
    });

    const context = makeContext({ repositoryId: "repo-a" });
    const result = engine.checkGate("code_review", context);

    // repo-a is L3, so code_review should be "system"
    expect(result.authority).toBe("system");
    expect(result.effectiveLevel).toBe(3);
  });

  test("falls back to system default for unknown repos", () => {
    const { engine } = createTestEngine({
      system_default_level: 0,
      repositories: {
        "repo-a": { default_level: 3 },
      },
    });

    const context = makeContext({ repositoryId: "unknown-repo" });
    const result = engine.checkGate("code_review", context);

    // Unknown repo falls back to system default L0
    expect(result.authority).toBe("human");
    expect(result.effectiveLevel).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: per-request override
// ---------------------------------------------------------------------------

describe("Integration: per-request override", () => {
  test("per-request override takes precedence over all config", () => {
    const { engine } = createTestEngine({
      system_default_level: 0,
      repositories: {
        "repo-a": { default_level: 0 },
      },
    });

    const context = makeContext({
      repositoryId: "repo-a",
      requestOverride: 3,
    });

    const result = engine.checkGate("code_review", context);

    // Override is L3, so code_review should be "system"
    expect(result.authority).toBe("system");
    expect(result.effectiveLevel).toBe(3);
  });
});
