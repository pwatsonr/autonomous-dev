/**
 * Unit tests for EmergencyConfigLoader (SPEC-009-4-3, Task 8).
 *
 * Test cases from spec:
 *   13. Valid config loads correctly
 *   14. Invalid kill_default_mode falls back to "graceful"
 *   15. restart_requires_human forced true (with error logged)
 *   16. Missing config uses defaults
 */

import {
  EmergencyConfigLoader,
  type ConfigProvider,
  type ConfigLogger,
  type RawEmergencyConfig,
} from "../emergency-config";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockConfigProvider(
  config?: RawEmergencyConfig,
): ConfigProvider {
  return {
    getEmergencyConfig: jest.fn(() => config),
  };
}

function createMockLogger(): ConfigLogger & {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  return {
    errors,
    warnings,
    error: jest.fn((msg: string) => errors.push(msg)),
    warn: jest.fn((msg: string) => warnings.push(msg)),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EmergencyConfigLoader", () => {
  // -------------------------------------------------------------------------
  // Test 13: Valid config loads correctly
  // -------------------------------------------------------------------------

  it("loads valid config with kill_default_mode 'hard'", () => {
    const provider = createMockConfigProvider({ kill_default_mode: "hard" });
    const logger = createMockLogger();
    const loader = new EmergencyConfigLoader(provider, logger);

    const config = loader.load();

    expect(config.kill_default_mode).toBe("hard");
    expect(config.restart_requires_human).toBe(true);
    expect(logger.errors).toHaveLength(0);
    expect(logger.warnings).toHaveLength(0);
  });

  it("loads valid config with kill_default_mode 'graceful'", () => {
    const provider = createMockConfigProvider({
      kill_default_mode: "graceful",
    });
    const logger = createMockLogger();
    const loader = new EmergencyConfigLoader(provider, logger);

    const config = loader.load();

    expect(config.kill_default_mode).toBe("graceful");
    expect(config.restart_requires_human).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 14: Invalid kill_default_mode falls back to "graceful"
  // -------------------------------------------------------------------------

  it("falls back to 'graceful' when kill_default_mode is invalid", () => {
    const provider = createMockConfigProvider({
      kill_default_mode: "nuclear",
    });
    const logger = createMockLogger();
    const loader = new EmergencyConfigLoader(provider, logger);

    const config = loader.load();

    expect(config.kill_default_mode).toBe("graceful");
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain("nuclear");
    expect(logger.warnings[0]).toContain("Falling back to");
  });

  it("falls back to 'graceful' when kill_default_mode is a number", () => {
    const provider = createMockConfigProvider({
      kill_default_mode: 42,
    });
    const logger = createMockLogger();
    const loader = new EmergencyConfigLoader(provider, logger);

    const config = loader.load();

    expect(config.kill_default_mode).toBe("graceful");
    expect(logger.warnings).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Test 15: restart_requires_human forced true (with error logged)
  // -------------------------------------------------------------------------

  it("forces restart_requires_human to true and logs error when set to false", () => {
    const provider = createMockConfigProvider({
      kill_default_mode: "graceful",
      restart_requires_human: false,
    });
    const logger = createMockLogger();
    const loader = new EmergencyConfigLoader(provider, logger);

    const config = loader.load();

    expect(config.restart_requires_human).toBe(true);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]).toContain("cannot be set to false");
    expect(logger.errors[0]).toContain("immutable safety constraint");
  });

  it("accepts restart_requires_human: true without error", () => {
    const provider = createMockConfigProvider({
      kill_default_mode: "graceful",
      restart_requires_human: true,
    });
    const logger = createMockLogger();
    const loader = new EmergencyConfigLoader(provider, logger);

    const config = loader.load();

    expect(config.restart_requires_human).toBe(true);
    expect(logger.errors).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 16: Missing config uses defaults
  // -------------------------------------------------------------------------

  it("uses default values when config provider returns undefined", () => {
    const provider = createMockConfigProvider(undefined);
    const logger = createMockLogger();
    const loader = new EmergencyConfigLoader(provider, logger);

    const config = loader.load();

    expect(config.kill_default_mode).toBe("graceful");
    expect(config.restart_requires_human).toBe(true);
    expect(logger.errors).toHaveLength(0);
  });

  it("uses default values when config is an empty object", () => {
    const provider = createMockConfigProvider({});
    const logger = createMockLogger();
    const loader = new EmergencyConfigLoader(provider, logger);

    const config = loader.load();

    expect(config.kill_default_mode).toBe("graceful");
    expect(config.restart_requires_human).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Additional: edge cases
  // -------------------------------------------------------------------------

  it("does not warn when kill_default_mode is undefined (missing)", () => {
    const provider = createMockConfigProvider({
      kill_default_mode: undefined,
    });
    const logger = createMockLogger();
    const loader = new EmergencyConfigLoader(provider, logger);

    const config = loader.load();

    expect(config.kill_default_mode).toBe("graceful");
    // No warning for missing -- only for invalid values
    expect(logger.warnings).toHaveLength(0);
  });

  it("does not warn when kill_default_mode is null (missing)", () => {
    const provider = createMockConfigProvider({
      kill_default_mode: null,
    });
    const logger = createMockLogger();
    const loader = new EmergencyConfigLoader(provider, logger);

    const config = loader.load();

    expect(config.kill_default_mode).toBe("graceful");
    expect(logger.warnings).toHaveLength(0);
  });
});
