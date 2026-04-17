/**
 * Unit tests for EscalationConfigLoader (SPEC-009-2-4, Task 7).
 *
 * Tests cover:
 *   9.  Valid config loads correctly
 *   10. Invalid routing mode falls back to "default"
 *   11. Missing default_target throws fatal error
 *   12. Security timeout_behavior forced to "pause"
 *   13. Default verbosity is "standard"
 */

import { EscalationConfigLoader } from "../escalation-config";
import type { ConfigProvider } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(section: Record<string, unknown> | undefined | null): ConfigProvider {
  return {
    getEscalationSection: () => section,
  };
}

function validConfig(): Record<string, unknown> {
  return {
    routing: {
      mode: "advanced",
      default_target: {
        target_id: "default-user",
        display_name: "Default User",
        channel: "slack",
      },
      advanced: {
        security: {
          primary: {
            target_id: "security-team",
            display_name: "Security Team",
            channel: "pagerduty",
          },
          secondary: {
            target_id: "security-manager",
            display_name: "Security Manager",
            channel: "email",
          },
          timeout_minutes: 15,
          timeout_behavior: "pause",
        },
        product: {
          primary: {
            target_id: "product-team",
            display_name: "Product Team",
            channel: "slack",
          },
          timeout_minutes: 120,
          timeout_behavior: "retry",
        },
      },
    },
    verbosity: "verbose",
    retry_budget: 5,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EscalationConfigLoader", () => {
  // =========================================================================
  // Test Case 9: Valid config loads correctly
  // =========================================================================
  test("valid config with all fields parses correctly", () => {
    const loader = new EscalationConfigLoader(makeProvider(validConfig()));
    const config = loader.load();

    expect(config.routing.mode).toBe("advanced");
    expect(config.routing.default_target.target_id).toBe("default-user");
    expect(config.routing.default_target.channel).toBe("slack");
    expect(config.verbosity).toBe("verbose");
    expect(config.retry_budget).toBe(5);

    // Advanced entries
    expect(config.routing.advanced?.security).toBeDefined();
    expect(config.routing.advanced?.security.primary.target_id).toBe("security-team");
    expect(config.routing.advanced?.security.secondary?.target_id).toBe("security-manager");
    expect(config.routing.advanced?.security.timeout_minutes).toBe(15);
    expect(config.routing.advanced?.product).toBeDefined();
    expect(config.routing.advanced?.product.timeout_minutes).toBe(120);
  });

  // =========================================================================
  // Test Case 10: Invalid routing mode falls back to "default"
  // =========================================================================
  test("invalid routing mode falls back to 'default'", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    const cfg = validConfig();
    (cfg.routing as any).mode = "unknown";

    const loader = new EscalationConfigLoader(makeProvider(cfg));
    const config = loader.load();

    expect(config.routing.mode).toBe("default");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid routing.mode"),
    );

    warnSpy.mockRestore();
  });

  // =========================================================================
  // Test Case 11: Missing default_target throws fatal error
  // =========================================================================
  test("missing default_target throws fatal error", () => {
    const cfg = validConfig();
    delete (cfg.routing as any).default_target;

    const loader = new EscalationConfigLoader(makeProvider(cfg));

    expect(() => loader.load()).toThrow(/default_target/);
  });

  test("missing routing section throws fatal error", () => {
    const loader = new EscalationConfigLoader(
      makeProvider({ verbosity: "standard" }),
    );

    expect(() => loader.load()).toThrow(/routing/);
  });

  test("null config section throws fatal error", () => {
    const loader = new EscalationConfigLoader(makeProvider(null));

    expect(() => loader.load()).toThrow(/missing or invalid/);
  });

  test("default_target without target_id throws", () => {
    const cfg = validConfig();
    (cfg.routing as any).default_target = { channel: "slack" };

    const loader = new EscalationConfigLoader(makeProvider(cfg));

    expect(() => loader.load()).toThrow(/target_id/);
  });

  test("default_target without channel throws", () => {
    const cfg = validConfig();
    (cfg.routing as any).default_target = { target_id: "user-1" };

    const loader = new EscalationConfigLoader(makeProvider(cfg));

    expect(() => loader.load()).toThrow(/channel/);
  });

  // =========================================================================
  // Test Case 12: Security timeout_behavior forced to "pause"
  // =========================================================================
  test("security timeout_behavior is forced to 'pause' with warning", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    const cfg = validConfig();
    (cfg.routing as any).advanced.security.timeout_behavior = "cancel";

    const loader = new EscalationConfigLoader(makeProvider(cfg));
    const config = loader.load();

    expect(config.routing.advanced?.security.timeout_behavior).toBe("pause");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("forced to \"pause\""),
    );

    warnSpy.mockRestore();
  });

  test("security timeout_behavior 'retry' is also overridden to 'pause'", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    const cfg = validConfig();
    (cfg.routing as any).advanced.security.timeout_behavior = "retry";

    const loader = new EscalationConfigLoader(makeProvider(cfg));
    const config = loader.load();

    expect(config.routing.advanced?.security.timeout_behavior).toBe("pause");
    warnSpy.mockRestore();
  });

  // =========================================================================
  // Test Case 13: Default verbosity is "standard"
  // =========================================================================
  test("missing verbosity defaults to 'standard'", () => {
    const cfg = validConfig();
    delete cfg.verbosity;

    const loader = new EscalationConfigLoader(makeProvider(cfg));
    const config = loader.load();

    expect(config.verbosity).toBe("standard");
  });

  test("invalid verbosity falls back to 'standard'", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    const cfg = validConfig();
    cfg.verbosity = "debug";

    const loader = new EscalationConfigLoader(makeProvider(cfg));
    const config = loader.load();

    expect(config.verbosity).toBe("standard");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid verbosity"),
    );

    warnSpy.mockRestore();
  });

  // =========================================================================
  // Additional: retry_budget validation
  // =========================================================================
  test("missing retry_budget defaults to 3", () => {
    const cfg = validConfig();
    delete cfg.retry_budget;

    const loader = new EscalationConfigLoader(makeProvider(cfg));
    const config = loader.load();

    expect(config.retry_budget).toBe(3);
  });

  test("invalid retry_budget falls back to 3", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    const cfg = validConfig();
    cfg.retry_budget = -1;

    const loader = new EscalationConfigLoader(makeProvider(cfg));
    const config = loader.load();

    expect(config.retry_budget).toBe(3);
    warnSpy.mockRestore();
  });

  test("zero retry_budget falls back to 3", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    const cfg = validConfig();
    cfg.retry_budget = 0;

    const loader = new EscalationConfigLoader(makeProvider(cfg));
    const config = loader.load();

    expect(config.retry_budget).toBe(3);
    warnSpy.mockRestore();
  });

  // =========================================================================
  // Additional: advanced timeout_minutes validation
  // =========================================================================
  test("invalid timeout_minutes uses default 60", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    const cfg = validConfig();
    (cfg.routing as any).advanced.product.timeout_minutes = -10;

    const loader = new EscalationConfigLoader(makeProvider(cfg));
    const config = loader.load();

    expect(config.routing.advanced?.product.timeout_minutes).toBe(60);
    warnSpy.mockRestore();
  });

  // =========================================================================
  // Additional: default mode does not produce advanced config
  // =========================================================================
  test("default mode does not include advanced config", () => {
    const cfg: Record<string, unknown> = {
      routing: {
        mode: "default",
        default_target: {
          target_id: "user-1",
          display_name: "User 1",
          channel: "slack",
        },
      },
      verbosity: "terse",
      retry_budget: 2,
    };

    const loader = new EscalationConfigLoader(makeProvider(cfg));
    const config = loader.load();

    expect(config.routing.mode).toBe("default");
    expect(config.routing.advanced).toBeUndefined();
  });

  // =========================================================================
  // Additional: display_name defaults to target_id when missing
  // =========================================================================
  test("display_name defaults to target_id when missing", () => {
    const cfg: Record<string, unknown> = {
      routing: {
        mode: "default",
        default_target: {
          target_id: "user-1",
          channel: "slack",
        },
      },
    };

    const loader = new EscalationConfigLoader(makeProvider(cfg));
    const config = loader.load();

    expect(config.routing.default_target.display_name).toBe("user-1");
  });
});
