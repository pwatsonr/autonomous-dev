/**
 * Unit tests for RoutingEngine (SPEC-009-2-3, Task 4).
 *
 * Tests cover:
 *   - Default mode routes all types to default_target
 *   - Advanced mode routes per-type to configured targets
 *   - Missing type in advanced mode falls back to default_target
 *   - Unknown target falls back to default_target
 *   - Security invariant: timeout_behavior forced to "pause"
 */

import { RoutingEngine } from "../routing-engine";
import type { EscalationConfig, EscalationType, RoutingTarget } from "../types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEFAULT_TARGET: RoutingTarget = {
  target_id: "default-user",
  display_name: "Default User",
  channel: "slack",
};

const PRODUCT_TARGET: RoutingTarget = {
  target_id: "product-team",
  display_name: "Product Team",
  channel: "slack",
};

const SECURITY_TARGET: RoutingTarget = {
  target_id: "security-team",
  display_name: "Security Team",
  channel: "pagerduty",
};

const SECONDARY_TARGET: RoutingTarget = {
  target_id: "escalation-manager",
  display_name: "Escalation Manager",
  channel: "email",
};

function makeDefaultConfig(): EscalationConfig {
  return {
    routing: {
      mode: "default",
      default_target: DEFAULT_TARGET,
    },
    verbosity: "standard",
    retry_budget: 3,
  };
}

function makeAdvancedConfig(
  overrides: Partial<EscalationConfig["routing"]["advanced"]> = {},
): EscalationConfig {
  return {
    routing: {
      mode: "advanced",
      default_target: DEFAULT_TARGET,
      advanced: {
        product: {
          primary: PRODUCT_TARGET,
          timeout_minutes: 30,
          timeout_behavior: "pause",
        },
        security: {
          primary: SECURITY_TARGET,
          secondary: SECONDARY_TARGET,
          timeout_minutes: 15,
          timeout_behavior: "cancel", // Should be overridden to "pause"
        },
        ...overrides,
      } as any,
    },
    verbosity: "standard",
    retry_budget: 3,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RoutingEngine", () => {
  // =========================================================================
  // Test Case 1: Default mode routes all to default_target
  // =========================================================================
  test("default mode routes all types to default_target", () => {
    const engine = new RoutingEngine(makeDefaultConfig());

    const types: EscalationType[] = [
      "product",
      "technical",
      "infrastructure",
      "security",
      "cost",
      "quality",
    ];

    for (const type of types) {
      const route = engine.resolveRouting(type);
      expect(route.primary.target_id).toBe("default-user");
      expect(route.timeoutMinutes).toBe(60);
    }
  });

  // =========================================================================
  // Test Case 2: Advanced mode routes product to product target
  // =========================================================================
  test("advanced mode routes product to configured product target", () => {
    const engine = new RoutingEngine(makeAdvancedConfig());
    const route = engine.resolveRouting("product");

    expect(route.primary.target_id).toBe("product-team");
    expect(route.timeoutMinutes).toBe(30);
    expect(route.timeoutBehavior).toBe("pause");
  });

  // =========================================================================
  // Test Case 3: Advanced mode routes security to security target
  // =========================================================================
  test("advanced mode routes security to configured security target", () => {
    const engine = new RoutingEngine(makeAdvancedConfig());
    const route = engine.resolveRouting("security");

    expect(route.primary.target_id).toBe("security-team");
    expect(route.secondary?.target_id).toBe("escalation-manager");
  });

  // =========================================================================
  // Test Case 4: Advanced mode missing type falls back
  // =========================================================================
  test("advanced mode missing type falls back to default_target", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    const engine = new RoutingEngine(makeAdvancedConfig());
    // "cost" is not configured in our advanced config
    const route = engine.resolveRouting("cost");

    expect(route.primary.target_id).toBe("default-user");
    expect(route.timeoutMinutes).toBe(60);
    expect(route.timeoutBehavior).toBe("pause");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("No advanced routing config"),
    );

    warnSpy.mockRestore();
  });

  // =========================================================================
  // Test Case 5: Security forces pause timeout behavior
  // =========================================================================
  test("security escalation forces timeout_behavior to pause", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    const engine = new RoutingEngine(makeAdvancedConfig());
    const route = engine.resolveRouting("security");

    // Config says "cancel" but should be forced to "pause"
    expect(route.timeoutBehavior).toBe("pause");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Security escalation timeout behavior forced"),
    );

    warnSpy.mockRestore();
  });

  // =========================================================================
  // Test Case 6: Unknown target falls back to default
  // =========================================================================
  test("unknown primary target falls back to default_target", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    const config = makeAdvancedConfig({
      technical: {
        primary: {
          target_id: "unknown-team",
          display_name: "Unknown",
          channel: "slack",
        },
        timeout_minutes: 30,
        timeout_behavior: "retry",
      },
    } as any);

    // Pass known target IDs that do NOT include "unknown-team"
    const engine = new RoutingEngine(config, [
      "default-user",
      "product-team",
      "security-team",
      "escalation-manager",
    ]);

    const route = engine.resolveRouting("technical");

    expect(route.primary.target_id).toBe("default-user");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("not a known target"),
    );

    warnSpy.mockRestore();
  });

  // =========================================================================
  // Additional: default mode default timeout and behavior
  // =========================================================================
  test("default mode uses 60 minute timeout and pause behavior", () => {
    const engine = new RoutingEngine(makeDefaultConfig());
    const route = engine.resolveRouting("product");

    expect(route.timeoutMinutes).toBe(60);
    expect(route.timeoutBehavior).toBe("pause");
    expect(route.secondary).toBeUndefined();
  });

  // =========================================================================
  // Additional: security in default mode also forces pause
  // =========================================================================
  test("security in default mode also uses pause behavior", () => {
    const engine = new RoutingEngine(makeDefaultConfig());
    const route = engine.resolveRouting("security");

    expect(route.timeoutBehavior).toBe("pause");
  });
});
