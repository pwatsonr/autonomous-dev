import { RoutingEngine } from "../../src/escalation/routing-engine";
import type {
  EscalationConfig,
  EscalationType,
  RoutingTarget,
} from "../../src/escalation/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A reusable default routing target. */
const DEFAULT_TARGET: RoutingTarget = {
  target_id: "default-team",
  display_name: "Default Team",
  channel: "slack-general",
};

/** A product-specific routing target. */
const PRODUCT_TARGET: RoutingTarget = {
  target_id: "product-team",
  display_name: "Product Team",
  channel: "slack-product",
};

/** A security-specific routing target. */
const SECURITY_TARGET: RoutingTarget = {
  target_id: "security-team",
  display_name: "Security Team",
  channel: "slack-security",
};

/** A secondary routing target. */
const SECONDARY_TARGET: RoutingTarget = {
  target_id: "escalation-manager",
  display_name: "Escalation Manager",
  channel: "slack-escalation",
};

/** An unknown routing target (not in knownTargetIds). */
const UNKNOWN_TARGET: RoutingTarget = {
  target_id: "unknown-team",
  display_name: "Unknown Team",
  channel: "unknown-channel",
};

/** Build a default-mode EscalationConfig. */
function makeDefaultConfig(
  overrides: Partial<EscalationConfig> = {},
): EscalationConfig {
  return {
    routing: {
      mode: "default",
      default_target: DEFAULT_TARGET,
    },
    verbosity: "standard",
    retry_budget: 3,
    ...overrides,
  };
}

/** Build an advanced-mode EscalationConfig with per-type routing. */
function makeAdvancedConfig(
  advancedOverrides: Partial<
    Record<
      EscalationType,
      {
        primary: RoutingTarget;
        secondary?: RoutingTarget;
        timeout_minutes: number;
        timeout_behavior: "pause" | "retry" | "skip" | "cancel";
      }
    >
  > = {},
): EscalationConfig {
  return {
    routing: {
      mode: "advanced",
      default_target: DEFAULT_TARGET,
      advanced: advancedOverrides as Record<
        EscalationType,
        {
          primary: RoutingTarget;
          secondary?: RoutingTarget;
          timeout_minutes: number;
          timeout_behavior: "pause" | "retry" | "skip" | "cancel";
        }
      >,
    },
    verbosity: "standard",
    retry_budget: 3,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RoutingEngine", () => {
  // -------------------------------------------------------------------------
  // Test Case 1: Default mode routes to default_target (AC 1)
  // -------------------------------------------------------------------------
  test("default mode routes all 6 types to the same default_target", () => {
    const config = makeDefaultConfig();
    const engine = new RoutingEngine(config);

    const allTypes: EscalationType[] = [
      "product",
      "technical",
      "infrastructure",
      "security",
      "cost",
      "quality",
    ];

    for (const type of allTypes) {
      const route = engine.resolveRouting(type);
      expect(route.primary).toEqual(DEFAULT_TARGET);
      // security will have pause forced, others will also have pause as default
      expect(route.timeoutBehavior).toBe("pause");
      expect(route.timeoutMinutes).toBe(60);
      expect(route.secondary).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // Test Case 2: Advanced mode routes product to product target (AC 2)
  // -------------------------------------------------------------------------
  test("advanced mode routes product to product-specific target", () => {
    const config = makeAdvancedConfig({
      product: {
        primary: PRODUCT_TARGET,
        secondary: SECONDARY_TARGET,
        timeout_minutes: 30,
        timeout_behavior: "retry",
      },
    });
    const engine = new RoutingEngine(config);

    const route = engine.resolveRouting("product");

    expect(route.primary).toEqual(PRODUCT_TARGET);
    expect(route.secondary).toEqual(SECONDARY_TARGET);
    expect(route.timeoutMinutes).toBe(30);
    expect(route.timeoutBehavior).toBe("retry");
  });

  // -------------------------------------------------------------------------
  // Test Case 3: Advanced mode routes security to security target (AC 2, 5)
  // -------------------------------------------------------------------------
  test("advanced mode routes security to security-specific target", () => {
    const config = makeAdvancedConfig({
      security: {
        primary: SECURITY_TARGET,
        timeout_minutes: 15,
        timeout_behavior: "cancel", // Will be forced to pause
      },
    });
    const engine = new RoutingEngine(config);

    const route = engine.resolveRouting("security");

    expect(route.primary).toEqual(SECURITY_TARGET);
    expect(route.timeoutMinutes).toBe(15);
    // Security invariant: always pause
    expect(route.timeoutBehavior).toBe("pause");
  });

  // -------------------------------------------------------------------------
  // Test Case 4: Advanced mode missing type falls back (AC 3)
  // -------------------------------------------------------------------------
  test("advanced mode missing type config falls back to default_target with warning", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const config = makeAdvancedConfig({
      product: {
        primary: PRODUCT_TARGET,
        timeout_minutes: 30,
        timeout_behavior: "retry",
      },
      // "cost" is NOT configured
    });
    const engine = new RoutingEngine(config);

    const route = engine.resolveRouting("cost");

    expect(route.primary).toEqual(DEFAULT_TARGET);
    expect(route.secondary).toBeUndefined();
    expect(route.timeoutMinutes).toBe(60);
    expect(route.timeoutBehavior).toBe("pause");

    // Verify warning was logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No advanced routing config for escalation type "cost"'),
    );

    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test Case 5: Security forces pause timeout (AC 5)
  // -------------------------------------------------------------------------
  test("security escalation forces pause timeout behavior regardless of config", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const config = makeAdvancedConfig({
      security: {
        primary: SECURITY_TARGET,
        timeout_minutes: 10,
        timeout_behavior: "cancel", // Should be overridden to pause
      },
    });
    const engine = new RoutingEngine(config);

    const route = engine.resolveRouting("security");

    expect(route.timeoutBehavior).toBe("pause");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Security escalation timeout behavior forced to "pause"'),
    );

    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test Case 6: Unknown target fallback (AC 4)
  // -------------------------------------------------------------------------
  test("unknown primary target falls back to default_target with warning", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const config = makeAdvancedConfig({
      technical: {
        primary: UNKNOWN_TARGET,
        timeout_minutes: 45,
        timeout_behavior: "retry",
      },
    });

    // Provide known target IDs that do NOT include UNKNOWN_TARGET
    const knownTargetIds = [
      DEFAULT_TARGET.target_id,
      PRODUCT_TARGET.target_id,
      SECURITY_TARGET.target_id,
      SECONDARY_TARGET.target_id,
    ];
    const engine = new RoutingEngine(config, knownTargetIds);

    const route = engine.resolveRouting("technical");

    expect(route.primary).toEqual(DEFAULT_TARGET);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Primary target "unknown-team" is not a known target'),
    );

    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Additional: default mode with no knownTargetIds skips validation
  // -------------------------------------------------------------------------
  test("no knownTargetIds means all targets are assumed valid", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const config = makeAdvancedConfig({
      technical: {
        primary: UNKNOWN_TARGET,
        timeout_minutes: 45,
        timeout_behavior: "retry",
      },
    });

    // No knownTargetIds provided -- skip validation
    const engine = new RoutingEngine(config);

    const route = engine.resolveRouting("technical");

    expect(route.primary).toEqual(UNKNOWN_TARGET);
    // No "unknown target" warning -- only validation skipped
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("is not a known target"),
    );

    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Security invariant is applied even when falling back to default
  // -------------------------------------------------------------------------
  test("security type in default mode still gets pause behavior", () => {
    const config = makeDefaultConfig();
    const engine = new RoutingEngine(config);

    const route = engine.resolveRouting("security");

    expect(route.timeoutBehavior).toBe("pause");
  });

  // -------------------------------------------------------------------------
  // Advanced mode preserves secondary target
  // -------------------------------------------------------------------------
  test("advanced mode route includes secondary target when configured", () => {
    const config = makeAdvancedConfig({
      infrastructure: {
        primary: PRODUCT_TARGET,
        secondary: SECONDARY_TARGET,
        timeout_minutes: 20,
        timeout_behavior: "pause",
      },
    });
    const engine = new RoutingEngine(config);

    const route = engine.resolveRouting("infrastructure");

    expect(route.secondary).toEqual(SECONDARY_TARGET);
  });
});
